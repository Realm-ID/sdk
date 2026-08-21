/**
 * Authentication surface — `realm.auth.*` per SPEC §4.
 * Maps directly onto POST /auth/{login,token,mfa/verify,mfa/challenge,logout}
 * and the /auth/sessions management endpoints.
 *
 * Authorization on every call is the short-lived platform token — the raw
 * API key never travels on login traffic (SPEC §4.0). The HttpClient
 * injects that automatically; this module does not have to think about it.
 *
 * Origin auto-attach (SPEC §8): every auth call (login, logout, token,
 * mfa/verify, mfa/challenge) carries an `Origin` header. The value is
 * derived in priority order: per-call `origin` arg → handle-level
 * `createRealm({ origin })` → `realm.info().audience` (prefixed
 * `https://`). Callers never need to set it manually.
 */

import type { HttpClient } from "./http.js";
import { RealmError } from "./errors.js";
import { TokenManager, type TokenManagerOptions } from "./token-manager.js";

export type LoginMethod = "firebase" | "google";

export interface LoginRequest {
  method: LoginMethod;
  providerToken: string;
  /** Optional Origin header override (server resolves realm by host if set). */
  origin?: string;
  /**
   * ADR-062 — human-readable label for the device this login happens on (a CLI
   * hostname, a browser name). Travels as the `X-Device-Name` header, never in
   * the body, and the issuer persists it on the created session so a user can
   * tell their sessions apart when revoking one (`listSessions` →
   * {@link SessionInfo.device_name}). The server strips control characters and
   * caps it at 120 chars, so nothing is sanitized client-side.
   */
  deviceName?: string;
  // NOTE: customClaims intentionally NOT accepted here. Per SPEC §4.1 the
  // refresh token carries identity only; access-token claims are minted via
  // `auth.token({ customClaims })`.
}

export interface TenantRef {
  id: string;
  role: string;
  displayName?: string;
}

export interface UserSummary {
  id: string;
  email?: string;
  displayName?: string;
  [k: string]: unknown;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  /**
   * SPEC §4.1 — absolute wall-clock expiry (unix seconds) of the returned
   * refresh token, past which it can no longer be rotated (min of the rolling
   * TTL, the ADR-054 scheduled cutoff, and the ADR-058 absolute session cap).
   * `undefined` when the issuer does not surface it (pre-refresh_exp issuers);
   * callers that size a session from it must fall back to their own ceiling.
   */
  refreshExp?: number;
  /**
   * ADR-070 — sliding-window idle-timeout duration (seconds). Each
   * authenticated use slides the window forward by this many seconds; the
   * session dies if idle past it. `undefined`/`0` means no idle timeout —
   * callers must treat it as "disabled", not "expire now".
   */
  idleTtl?: number;
  expiresAt?: string;
  /**
   * ADR-071 §8 — the owner/admin who minted the login OTP that produced this
   * service-account session (attribution/provenance). `undefined` for
   * human/provider logins and M2M sessions. Decoded from the issuer's
   * `initiated_by_user_id`.
   */
  initiatedByUserId?: string;
  user: UserSummary;
  tenants: TenantRef[];
  /**
   * ADR-092 D5 — the caller holds more than one ACTIVE membership in a realm
   * that requires single-tenant membership and must give the extras up. The
   * login SUCCEEDED (an access token and a refresh token are present), so this
   * is a reconciliation prompt, not an auth failure: refusing the login would
   * strand exactly the users the drain exists to resolve. Settle it with
   * `realm.me.chooseTenant({ tenantId })`. `undefined` on every realm with the
   * knob off, which is every realm until a partner turns it on.
   */
  tenantChoiceRequired?: boolean;
  /** The memberships the D5 picker may choose between. */
  tenantChoices?: TenantChoice[];
}

/** One option in the ADR-092 D5 single-tenant picker. */
export interface TenantChoice {
  tenantId: string;
  displayName: string;
  /**
   * Marks a membership that CANNOT be given up: releasing it would leave the
   * tenant ownerless and `tenants.owner_user_id` is NOT NULL. Do not offer it
   * — the server refuses it regardless — the way out is an ADR-076 ownership
   * transfer first.
   */
  isOwner: boolean;
}

