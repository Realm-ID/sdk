/**
 * Verifier: parses a Realm-ID-issued JWT, resolves kid -> public key from the
 * realm's JWKS, validates the RSA signature, and checks issuer/audience/exp.
 *
 * SPEC §5: only JWKS are cached (10 min TTL, unknown-kid forces refetch).
 * Audience can be auto-discovered (realm metadata) when not pinned in config.
 */

import { RealmError, type ErrorCode } from "./errors.js";
import type { Claims } from "./claims.js";
import type { Logger } from "./logger.js";
import { NOOP_LOGGER } from "./logger.js";

export interface VerifierConfig {
  /** Issuer host, no trailing slash. e.g. "https://auth.realmid.dev" */
  baseUrl: string;
  /**
   * Pinned audience. Optional — if omitted, the verifier calls
   * `audienceResolver` lazily on first verify (and caches per realm).
   */
  audience?: string;
  /** Resolver invoked when no audience is pinned. Result is cached. */
  audienceResolver?: (realmId: string) => Promise<string>;
  /** Optional fetch override. Default: globalThis.fetch */
  fetch?: typeof fetch;
  /** JWKS cache TTL in ms. Default 10m. */
  cacheTtlMs?: number;
  /** Clock skew leeway in seconds. Default 30. */
  leewaySeconds?: number;
  /** Clock override for tests. Default () => new Date(). */
  now?: () => Date;
  /** Optional logger. Default no-op. */
  logger?: Logger;
}

export interface VerifyOptions {
  /** Per-call audience override (skips resolver/pinned aud). */
  audience?: string;
}

interface CachedKeys {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

export class Verifier {
  private readonly baseUrl: string;
  private readonly audiencePinned?: string;
  private readonly resolver?: (realmId: string) => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly cacheTtlMs: number;
  private readonly leewaySeconds: number;
  private readonly now: () => Date;
  private readonly cache = new Map<string, CachedKeys>();
  private readonly audCache = new Map<string, string>();
  private readonly logger: Logger;

  constructor(cfg: VerifierConfig) {
    if (!cfg.baseUrl) throw new Error("realmid: baseUrl required");
    if (!cfg.audience && !cfg.audienceResolver) {
      throw new Error("realmid: audience or audienceResolver required");
    }
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.audiencePinned = cfg.audience;
    this.resolver = cfg.audienceResolver;
    this.fetchImpl = cfg.fetch ?? globalThis.fetch.bind(globalThis);
    this.cacheTtlMs = cfg.cacheTtlMs ?? 10 * 60 * 1000;
    this.leewaySeconds = cfg.leewaySeconds ?? 30;
    this.now = cfg.now ?? (() => new Date());
    this.logger = cfg.logger ?? NOOP_LOGGER;
  }

  async verify(token: string, opts?: VerifyOptions): Promise<Claims> {
    try {
      return await this.verifyInner(token, opts);
    } catch (e) {
      if (e instanceof RealmError) {
        this.logger.error("realmid: verify failed", { code: e.code, message: e.message });
      }
      throw e;
    }
  }

  private async verifyInner(token: string, opts?: VerifyOptions): Promise<Claims> {
    const { header, claims, signedInput, signature } = parseToken(token);

    if (header.alg !== "RS256") {
      throw rerr("wrong_algorithm", `unexpected alg: ${header.alg}`);
    }
    if (typeof claims.iss !== "string") {
      throw rerr("malformed", "iss missing");
    }

    const realmId = extractRealmId(claims.iss);
    const key = await this.resolveKey(realmId, header.kid);

    const ok = await globalThis.crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      signature as BufferSource,
      signedInput as BufferSource,
    );
    if (!ok) throw rerr("bad_signature", "signature invalid");

    const issuerPrefix = this.baseUrl + "/";
    if (!claims.iss.startsWith(issuerPrefix)) {
      throw rerr("wrong_issuer", `iss mismatch: ${claims.iss}`);
    }

