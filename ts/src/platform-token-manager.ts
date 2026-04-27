/**
 * Dual-token login machinery — SPEC §4.0.
 *
 * Holds a short-lived platform token minted from the realm's API key and
 * hands it to the HTTP client for every management call (and for
 * `auth.login`). The raw API key only travels on `POST /auth/platform-token`.
 *
 * The cached token is re-minted automatically when fewer than 30 seconds
 * remain on its lifetime.
 */

import { RealmError } from "./errors.js";
import type { Logger } from "./logger.js";
import { redactCredential } from "./logger.js";

export interface PlatformTokenManagerOptions {
  apiKey: string;
  baseUrl: string;
  /**
   * Configured realm id. When set, the minted platform token's `iss`
   * claim is cross-checked against this on every refresh — mismatch
   * throws `realm_mismatch` locally before any subsequent API call
   * (ADR-041). Optional only for backwards compatibility with callers
   * that haven't been updated; createRealm always sets it.
   */
  realmId?: string;
  fetch: typeof fetch;
  logger: Logger;
  /** Override clock for tests. Returns ms since epoch. */
  now?: () => number;
  /** Refresh-skew in ms. Default 30s. */
  refreshSkewMs?: number;
}

interface PlatformTokenWire {
  platform_token: string;
  expires_in: number;
  realm_id?: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const DEFAULT_REFRESH_SKEW_MS = 30_000;

export class PlatformTokenManager {
  private cached?: CachedToken;
  private inflight?: Promise<CachedToken>;

  constructor(private readonly opts: PlatformTokenManagerOptions) {}

  /** Force-clear the cache (used by tests + on 401 responses). */
  invalidate(): void {
    this.cached = undefined;
    this.inflight = undefined;
  }

  /**
   * Returns a fresh-enough platform token, minting one if no token is
   * cached or the cached token is within `refreshSkewMs` of its expiry.
   */
  async getToken(): Promise<string> {
    const now = this.now();
    const skew = this.opts.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
    if (this.cached && this.cached.expiresAt - now > skew) {
      return this.cached.token;
    }
    if (this.inflight) {
      const t = await this.inflight;
      return t.token;
    }
    this.inflight = this.mint();
    try {
      this.cached = await this.inflight;
      return this.cached.token;
    } finally {
      this.inflight = undefined;
    }
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private async mint(): Promise<CachedToken> {
    const url = this.opts.baseUrl.replace(/\/+$/, "") + "/auth/platform-token";
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "accept": "application/json",
      "authorization": `Bearer ${this.opts.apiKey}`,
    };
    this.opts.logger.info("realmid: minting platform token", {
      apiKey: redactCredential(this.opts.apiKey),
    });
    let resp: Response;
    try {
      resp = await this.opts.fetch(url, { method: "POST", headers });
    } catch (e) {
      this.opts.logger.error("realmid: platform-token network error", {
        message: (e as Error).message,
      });
      throw new RealmError({
        code: "network",
        message: `network error minting platform token: ${(e as Error).message}`,
        cause: e,
      });
    }
    const text = await resp.text();
    let body: unknown;
    if (text.length > 0) {
      try { body = JSON.parse(text); } catch { body = text; }
    }
    if (!resp.ok) {
      const code = resp.status === 401 || resp.status === 403
        ? "unauthorized"
        : (resp.status >= 500 ? "server_error" : "bad_request");
      let message = `platform-token mint failed with HTTP ${resp.status}`;
      if (body && typeof body === "object") {
        const env = (body as Record<string, unknown>)["error"];
        if (env && typeof env === "object") {
          const m = (env as Record<string, unknown>)["message"];
          if (typeof m === "string" && m) message = m;
        }
      }
      this.opts.logger.error("realmid: platform-token mint failed", {
        status: resp.status,
      });
      throw new RealmError({ code, message, httpStatus: resp.status });
    }
    if (!body || typeof body !== "object") {
      throw new RealmError({
        code: "server_error",
        message: "platform-token response was not JSON",
      });
    }
    const w = body as Partial<PlatformTokenWire>;
    if (typeof w.platform_token !== "string" || typeof w.expires_in !== "number") {
      throw new RealmError({
        code: "server_error",
        message: "platform-token response missing platform_token or expires_in",
      });
    }
    // ADR-041: client-side realm pinning. Decode the JWT (no signature
    // check — we just got it from RI over TLS) and confirm its iss claim
    // references the configured realm. Catches confused-deputy bugs where
    // the SDK was constructed for realm A but the API key actually
    // belongs to realm B; surfaces as a clear local error instead of a
    // cryptic 4xx on the next partner-level call.
    if (this.opts.realmId) {
      const iss = peekJwtIssuer(w.platform_token);
      if (iss && !iss.endsWith("/" + this.opts.realmId)) {
        throw new RealmError({
          code: "realm_mismatch",
          message:
            "platform token iss does not match configured realm: got " +
            iss +
            ", configured realm " +
            this.opts.realmId,
        });
      }
    }
    const expiresAt = this.now() + w.expires_in * 1000;
    this.opts.logger.info("realmid: platform token minted", {
      token: redactCredential(w.platform_token),
      expiresInSec: w.expires_in,
    });
    return { token: w.platform_token, expiresAt };
  }
}

/** Decode a JWT payload without signature verification and return its
 *  `iss` claim. Returns "" on malformed input. Used by the realm-pinning
 *  check; signature verification stays the verifier's job. */
function peekJwtIssuer(jwt: string): string {
  const parts = jwt.split(".");
  if (parts.length !== 3) return "";
  const payload = parts[1];
  if (payload === undefined) return "";
  try {
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const c = JSON.parse(json) as { iss?: unknown };
    return typeof c.iss === "string" ? c.iss : "";
  } catch {
    return "";
  }
}