export interface TokenRequest {
  refreshToken: string;
  tenantId: string;
  /**
   * v0.1.0 — custom claims merged into the minted **access token**,
   * subject to a per-realm server-side allowlist. Use this for app-state
   * fields (e.g. `outlet_ids`) that downstream services need to authorize
   * without a database lookup. The SDK is a pass-through; allowlist
   * enforcement is the server's responsibility.
   */
  customClaims?: Record<string, unknown>;
  /** Optional Origin header override. */
  origin?: string;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  /** SPEC §4.1 — absolute refresh-token expiry (unix seconds); see LoginResponse.refreshExp. */
  refreshExp?: number;
  /** ADR-070 — sliding-window idle-timeout duration (seconds); see LoginResponse.idleTtl. */
  idleTtl?: number;
  /**
   * Minted token's subject class (SPEC §4.2): "user" | "service" |
   * "platform" (ADR-051). The issuer returns it on /auth/token for every
   * refresh class; `tenantId` and `role` are populated only when
   * `subjectType === "user"`.
   */
  subjectType: string;
  tenantId: string;
  role: string;
}

export interface MfaVerifyRequest {
  challengeToken: string;
  code: string;
  /** Defaults to "totp". */
  method?: string;
  /** Optional Origin header override. */
  origin?: string;
}

export interface LogoutRequest {
  refreshToken?: string;
  /**
   * When set AND a RevocationCache is configured on the Realm, the
   * access token's `jti` is added to the cache on successful logout —
   * bridging the gap between user logout and the access token's
   * stateless natural expiry per ADR-041 follow-up. The server-side
   * refresh revocation is independent and always happens.
   */
  accessToken?: string;
  /** Optional Origin header override. */
  origin?: string;
}

export interface MfaChallengeMintRequest {
  /** The user's current access token. */
  accessToken: string;
}

export interface MfaChallengeMintResponse {
  mfaChallengeToken: string;
  methods: string[];
}

/**
 * One entry in {@link AuthClient.listSessions}. Fields mirror the issuer's
 * `sessionDTO` wire shape (`issuer/internal/httpapi/sessions.go`) verbatim —
 * `listSessions` returns the parsed server JSON without snake→camel mapping,
 * so these must be the on-the-wire names. Timestamps are unix seconds (JSON
 * numbers). NOTE: the last-used timestamp is `last_seen_at`, NOT
 * `last_used_at` — the old camelCase `lastUsedAt`/`createdAt` fields never
 * populated at runtime.
 */
/** The `GET /auth/sessions` envelope: the issuer's locked paged shape, plus the
 *  legacy flat `sessions` array some mocks still emit. */
/**
 * Removes the characters an HTTP header field value cannot carry (C0 controls
 * and DEL). NOT a policy check: the issuer's `sanitizeDeviceName` strips the
 * same class and additionally caps the value at 120 characters, and the cap
 * stays THERE — a client-side copy of a server policy drifts the day either
 * side changes.
 *
 * This exists because the transport refuses the value outright: undici throws
 * `Headers.append: "..." is an invalid header value` and Go's http client
 * returns `invalid header field value`, so a label with a newline in it did not
 * arrive sanitized — the whole login failed, with an error naming the network
 * rather than the argument. Stripping here produces exactly the value the
 * server would have stored.
 */
