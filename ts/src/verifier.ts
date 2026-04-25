/**
 * Verifier: parses, resolves kid -> public key, verifies signature and claims.
 */

export interface Config {
  /** e.g. "https://auth.realmid.dev" — no trailing slash */
  baseUrl: string;
  /** Expected aud value, e.g. "example.com" */
  audience: string;
  /** Optional fetch override. Default: globalThis.fetch */
  fetch?: typeof fetch;
  /** JWKS cache TTL in ms. Default 10m. */
  cacheTtlMs?: number;
  /** Clock skew leeway in seconds. Default 30. */
  leewaySeconds?: number;
  /** Clock override for tests. Default () => new Date(). */
  now?: () => Date;
}

export interface Claims {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  nbf?: number;
  jti?: string;
  azp?: string;
  tenant_id?: string;
  role?: string;
  [k: string]: unknown;
}

export type VerifyErrorCode =
  | "malformed"
  | "wrong_algorithm"
  | "bad_signature"
  | "wrong_issuer"
  | "wrong_audience"
  | "expired"
  | "not_yet_valid"
  | "unknown_kid"
  | "jwks_fetch_failed";

export class VerifyError extends Error {
  code: VerifyErrorCode;
  constructor(code: VerifyErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "VerifyError";
  }
}

interface CachedKeys {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

export class Verifier {
  private readonly cfg: Required<Omit<Config, "fetch" | "now">> & {
    fetch: typeof fetch;
    now: () => Date;
  };
  private readonly cache = new Map<string, CachedKeys>();

  constructor(cfg: Config) {
    if (!cfg.baseUrl) throw new Error("realmid: baseUrl required");
    if (!cfg.audience) throw new Error("realmid: audience required");
    this.cfg = {
      baseUrl: cfg.baseUrl.replace(/\/+$/, ""),
      audience: cfg.audience,
      fetch: cfg.fetch ?? globalThis.fetch,
      cacheTtlMs: cfg.cacheTtlMs ?? 10 * 60 * 1000,
      leewaySeconds: cfg.leewaySeconds ?? 30,
      now: cfg.now ?? (() => new Date()),
    };
  }

  async verify(token: string): Promise<Claims> {
    const { header, claims, signedInput, signature } = parseToken(token);

    if (header.alg !== "RS256") {
      throw new VerifyError("wrong_algorithm", `unexpected alg: ${header.alg}`);
    }
    if (typeof claims.iss !== "string") {
      throw new VerifyError("malformed", "iss missing");
    }

    const realmId = extractRealmId(claims.iss);
    const key = await this.resolveKey(realmId, header.kid);

    const ok = await globalThis.crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      signature as BufferSource,
      signedInput as BufferSource,
    );
    if (!ok) throw new VerifyError("bad_signature", "signature invalid");

    const issuerPrefix = this.cfg.baseUrl + "/";
    if (!claims.iss.startsWith(issuerPrefix)) {
      throw new VerifyError("wrong_issuer", `iss mismatch: ${claims.iss}`);
    }
    if (claims.aud !== this.cfg.audience) {
      throw new VerifyError("wrong_audience", `aud mismatch: ${claims.aud}`);
    }

    const now = Math.floor(this.cfg.now().getTime() / 1000);
    const leeway = this.cfg.leewaySeconds;
    if (typeof claims.exp === "number" && now - leeway >= claims.exp) {
      throw new VerifyError("expired", "token expired");
    }
    if (typeof claims.nbf === "number" && now + leeway < claims.nbf) {
      throw new VerifyError("not_yet_valid", "token not yet valid");
    }

    return claims as Claims;
  }

  private async resolveKey(realmId: string, kid: string): Promise<CryptoKey> {
    const cached = this.cache.get(realmId);
    const now = this.cfg.now().getTime();
    if (cached && cached.keys.has(kid) && now - cached.fetchedAt < this.cfg.cacheTtlMs) {
      return cached.keys.get(kid)!;
    }

    const keys = await this.fetchJwks(realmId);
    this.cache.set(realmId, { keys, fetchedAt: now });
    const key = keys.get(kid);
    if (!key) throw new VerifyError("unknown_kid", `kid ${kid} not in JWKS`);
    return key;
  }

  private async fetchJwks(realmId: string): Promise<Map<string, CryptoKey>> {
    const url = `${this.cfg.baseUrl}/${realmId}/.well-known/jwks.json`;
    const resp = await this.cfg.fetch(url);
    if (!resp.ok) {
      throw new VerifyError(
        "jwks_fetch_failed",
        `jwks fetch returned ${resp.status}`,
      );
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

/** Convenience factory that mirrors the Go SDK's `NewVerifier`. */
export function createVerifier(cfg: Config): Verifier {
  return new Verifier(cfg);
}

// ---- helpers ----

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
    throw new VerifyError("malformed", "expected 3 dot-separated parts");
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
    throw new VerifyError("malformed", `could not parse: ${(e as Error).message}`);
  }

  if (!header.kid) {
    throw new VerifyError("malformed", "kid missing from header");
  }

  const signedInput = new TextEncoder().encode(`${h}.${p}`);
  return { header, claims, signedInput, signature };
}

function b64urlDecode(s: string): Uint8Array {
  // base64url -> base64
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
    throw new VerifyError("wrong_issuer", "iss has no realm segment");
  }
  return iss.slice(idx + 1);
}