    const expectedAud = await this.expectedAudience(realmId, opts?.audience);
    if (claims.aud !== expectedAud) {
      throw rerr("wrong_audience", `aud mismatch: ${claims.aud}`);
    }

    const now = Math.floor(this.now().getTime() / 1000);
    const leeway = this.leewaySeconds;
    if (typeof claims.exp === "number" && now - leeway >= claims.exp) {
      throw rerr("expired", "token expired");
    }
    if (typeof claims.nbf === "number" && now + leeway < claims.nbf) {
      throw rerr("not_yet_valid", "token not yet valid");
    }

    return claims as Claims;
  }

  private async expectedAudience(realmId: string, override?: string): Promise<string> {
    if (override) return override;
    if (this.audiencePinned) return this.audiencePinned;
    const cached = this.audCache.get(realmId);
    if (cached) return cached;
    if (!this.resolver) {
      throw rerr("wrong_audience", "no audience configured and no resolver");
    }
    const aud = await this.resolver(realmId);
    this.audCache.set(realmId, aud);
    return aud;
  }

  private async resolveKey(realmId: string, kid: string): Promise<CryptoKey> {
    const cached = this.cache.get(realmId);
    const now = this.now().getTime();
    if (cached && cached.keys.has(kid) && now - cached.fetchedAt < this.cacheTtlMs) {
      return cached.keys.get(kid)!;
    }

    const keys = await this.fetchJwks(realmId);
    this.cache.set(realmId, { keys, fetchedAt: now });
    const key = keys.get(kid);
    if (!key) throw rerr("unknown_kid", `kid ${kid} not in JWKS`);
    return key;
  }

  private async fetchJwks(realmId: string): Promise<Map<string, CryptoKey>> {
    const url = `${this.baseUrl}/${realmId}/.well-known/jwks.json`;
    let resp: Response;
    try {
      resp = await this.fetchImpl(url);
    } catch (e) {
      throw new RealmError({
        code: "jwks_fetch_failed",
        message: `jwks fetch network error: ${(e as Error).message}`,
        cause: e,
      });
    }
    if (!resp.ok) {
      throw rerr("jwks_fetch_failed", `jwks fetch returned ${resp.status}`);
    }
    const doc = (await resp.json()) as { keys: JWK[] };
    const out = new Map<string, CryptoKey>();
    for (const jwk of doc.keys ?? []) {
      if (jwk.kty !== "RSA") continue;
      const key = await globalThis.crypto.subtle.importKey(
        "jwk",
        { ...jwk, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      out.set(jwk.kid, key);
    }
    return out;
  }
}

/** Convenience factory mirroring the Go SDK's `NewVerifier`. */
export function createVerifier(cfg: VerifierConfig): Verifier {
  return new Verifier(cfg);
}

// ---- helpers ----

function rerr(code: ErrorCode, message: string): RealmError {
  return new RealmError({ code, message });
}

interface JWK {
  kty: string;
  use?: string;
  alg?: string;
  kid: string;
  n: string;
  e: string;
}

interface Header {
  alg: string;
  typ?: string;
  kid: string;
}

function parseToken(token: string) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw rerr("malformed", "expected 3 dot-separated parts");
  }
  const [h, p, s] = parts as [string, string, string];

  let header: Header;
  let claims: Record<string, unknown>;
  let signature: Uint8Array;
  try {
    header = JSON.parse(decodeUtf8(b64urlDecode(h))) as Header;
    claims = JSON.parse(decodeUtf8(b64urlDecode(p))) as Record<string, unknown>;
    signature = b64urlDecode(s);
  } catch (e) {
    throw rerr("malformed", `could not parse: ${(e as Error).message}`);
  }

  if (!header.kid) {
    throw rerr("malformed", "kid missing from header");
  }

  const signedInput = new TextEncoder().encode(`${h}.${p}`);
  return { header, claims, signedInput, signature };
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function extractRealmId(iss: string): string {
  const idx = iss.lastIndexOf("/");
  if (idx < 0 || idx === iss.length - 1) {
    throw rerr("wrong_issuer", "iss has no realm segment");
  }
  return iss.slice(idx + 1);
}