export function headerSafeDeviceName(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

export interface SessionListWire {
  items?: SessionInfo[];
  sessions?: SessionInfo[];
  next_cursor?: string | null;
  total?: number;
}

export interface SessionInfo {
  id: string;
  origin?: string;
  device_name?: string;
  created_at?: number;
  last_seen_at?: number;
  [k: string]: unknown;
}

/**
 * Self-service MFA enroll request (ADR-061). Refresh-authed: `refreshToken`
 * is the handle to the user's login session — the only credential a
 * first-login user has, since the MFA gate withholds the access token.
 * `tenantId` scopes the returned enroll-challenge to the MFA-required tenant.
 * The SDK's platform token rides as the bearer and the refresh travels in
 * the body (mirroring `token`); callers never pass a user bearer here.
 */
export interface SelfEnrollMfaRequest {
  /** The user's refresh token — authorizes the enrollment. */
  refreshToken: string;
  /** Tenant that requires MFA; scopes the returned enroll-challenge. */
  tenantId: string;
  /** MFA method. Omitted from the wire when unset; server defaults to "totp". */
  method?: string;
}

/**
 * Result of `selfEnrollMfa` — the shared TOTP secret, an otpauth://
 * provisioning URL for QR rendering, recovery codes, and an enroll-scoped
 * `mfaChallengeToken` the caller completes via `mfaVerify` to confirm the
 * secret AND mint tokens in a single code entry (there is no separate
 * confirm step). `tenantId` echoes the request.
 */
export interface MfaEnrollment {
  secret: string;
  qrUrl: string;
  recoveryCodes: string[];
  mfaChallengeToken: string;
  tenantId: string;
}

/** Self-service MFA disable request — requires a step-up `code`. */
export interface DisableMfaRequest {
  /** The user's own access JWT, sent as the bearer for this call. */
  userBearer?: string;
  /** Required step-up code. */
  code: string;
}

/** Revoke-all-sessions request — current-user, dual-mode bearer. */
export interface RevokeAllSessionsRequest {
  /** The user's own access JWT, sent as the bearer for this call. */
  userBearer?: string;
}

export interface ListAuthenticatorsRequest {
  /** The user's own access JWT, sent as the bearer for this call. */
  userBearer?: string;
}

/** One enrolled MFA factor (ADR-080). Today only TOTP; the list has 0 or 1
 *  entries. created_at/confirmed_at are unix seconds (confirmed_at 0 until confirmed). */
export interface Authenticator {
  type: string;
  confirmed: boolean;
  created_at: number;
  confirmed_at: number;
  [k: string]: unknown;
}

export interface AuthenticatorList {
  authenticators: Authenticator[];
  backup_codes_remaining: number;
}

export interface RegenerateRecoveryCodesRequest {
  /** The user's own access JWT, sent as the bearer for this call. */
  userBearer?: string;
}

export interface RecoveryCodesResult {
  status: string;
  recovery_codes: string[];
}

interface RawMfaEnrollment {
  secret: string;
  qr_url: string;
  recovery_codes?: string[];
  mfa_challenge_token: string;
  tenant_id: string;
}

interface RawAuthResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_exp?: number;
  idle_ttl?: number;
  expires_at?: string;
  initiated_by_user_id?: string;
  user: UserSummary;
  tenants?: TenantRef[];
  tenant_choice_required?: boolean;
  tenant_choices?: { tenant_id: string; display_name: string; is_owner?: boolean }[];
}

interface RawTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_exp?: number;
  idle_ttl?: number;
  subject_type: string;
  tenant_id: string;
  role: string;
}

/** Resolves the Origin header for an auth call. Returns undefined when neither override, handle config, nor info() yields a value. */
export type OriginResolver = (perCall?: string) => Promise<string | undefined>;

export class AuthClient {
  constructor(
    private readonly http: HttpClient,
    private readonly realmId: string,
    private readonly resolveOrigin: OriginResolver,
    private readonly revocation?: import("./revocation.js").RevocationCache,
  ) {}

  /**
   * SPEC §4.1 — exchange a provider token for a realm-scoped session.
   * Throws RealmError("mfa_required") with details.mfa_challenge_token when
   * the server demands an MFA challenge.
   */
  async login(req: LoginRequest): Promise<LoginResponse> {
    const headers = await this.originHeaders(req.origin);
    // ADR-062: the device label rides as a header on the USER grant only. The
    // platform bootstrap the transport performs before this call is an M2M mint
    // that records no device, so it never carries the label. Absent means NO
    // header — the issuer reads a present empty value as a supplied label.
    if (req.deviceName) {
      const label = headerSafeDeviceName(req.deviceName);
      if (label) headers["x-device-name"] = label;
    }
    const raw = await this.http.request<RawAuthResponse>({
      method: "POST",
      path: "/auth/login",
      headers,
      body: {
        realm_id: this.realmId,
        // ADR-051: canonical grant_type/provider/token triple (mirrors Go's
        // Auth.Login and the issuer's loginReq). The deprecated `method` +
        // `provider_token` fields rode the doomed legacyMethodToGrant shim
        // (Sunset 2026-08-01) and the issuer never read `provider_token` at
        // all — the credential silently never reached the server.
        grant_type: "provider_token",
        provider: req.method,
        token: req.providerToken,
      },
    });
    return mapAuthResp(raw);
  }

