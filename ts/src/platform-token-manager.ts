/**
 * Two-endpoint auth surface — ADR-051.
 *
 * The SDK's platform identity holds a refresh + access token pair. The
 * raw API key only travels on the initial `POST /auth/login` call with
 * `grant_type: "platform_api_key"`. After that, expiring access tokens
 * are refreshed against `POST /auth/token` with the refresh token as
 * the bearer.
 *
 * Whether the refresh token rotates is server-side, gated by the
 * realm's `platform_refresh_rotates` config (default off; the response
 * just returns the same refresh we sent). If `/auth/token` 401s
 * (refresh revoked / rotated by another caller) we fall back to a
 * fresh `/auth/login`.
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
  refresh_token?: string;
  access_token?: string;
  expires_in?: number;
}

interface CachedSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

const DEFAULT_REFRESH_SKEW_MS = 30_000;

export class PlatformTokenManager {
  private cached?: CachedSession;
  private inflight?: Promise<CachedSession>;

  constructor(private readonly opts: PlatformTokenManagerOptions) {}

  /**
   * Force-clear the cached access token (used by tests + on 401
   * responses). The refresh token is preserved so the next getToken()
   * can attempt `/auth/token` before a full re-login.
   */
  invalidate(): void {
    if (this.cached) {
      // Drop only the access token; keep the refresh so the next
      // getToken() tries /auth/token before re-logging in.
      this.cached = { ...this.cached, accessToken: "", expiresAt: 0 };
    }
    this.inflight = undefined;
  }

  /**
   * Returns a fresh-enough access token, minting one if no session is
   * cached or the cached access token is within `refreshSkewMs` of its
   * expiry. Falls back to a full login if `/auth/token` rejects the
   * refresh.
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

  /**
   * acquire picks the cheapest path: refresh via /auth/token if we
   * have a refresh token, else /auth/login from scratch. On a 401
   * during refresh we transparently fall back to login.
   */
  private async acquire(): Promise<CachedSession> {
    const refresh = this.cached?.refreshToken;
    if (refresh) {
      try {
        return await this.refreshAccess(refresh);
      } catch (e) {
        if (e instanceof RealmError && e.code === "unauthorized") {
          this.opts.logger.info(
            "realmid: refresh rejected, re-logging in",
            {},
          );
          // Fall through to login.
        } else {
          throw e;
        }
      }
    }
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
    if (!wire.access_token || !wire.refresh_token) {
      throw new RealmError({
        code: "server_error",
        message: "/auth/login returned empty access_token or refresh_token",
      });
    }
    this.checkIssuer(wire.access_token);
    const expiresAt = this.now() + (wire.expires_in ?? 300) * 1000;
    this.opts.logger.info("realmid: platform session minted", {
      accessToken: redactCredential(wire.access_token),
      expiresInSec: wire.expires_in,
    });
    return {
      accessToken: wire.access_token,
      refreshToken: wire.refresh_token,
      expiresAt,
    };
  }

  private async refreshAccess(refresh: string): Promise<CachedSession> {
    const url = this.opts.baseUrl.replace(/\/+$/, "") + "/auth/token";
    this.opts.logger.debug("realmid: refreshing platform access", {});
    const wire = await this.postJSON(url, JSON.stringify({}), refresh);
    if (!wire.access_token) {
      throw new RealmError({
        code: "server_error",
        message: "/auth/token returned empty access_token",
      });
    }
    this.checkIssuer(wire.access_token);
    const expiresAt = this.now() + (wire.expires_in ?? 300) * 1000;
    return {
      accessToken: wire.access_token,
      // Non-rotating realms return the same refresh; rotating realms
      // return a new one. Either way, store what the server gave us
      // (or fall back to the one we sent).
      refreshToken: wire.refresh_token || refresh,
      expiresAt,
    };
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
