/**
 * Two-endpoint auth surface — ADR-051, as amended by ADR-089.
 *
 * The SDK's platform identity holds an ACCESS TOKEN ONLY. Every
 * acquisition is a `POST /auth/login` with the bootstrap credential
 * (`grant_type: "platform_api_key"` or the token exchange); when the
 * cached token comes within `refreshSkewMs` of expiry, we simply do it
 * again.
 *
 * There is no refresh step. ADR-089 (issuer v0.68.0) withdrew the refresh
 * token from every credential-bootstrapped session: the caller is holding
 * the credential at the moment it needs a token, so a refresh token was a
 * strictly weaker duplicate of one it already had — and one that outlived
 * revocation of its source. Re-minting costs the same single round trip.
 *
 * NOTE for anyone reviving a refresh path: requiring `refresh_token` in the
 * login response is what made the pre-ADR-089 client fail HARD (not degrade)
 * against a v0.68.0 issuer, on the very first call.
 *
 * The class keeps the `PlatformTokenManager` name + `getToken()`
 * surface so every existing call site (`http.ts`, `origins.ts`, ...)
 * keeps working.
 */
import { RealmError } from "./errors.js";
import type { Logger } from "./logger.js";
import { redactCredential } from "./logger.js";
import type { CredentialSource } from "./credential.js";
import {
  GRANT_PLATFORM_API_KEY,
  GRANT_TOKEN_EXCHANGE,
  SUBJECT_TOKEN_TYPE_JWT,
} from "./credential.js";

export interface PlatformTokenManagerOptions {
  /** Bootstrap credential source (ADR-057). Static API key or workload OIDC. */
  credential: CredentialSource;
  baseUrl: string;
  /**
   * Configured realm id. When set, the minted access token's `iss`
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

interface LoginWire {
  status?: string;
  subject_type?: string;
  access_token?: string;
  expires_in?: number;
  // No refresh_token: ADR-089 stopped issuing one for this grant.
}

interface CachedSession {
  accessToken: string;
  expiresAt: number;
}

const DEFAULT_REFRESH_SKEW_MS = 30_000;

export class PlatformTokenManager {
  private cached?: CachedSession;
  private inflight?: Promise<CachedSession>;

  constructor(private readonly opts: PlatformTokenManagerOptions) {}

  /**
   * Force-clear the cached access token (used by tests + on 401
   * responses). The next getToken() re-mints from the credential.
   */
  invalidate(): void {
    this.cached = undefined;
    this.inflight = undefined;
  }

  /**
   * Returns a fresh-enough access token, minting one if no session is
   * cached or the cached access token is within `refreshSkewMs` of its
   * expiry.
   */
  async getToken(): Promise<string> {
    const now = this.now();
    const skew = this.opts.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
    if (
      this.cached &&
      this.cached.accessToken &&
      this.cached.expiresAt - now > skew
    ) {
      return this.cached.accessToken;
    }
    if (this.inflight) {
      const t = await this.inflight;
      return t.accessToken;
    }
    this.inflight = this.acquire();
    try {
      this.cached = await this.inflight;
      return this.cached.accessToken;
    } finally {
      this.inflight = undefined;
    }
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** acquire mints a session from the bootstrap credential. */
  private async acquire(): Promise<CachedSession> {
    return this.login();
  }

  private async login(): Promise<CachedSession> {
    const url = this.opts.baseUrl.replace(/\/+$/, "") + "/auth/login";
    const cred = await this.opts.credential.fetch();
    const payload: Record<string, string> = { grant_type: cred.grantType };
    let redacted = "";
    if (cred.grantType === GRANT_PLATFORM_API_KEY) {
      if (!cred.apiKey) {
        throw new RealmError({
          code: "unauthorized",
          message: "credential source returned an empty API key",
        });
      }
      payload["api_key"] = cred.apiKey;
      redacted = redactCredential(cred.apiKey);
    } else if (cred.grantType === GRANT_TOKEN_EXCHANGE) {
      if (!cred.subjectToken) {
        throw new RealmError({
          code: "unauthorized",
          message: "credential source returned an empty workload token",
        });
      }
      payload["subject_token"] = cred.subjectToken;
      payload["subject_token_type"] = SUBJECT_TOKEN_TYPE_JWT;
      redacted = redactCredential(cred.subjectToken);
    } else {
      throw new RealmError({
        code: "bad_request",
        message: "unsupported credential grant_type: " + cred.grantType,
      });
    }
    this.opts.logger.info("realmid: platform login (credential → session)", {
      grantType: cred.grantType,
      credential: redacted,
    });
    const wire = await this.postJSON(url, JSON.stringify(payload), undefined);
    // ADR-089: a platform login returns NO refresh_token. Do not require one.
    if (!wire.access_token) {
      throw new RealmError({
        code: "server_error",
        message: "/auth/login returned an empty access_token",
      });
    }
    this.checkIssuer(wire.access_token);
    const expiresAt = this.now() + (wire.expires_in ?? 300) * 1000;
    this.opts.logger.info("realmid: platform session minted", {
      accessToken: redactCredential(wire.access_token),
      expiresInSec: wire.expires_in,
    });
    return { accessToken: wire.access_token, expiresAt };
  }

  private async postJSON(
    url: string,
    body: string,
    bearer: string | undefined,
  ): Promise<LoginWire> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "accept": "application/json",
    };
    if (bearer) headers["authorization"] = `Bearer ${bearer}`;
    let resp: Response;
    try {
      resp = await this.opts.fetch(url, { method: "POST", headers, body });
    } catch (e) {
      this.opts.logger.error("realmid: auth network error", {
        url,
        message: (e as Error).message,
      });
      throw new RealmError({
        code: "network",
        message: `network error calling ${url}: ${(e as Error).message}`,
        cause: e,
      });
    }
    const text = await resp.text();
    let parsed: unknown;
    if (text.length > 0) {
      try { parsed = JSON.parse(text); } catch { parsed = text; }
    }
    if (!resp.ok) {
      const code = resp.status === 401 || resp.status === 403
        ? "unauthorized"
        : (resp.status >= 500 ? "server_error" : "bad_request");
      let message = `auth call to ${url} failed with HTTP ${resp.status}`;
      if (parsed && typeof parsed === "object") {
        const env = (parsed as Record<string, unknown>)["error"];
        if (env && typeof env === "object") {
          const m = (env as Record<string, unknown>)["message"];
          if (typeof m === "string" && m) message = m;
        }
      }
      this.opts.logger.error("realmid: auth call failed", { status: resp.status });
      throw new RealmError({ code, message, httpStatus: resp.status });
    }
    if (!parsed || typeof parsed !== "object") {
      throw new RealmError({
        code: "server_error",
        message: `${url} response was not JSON`,
      });
    }
    return parsed as LoginWire;
  }

  /**
   * ADR-041 client-side realm pin: decode the access token (no
   * signature check) and confirm its iss claim references the
   * configured realm. Catches confused-deputy bugs where the SDK was
   * constructed for realm A but the API key actually belongs to realm
   * B; surfaces as a clear local error instead of a cryptic 4xx on
   * the next partner-level call.
   */
  private checkIssuer(jwt: string): void {
    if (!this.opts.realmId) return;
    const iss = peekJwtIssuer(jwt);
    if (iss && !iss.endsWith("/" + this.opts.realmId)) {
      throw new RealmError({
        code: "realm_mismatch",
        message:
          "platform access token iss does not match configured realm: got " +
          iss +
          ", configured realm " +
          this.opts.realmId,
      });
    }
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