  /**
   * SPEC §4.2 — refresh-token rotation + tenant switch + custom-claim
   * injection on the minted access token. `customClaims` is a v0.1.0
   * feature; the server enforces a per-realm allowlist.
   */
  async token(req: TokenRequest): Promise<TokenResponse> {
    const headers = await this.originHeaders(req.origin);
    const raw = await this.http.request<RawTokenResponse>({
      method: "POST",
      path: "/auth/token",
      headers,
      body: {
        realm_id: this.realmId,
        refresh_token: req.refreshToken,
        tenant_id: req.tenantId,
        custom_claims: req.customClaims,
      },
    });
    return {
      accessToken: raw.access_token,
      refreshToken: raw.refresh_token,
      expiresIn: raw.expires_in,
      refreshExp: raw.refresh_exp,
      idleTtl: raw.idle_ttl,
      subjectType: raw.subject_type,
      tenantId: raw.tenant_id,
      role: raw.role,
    };
  }

  /**
   * Partner OTP §3.2.1 — single-factor login via a manager-issued OTP.
   * Identifier is an email or E.164 phone scoped to the realm; presented
   * is the OTP value the user typed. Gated server-side by
   * realms.config.otp_login_enabled — disabled realms surface
   * `unknown_method`; identifier-miss + hash-mismatch collapse to
   * `invalid_credentials`.
   */
  async otpLogin(req: {
    identifier: string;
    presented: string;
    tenantId?: string;
    origin?: string;
  }): Promise<LoginResponse> {
    const headers = await this.originHeaders(req.origin);
    const raw = await this.http.request<RawAuthResponse>({
      method: "POST",
      path: "/auth/login",
      headers,
      body: {
        realm_id: this.realmId,
        // ADR-071 §4: canonical grant_type, value renamed otp_internal→otp
        // (direct cutover — the issuer no longer accepts the old name).
        grant_type: "otp",
        identifier: req.identifier,
        presented: req.presented,
        ...(req.tenantId ? { tenant_id: req.tenantId } : {}),
      },
    });
    return mapAuthResp(raw);
  }

  /**
   * Partner OTP §3.2.2 — second-factor MFA verify with a manager-issued
   * OTP. Thin wrapper over mfaVerify with method=otp pre-set (ADR-071 §4
   * renamed the wire value from otp_internal). The mfa_challenge_token comes
   * from a prior /auth/login response that advertised "otp" in `methods[]`.
   */
  async mfaVerifyOtp(req: {
    mfaToken: string;
    presented: string;
    origin?: string;
  }): Promise<LoginResponse> {
    return this.mfaVerify({
      challengeToken: req.mfaToken,
      code: req.presented,
      method: "otp",
      origin: req.origin,
    });
  }

  /** SPEC §4.3 — complete an MFA challenge. Same response shape as login. */
  async mfaVerify(req: MfaVerifyRequest): Promise<LoginResponse> {
    const headers = await this.originHeaders(req.origin);
    const raw = await this.http.request<RawAuthResponse>({
      method: "POST",
      path: "/auth/mfa/verify",
      headers,
      body: {
        realm_id: this.realmId,
        mfa_challenge_token: req.challengeToken,
        code: req.code,
        method: req.method ?? "totp",
      },
    });
    return mapAuthResp(raw);
  }

  /** SPEC §4.4 — revoke the supplied (or current) refresh token.
   *  When req.accessToken is set AND the Realm has a RevocationCache
   *  wired, the access token's jti is added to the cache on success
   *  (ADR-041 follow-up). Failure to push to the cache does NOT fail
   *  the logout call; the server-side refresh revocation is the
   *  load-bearing operation. */
  async logout(req?: LogoutRequest): Promise<{ status: string }> {
    const headers = await this.originHeaders(req?.origin);
    const out = await this.http.request<{ status: string }>({
      method: "POST",
      path: "/auth/logout",
      headers,
      body: {
        realm_id: this.realmId,
        refresh_token: req?.refreshToken,
      },
    });
    if (req?.accessToken && this.revocation) {
      const { peekJwtRevokeFields } = await import("./revocation.js");
      const { jti, expMs } = peekJwtRevokeFields(req.accessToken);
      if (jti) {
        try {
          await this.revocation.revoke(jti, expMs);
        } catch {
          // Cache failure does not fail logout; server-side refresh
          // revocation is the load-bearing operation.
        }
      }
    }
    return out;
  }

  /** SPEC §4.5 — server-side revoke of a specific session id. */
  async revokeSession(sessionId: string, userBearer?: string): Promise<void> {
    await this.http.request({
      method: "DELETE",
      path: `/auth/sessions/${encodeURIComponent(sessionId)}`,
      bearer: userBearer,
    });
  }

  /** SPEC §4.6 — list sessions for the user identified by `userBearer`. */
  async listSessions(userBearer?: string): Promise<SessionInfo[]> {
    const raw = await this.http.request<SessionListWire | SessionInfo[]>({
      method: "GET",
      path: "/auth/sessions",
      bearer: userBearer,
    });
    if (Array.isArray(raw)) return raw;
    // The issuer answers with the LOCKED paged envelope `{items, next_cursor,
    // total}` (httpapi.pagedSlice). Reading `sessions` alone — as this method
    // did until 0.37.0 — returns an empty array against every real issuer,
    // which is indistinguishable from "you have no sessions". `sessions` is
    // kept as a legacy/mock fallback, exactly as Go's decodeSessionPage does.
    //
    // Returns the FIRST PAGE only (server default 50). Go's ListSessions
    // iterates `next_cursor`; TS does not yet — see ../TODO.md.
    return raw.items ?? raw.sessions ?? [];
  }

  /**
   * Self-service MFA enroll — `POST /auth/mfa/enroll` (ADR-061). Refresh-authed:
   * `req.refreshToken` is the handle to the user's login session, so a
   * first-login user who has no access token yet — the MFA gate withheld it —
   * can still enroll; the same call serves a post-login user switching into an
   * MFA-required tenant. The SDK's platform token rides as the bearer (the
   * HttpClient auto-attaches it, exactly as for `token`) and the refresh
   * travels in the body. Returns the TOTP secret, an otpauth:// provisioning
   * URL, recovery codes, and an enroll-scoped challenge to pass to `mfaVerify`
   * — there is NO separate confirm step. `method` is omitted from the wire when
   * unset (server defaults to "totp"). Server error codes (unsupported_method,
   * already_enrolled (409), not_a_member (403), refresh_invalid (401)) surface
   * as the usual RealmError.
   */
  async selfEnrollMfa(req: SelfEnrollMfaRequest): Promise<MfaEnrollment> {
    const body: Record<string, unknown> = {
      refresh_token: req.refreshToken,
      tenant_id: req.tenantId,
    };
    if (req.method !== undefined && req.method !== "") body["method"] = req.method;
    const raw = await this.http.request<RawMfaEnrollment>({
      method: "POST",
      path: "/auth/mfa/enroll",
      body,
    });
    return {
      secret: raw.secret,
      qrUrl: raw.qr_url,
      recoveryCodes: raw.recovery_codes ?? [],
      mfaChallengeToken: raw.mfa_challenge_token,
      tenantId: raw.tenant_id,
    };
  }

  /**
   * Self-service MFA disable — `DELETE /auth/mfa` with a step-up `code` in
   * the body. Returns void; the server's `{ status: "disabled" }` ack is
   * ignored.
   */
  async disableMfa(req: DisableMfaRequest): Promise<void> {
    await this.http.request({
      method: "DELETE",
      path: "/auth/mfa",
      bearer: req.userBearer,
      body: { code: req.code },
    });
  }

  /**
   * Revoke all sessions for the current user — `DELETE /auth/sessions`.
   * Dual-mode bearer like `revokeSession`. No request body. Returns void;
   * the server's `{ status: "ok" }` ack is ignored. The server rejects
   * revocation-class tokens with `insufficient_scope`, surfaced as a
   * RealmError.
   */
  async revokeAllSessions(req?: RevokeAllSessionsRequest): Promise<void> {
    await this.http.request({
      method: "DELETE",
      path: "/auth/sessions",
      bearer: req?.userBearer,
    });
  }

  /**
   * SPEC §10.1 — mint an MFA challenge token from an already-issued
   * access token. The middleware uses this to issue 412 envelopes on
   * `mfaProtectedPaths` without forcing the partner app to round-trip
   * through `auth.login` again.
   *
   * The server endpoint (`POST /auth/mfa/challenge`) is tracked as a TODO
   * in the auth-monorepo. Until the server lands it, this helper throws
   * RealmError({ code: "server_error" }) on any non-2xx response and
   * surfaces network errors normally.
   */
  async mintMfaChallenge(req: MfaChallengeMintRequest): Promise<MfaChallengeMintResponse> {
    interface Wire { mfa_challenge_token?: string; methods?: string[] }
    let raw: Wire;
    try {
      raw = await this.http.request<Wire>({
        method: "POST",
        path: "/auth/mfa/challenge",
        bearer: req.accessToken,
        // Empty body — the bearer identifies user, session, and realm.
        body: {},
      });
    } catch (e) {
      if (e instanceof RealmError && (e.httpStatus === 404 || e.httpStatus === 501)) {
        throw new RealmError({
          code: "server_error",
          message: "mfa challenge mint not yet supported by server",
          cause: e,
        });
      }
      throw e;
    }
    if (!raw || typeof raw.mfa_challenge_token !== "string") {
      throw new RealmError({
        code: "server_error",
        message: "mfa challenge mint not yet supported by server",
      });
    }
    return {
      mfaChallengeToken: raw.mfa_challenge_token,
      methods: raw.methods ?? ["totp"],
    };
  }

  /**
   * SPEC §4.2.1 — build a {@link TokenManager} seeded with a refresh token
   * the client already holds (obtained out-of-band, e.g. at enrollment).
   * The manager refreshes against POST /auth/token directly on that token,
   * single-flights concurrent acquisitions, and (with a `refreshSink`)
   * persists each rotated token before returning the new access token.
   *
   * For long-lived, single-identity clients (desktop apps, sync agents,
   * daemons) — NOT browser/BFF flows (§10) or the SDK's internal platform
   * session (§4.0).
   */
  newTokenManager(refreshToken: string, opts?: TokenManagerOptions): TokenManager {
    return new TokenManager(this, refreshToken, opts);
  }

  /**
   * List the current user's enrolled MFA authenticator(s) and remaining
   * backup-code count — `GET /auth/mfa/authenticators`. A read, NOT MFA-gated.
   */
  async listAuthenticators(req?: ListAuthenticatorsRequest): Promise<AuthenticatorList> {
    return this.http.request<AuthenticatorList>({
      method: "GET",
      path: "/auth/mfa/authenticators",
      bearer: req?.userBearer,
    });
  }

  /**
   * Regenerate the current user's recovery codes — `POST
   * /auth/mfa/recovery/regenerate`, invalidating the previous set. Requires a
   * CONFIRMED enrollment (RealmError conflict, `not_enrolled`) and a FRESH TOTP
   * within the elevated window (RealmError mfa_required, 412, until re-verified).
   * Codes are shown once and also emailed (ADR-079).
   */
  async regenerateRecoveryCodes(req?: RegenerateRecoveryCodesRequest): Promise<RecoveryCodesResult> {
    return this.http.request<RecoveryCodesResult>({
      method: "POST",
      path: "/auth/mfa/recovery/regenerate",
      bearer: req?.userBearer,
    });
  }

  private async originHeaders(perCall?: string): Promise<Record<string, string>> {
    const o = await this.resolveOrigin(perCall);
    return o ? { origin: o } : {};
  }
}

function mapAuthResp(r: RawAuthResponse): LoginResponse {
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    expiresIn: r.expires_in,
    refreshExp: r.refresh_exp,
    idleTtl: r.idle_ttl,
    expiresAt: r.expires_at,
    initiatedByUserId: r.initiated_by_user_id,
    user: r.user,
    tenants: r.tenants ?? [],
    // Both stay UNDEFINED when the server omits them: an ordinary login must
    // not grow a falsy picker field that a caller might render.
    tenantChoiceRequired: r.tenant_choice_required,
    tenantChoices: r.tenant_choices?.map((c) => ({
      tenantId: c.tenant_id,
      displayName: c.display_name,
      isOwner: c.is_owner === true,
    })),
  };
}
