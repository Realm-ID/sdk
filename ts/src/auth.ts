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
import { unwrapData } from "./envelope.js";
import { scopeWireValue } from "./scope.js";
import {
  LoginMintError,
  resolveProductRoles,
  type ProductRolesHandler,
} from "./product-roles.js";
import { resolveScopes, type ScopesHandler } from "./scopes-handler.js";
import { fireIdentityResolved, type AuthFlow, type IdentityResolvedHandler } from "./identity-resolved.js";
import { enrichRefreshMint } from "./derived-claims-refresh.js";
import { NOOP_LOGGER } from "./logger.js";
import { tokenUnderLock, withSessionLock, type LockDeps } from "./session-lock.js";
import { TokenManager, type TokenManagerOptions } from "./token-manager.js";
import { paginate, readPage, type Paginated, type Page, type PageOpts } from "./pagination.js";

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
  /**
   * ADR-100 D16/D5 — the permissions the holder's ROLE confers, in YOUR
   * vocabulary, used to narrow a user-API-key token's `permissions_cap` claim
   * to this org.
   *
   * Supply it from your own role→permission map. RealmID stores no partner
   * catalog and will not resolve this for you (D17): a scope string is opaque
   * here.
   *
   * **Optional, and omitting it can only WIDEN toward the stored cap, never
   * past it.** The claim minted is `stored_cap ∩ role_permissions`; omit the
   * field and the stored cap travels unnarrowed, which is exactly the
   * pre-ADR-100 behaviour. A wrong or hostile list therefore cannot widen a
   * key — `A ∩ B ⊆ A` for every `B` — which is what makes a caller-asserted
   * value acceptable at all. It is audited as ASSERTED and unverified, the same
   * convention `source_org_id` uses.
   *
   * Ignored for a token that is not key-derived, and ignored for an UNCAPPED
   * key, whose claim stays ABSENT whatever you send (D7).
   *
   * ⚠️ **An empty INTERSECTION is `403`, not an empty claim** (D8), and the
   * narrowing is per-org — so a multi-org key can mint in one org and be
   * refused in another. The error names the org.
   */
  rolePermissions?: string[];
  // NOTE: customClaims intentionally NOT accepted here. Per SPEC §4.1 the
  // refresh token carries identity only; access-token claims are minted via
  // `auth.token({ customClaims })`.
}

export interface TenantRef {
  id: string;
  role: string;
  displayName?: string;
  /**
   * Whether this membership demands an MFA step before a usable access token is
   * minted. The issuer sets it per tenant on the login tenant list; a BFF uses
   * it to tell an unminted-because-MFA login apart from an
   * unminted-because-multi-tenant one.
   *
   * ⚠️ **Ported from Go as part of ADR-102 D10.** It existed only in the Go SDK
   * — a hand-mirrored surface with a hole in it, which is how the hole survived.
   * D10's multi-tenant branch depends on being able to tell those two states
   * apart, so closing the parity gap is a prerequisite, not a tidy-up.
   */
  mfaRequired?: boolean;
}

export interface UserSummary {
  id: string;
  email?: string;
  displayName?: string;
  [k: string]: unknown;
}

/** `auth.sendLoginCode` result (SPEC §X.4a): always `sentIfRegistered: true`. */
export interface SendLoginCodeResponse {
  sentIfRegistered: boolean;
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
  /**
   * SPEC §4.3a — `true` on a successful recovery-code redeem (`redeemRecoveryCode`):
   * the code is consumed and the old authenticator cleared, so send the user to
   * re-enroll. `undefined` on every other lane.
   */
  reenrollRequired?: boolean;
  /**
   * ADR-104 R-e — the sessions the issuer ended as a side effect of this call;
   * set only by `passwordLogin` with `newPassword` (a change at sign-in ends the
   * holder's whole identity in the realm). The SDK has ALREADY written each into
   * the session store, so a partner needs no action; it is exposed for audit.
   * Empty when none ended or the issuer predates the field.
   */
  revokedSids?: string[];
  /**
   * The tenant this session resolved to, once settled. Empty on the D10
   * multi-tenant branch until `completeLogin` runs.
   */
  tenantId?: string;
  /** The caller's role in `tenantId`. */
  role?: string;
}

/**
 * Reports whether the issuer returned a tenant PICKER instead of a session:
 * more than one membership and no access token minted (ADR-102 D10).
 *
 * ⚠️ **Ported from Go's `Session.NeedsTenantChoice`.** It had no TS or Java
 * equivalent, which is exactly the surface D10 depends on.
 *
 * Unrelated to `tenantChoiceRequired` / `tenantChoices` (ADR-092 D5), which is a
 * single-tenant-membership RECONCILIATION prompt on a login that already
 * SUCCEEDED. Same words, different mechanism; do not conflate them.
 */
export function needsTenantChoice(s: LoginResponse | undefined): boolean {
  if (!s) return false;
  return !s.accessToken && (s.tenants?.length ?? 0) > 1;
}

/**
 * Resolves the final `(tenantId, role)` pair to persist for a session, given an
 * optional caller preference. Order: preferred > `s.tenantId` > `s.tenants[0]`.
 *
 * ⚠️ **DO NOT use this to settle the D10 multi-tenant branch.** The
 * `tenants[0]` fallback would mint for an ARBITRARY tenant and resolve THAT
 * tenant's product roles — a silent wrong answer, not an error. This is for a
 * caller that has already decided; `completeLogin` is the selection mechanism.
 *
 * Ported from Go's `Session.SelectTenant`.
 */
export function selectTenant(
  s: LoginResponse | undefined,
  preferred?: string,
): { tenantId: string; role: string } {
  if (!s) return { tenantId: preferred ?? "", role: "" };
  let tenantId = preferred || s.tenantId || "";
  if (!tenantId && s.tenants?.length) tenantId = s.tenants[0]!.id;
  let role = s.role ?? "";
  for (const t of s.tenants ?? []) {
    if (t.id === tenantId) {
      role = t.role;
      break;
    }
  }
  return { tenantId, role };
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
   * ADR-102 — the PARTNER's own role name(s) for this principal, carried onto
   * the access token and read by no RealmID gate.
   *
   * Normally you do NOT set this by hand: configure `productRoles` on the realm
   * and `login`/`completeLogin` populate it on every mint. The field is here
   * because the mint accepts it.
   *
   * ⚠️ `scope` carries authority; this carries a NAME. Do not branch
   * authorization on it, and do not confuse it with the `role` claim, which is
   * RealmID's OWN vocabulary and a trusted authorization lookup key on the
   * direct-bearer lane.
   *
   * Bounded by CONSTANTS, not realm config: at most 16 entries of at most 64
   * bytes, each non-empty, valid UTF-8 and free of control characters
   * (`400 too_many_product_roles` / `product_role_too_long` /
   * `invalid_product_role`). An empty array mints no claim rather than `[]`.
   */
  productRoles?: string[];
  /**
   * v0.1.0 — custom claims merged into the minted **access token**,
   * subject to a per-realm server-side allowlist. Use this for app-state
   * fields (e.g. `outlet_ids`) that downstream services need to authorize
   * without a database lookup. The SDK is a pass-through; allowlist
   * enforcement is the server's responsibility.
   */
  customClaims?: Record<string, unknown>;
  /**
   * ADR-097 GRANTED AUTHORITY — the partner's OWN scope strings, minted into
   * the token's `scope` claim and read back by {@link scopesFrom} /
   * {@link scopeAllows} / {@link ScopePolicy}.
   *
   * This is the operand the enforcement layer in `scope.ts` evaluates. Supply
   * it from YOUR role→scope map: RealmID stores no partner catalog (ADR-097
   * D17) and a scope string is opaque there — shape is validated, meaning
   * never is.
   *
   * An ARRAY, not the wire's space-delimited string, on purpose. The SDK joins
   * with `" "` and refuses an entry that could not survive it, because a space
   * inside one entry is not a parse error on the wire — it SPLITS one scope
   * into two and mints authority you did not ask for.
   *
   * Accepted on `/auth/token` ONLY, never on `/auth/login`: the ADR-041 escort
   * runs on this route for every refresh class, so a confidential backend is
   * structurally always in the path and a user cannot self-assert a scope.
   *
   * **Optional. Empty and absent are the same request** — unlike
   * `rolePermissions`, an empty scope carries no instruction. The issuer bounds
   * the list against the realm's `user_api_keys.max_permission_strings` /
   * `max_permission_string_len` (`400 too_many_scopes` / `scope_too_long`) and
   * refuses it outright on a service-class refresh (`400 scope_not_supported`).
   *
   * Where the token is ALSO user-API-key-derived, the minted claim is the
   * intersection with `permissions_cap`; see `rolePermissions` for that.
   */
  scope?: string[];
  /**
   * ADR-100 D16/D5 — the permissions the holder's ROLE confers, in YOUR
   * vocabulary, used to narrow a user-API-key token's `permissions_cap` claim
   * to this org — on REFRESH as well as login (D18).
   *
   * Supply it on EVERY mint. A user-API-key session is refreshable, so a
   * refresh that omits the list comes back WIDER than the token it replaces —
   * silently. Supply it from your own role→permission map. RealmID stores no partner
   * catalog and will not resolve this for you (D17): a scope string is opaque
   * here.
   *
   * **Optional, and omitting it can only WIDEN toward the stored cap, never
   * past it.** The claim minted is `stored_cap ∩ role_permissions`; omit the
   * field and the stored cap travels unnarrowed, which is exactly the
   * pre-ADR-100 behaviour. A wrong or hostile list therefore cannot widen a
   * key — `A ∩ B ⊆ A` for every `B` — which is what makes a caller-asserted
   * value acceptable at all. It is audited as ASSERTED and unverified, the same
   * convention `source_org_id` uses.
   *
   * Ignored for a token that is not key-derived, and ignored for an UNCAPPED
   * key, whose claim stays ABSENT whatever you send (D7).
   *
   * ⚠️ **An empty INTERSECTION is `403`, not an empty claim** (D8), and the
   * narrowing is per-org — so a multi-org key can mint in one org and be
   * refused in another. The error names the org.
   */
  rolePermissions?: string[];
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
  /**
   * The session's CURRENT refresh token (SPEC §4.3, go `0.64.2`). Under issuer
   * ADR-109 Issuer B this call ROTATES that session's refresh token, so one that
   * races a refresh of the same session is a reuse and revokes the session. When
   * set, the call takes the same per-session lock as refresh, WAITS for it (50 ms
   * x 60), runs the issuer call bounded at 10 s, and stores the `mfa-verify`
   * outcome (the rotated token, also after a post-verify mint failure) under the
   * key before releasing, so a refresh waiting behind it adopts the rotated token.
   * NEVER sent on the wire. Omit it for a first-login MFA (no session yet);
   * **omitting it otherwise leaves you unprotected against that race**. The lock is
   * not re-entrant: the middleware's own handlers call this WITHOUT it.
   */
  refreshToken?: string;
}

/** SPEC §4.3a — redeem a single-use recovery code in place of the TOTP code. */
export interface RedeemRecoveryCodeRequest {
  challengeToken: string;
  code: string;
  /** Optional Origin header override. */
  origin?: string;
  /** The session's current refresh token: takes the per-session lock exactly as {@link MfaVerifyRequest.refreshToken}. */
  refreshToken?: string;
}

export interface LogoutRequest {
  refreshToken?: string;
  /**
   * End EVERY session of the user, not only the presented token's (owner
   * ruling 2026-10-01). Sent as `all: true` (omitted otherwise); the issuer
   * answers with `revoked_sids`, each of which is revoked locally.
   */
  all?: boolean;
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

/**
 * `mintMfaChallenge` takes no credential field (R60): the user whose access token needs a step-up
 * rides in `X-User-Token` (`realm.withUserToken(jwt).auth.mintMfaChallenge()`), the platform token
 * is the bearer. A bare platform call is refused locally as `ActorRequiredError`.
 */
export type MfaChallengeMintRequest = Record<string, never>;

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

/**
 * Normalise a `/auth/sessions` body into a {@link Page}.
 *
 * The issuer answers the LOCKED paged envelope `{items, next_cursor, total}`
 * (`httpapi.pagedSlice`); that path delegates to `readPage`, so SPEC §7's
 * validation still applies to the shape a real server sends. The flat
 * `{sessions: [...]}` and bare-array bodies are a deliberate legacy/mock
 * tolerance mirroring Go's `decodeSessionPage` — reading `sessions` ALONE is
 * what made this method return `[]` against every real issuer until 0.37.0, so
 * the tolerance is kept strictly as a fallback and never as the primary read.
 *
 * Neither legacy shape carries a cursor, so it yields no `nextCursor` and the
 * iterator stops after one round trip — a legacy server cannot put the caller
 * in an endless loop.
 */
function readSessionPage(raw: unknown): Page<SessionInfo> {
  // A legacy shape carries no cursor, so hasMore is false by construction —
  // one round trip and the iterator stops.
  if (Array.isArray(raw)) return { items: raw as SessionInfo[], hasMore: false };
  if (raw && typeof raw === "object") {
    const obj = raw as SessionListWire;
    if (obj.items === undefined && Array.isArray(obj.sessions)) {
      return { items: obj.sessions, hasMore: false };
    }
  }
  return readPage<SessionInfo>(raw);
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
  /** Required step-up code. */
  code: string;
}

/** Revoke-all-sessions request: no fields; the actor is `realm.withUserToken(jwt)` (R60). */
export type RevokeAllSessionsRequest = Record<string, never>;

/** No fields; the actor is `realm.withUserToken(jwt)` (R60). */
export type ListAuthenticatorsRequest = Record<string, never>;

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

/** No fields; the actor is `realm.withUserToken(jwt)` (R60). */
export type RegenerateRecoveryCodesRequest = Record<string, never>;

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
  tenants?: { tenant_id?: string; id?: string; role: string; display_name?: string; mfa_required?: boolean }[];
  tenant_id?: string;
  role?: string;
  tenant_choice_required?: boolean;
  tenant_choices?: { tenant_id: string; display_name: string; is_owner?: boolean }[];
  reenroll_required?: boolean;
  /** ADR-104 R-e; only a password change at sign-in carries it. Unvalidated wire value. */
  revoked_sids?: unknown;
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

/**
 * Returns the tenant a login resolved to, or "" when the caller must still
 * choose (ADR-102 D10).
 *
 * "Settled" means the issuer picked one: a flat `tenant_id`, or exactly one
 * membership. It deliberately does NOT fall back to `tenants[0]` on a
 * multi-tenant login — that is what {@link selectTenant} does for a caller who
 * has already decided, and using it here would mint for an arbitrary org and
 * resolve that org's roles.
 */
function settledTenant(s: LoginResponse): string {
  if (s.tenantId) return s.tenantId;
  if ((s.tenants?.length ?? 0) === 1) return s.tenants![0]!.id;
  return "";
}

export class AuthClient {
  constructor(
    private readonly http: HttpClient,
    private readonly realmId: string,
    private readonly resolveOrigin: OriginResolver,
    private readonly revocation?: import("./revocation.js").RevocationCache,
    /**
     * ADR-102 — resolves the PARTNER's own role names for a principal in one
     * org. Optional; undefined means the claim is simply omitted.
     */
    private readonly productRoles?: ProductRolesHandler,
    /**
     * ADR-097 — resolves the PARTNER's own granted-authority scope strings for
     * a principal in one org. Optional; undefined means the claim is omitted.
     *
     * Runs on the SAME lanes as `productRoles`, login AND refresh. A handler
     * that worked on one lane only is the exact defect this seam exists to
     * close.
     */
    private readonly scopes?: ScopesHandler,
    /**
     * The post-identity, pre-derived-claims hook (design doc:
     * `../docs/design/pre-mint-hook.md`). Fires immediately before
     * `productRoles` / `scopes` are resolved, on every lane that resolves
     * them — see {@link IdentityResolvedHandler} for the full contract,
     * including why it is NOT retried and MUST be idempotent.
     */
    private readonly onIdentityResolved?: IdentityResolvedHandler,
    /** SPEC §6.7 / §10.1 step 3a: what `logout` needs to revoke the session locally. */
    private readonly session?: {
      tokens: import("./tokens.js").TokensClient;
      verify(token: string): Promise<unknown>;
      now(): number;
      /** The realm's session store + logger: what the per-session refresh lock (SPEC §4.2/§4.3) runs on. Absent = no lock. */
      store?: import("./session-store.js").SessionStateStore;
      logger?: import("./logger.js").Logger;
      /** Set by `createSplitRealm` only: user mints go to /auth/token/partial and are finished locally. */
      split?: import("./realm-internals.js").SplitHooks;
    },
  ) {}

  private lockDeps(): LockDeps | undefined {
    const s = this.session;
    return s?.store ? { store: s.store, logger: s.logger ?? NOOP_LOGGER } : undefined;
  }

  private async underSessionLock<T extends { refreshToken?: string }>(refreshToken: string | undefined, fn: () => Promise<T>): Promise<T> {
    const deps = this.lockDeps();
    return deps ? withSessionLock(deps, refreshToken, fn) : fn();
  }

  /**
   * SPEC §4.1 — exchange a provider token for a realm-scoped session.
   * Throws RealmError("mfa_required") with details.mfa_challenge_token when
   * the server demands an MFA challenge.
   *
   * ## ⚠️ BREAKING (ADR-102 D10): `login` MINTS now
   *
   * Once the tenant is settled, `login` follows `/auth/login` with a
   * `/auth/token` mint, and the `productRoles` handler runs there. It is a
   * CHANGED entry point, not a new one: a separate `loginAndMint` would have
   * been non-breaking and would have left the default wrong — every consumer who
   * never knew to re-mint would keep the role-blind token, which is the exact
   * failure this removes.
   *
   * Two branches, and they are the two `/auth/login` already has:
   *
   * - **exactly one tenant** — mint immediately; the caller gets a fully-minted
   *   session in one call, as today.
   * - **several tenants** (`needsTenantChoice`) — do NOT mint. Your app presents
   *   the choice, with your labels and your role names, and calls
   *   {@link completeLogin} on selection.
   *
   * ⚠️ Do NOT settle the multi-tenant branch with {@link selectTenant}: its
   * `tenants[0]` fallback would mint for an ARBITRARY tenant and resolve THAT
   * tenant's roles — a silent wrong answer, not an error.
   *
   * What moves for you: the `412 mfa_required` gate now surfaces from `login`
   * where it previously surfaced from your own `token()` call.
   *
   * The session `/auth/login` created is NOT discarded when the mint fails: it
   * rides on a {@link LoginMintError}, the ADR-102 OQ8 RECOVERY ANCHOR. Read
   * that class for why it is on the error rather than in the return value.
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
        ...(req.rolePermissions !== undefined ? { role_permissions: req.rolePermissions } : {}),
      },
    });
    const session = mapAuthResp(raw);
    // ADR-102 D10 — mint once the tenant is settled. See the doc comment.
    const settled = settledTenant(session);
    if (settled) {
      await this.mintOrThrowWithAnchor(session, settled, "login", req.rolePermissions);
    }
    return session;
  }

  /**
   * Mints, and on failure throws a {@link LoginMintError} CARRYING the session.
   *
   * ⚠️ Throwing a bare error would silently drop the ADR-102 OQ8 recovery
   * anchor, because a caller's `catch` has no other handle on the session — and
   * the users stranded by that are exactly the ones ADR-092's session-limit
   * affordance and ADR-061's enrollment gate exist for.
   */
  private async mintOrThrowWithAnchor(
    session: LoginResponse,
    tenantId: string,
    flow: AuthFlow,
    rolePermissions?: string[],
  ): Promise<void> {
    try {
      await this.mintProductRoles(session, tenantId, rolePermissions, flow);
    } catch (err) {
      throw new LoginMintError(session, tenantId, err);
    }
  }

  /**
   * Finishes a multi-tenant login: runs the `productRoles` handler for the
   * CHOSEN tenant and mints through `/auth/token`, updating the session in
   * place (ADR-102 D10).
   *
   * Call it when {@link needsTenantChoice} reported true and your app has
   * presented the choice. A tenant the session does not list is refused LOCALLY
   * rather than sent: the issuer's answer for it (`invalid_credentials`) would
   * read as a login failure rather than the caller bug it is.
   *
   * Safe on an already-minted single-tenant session: it re-mints for the named
   * tenant, which is the tenant-switch operation.
   */
  async completeLogin(
    session: LoginResponse,
    tenantId: string,
    rolePermissions?: string[],
  ): Promise<void> {
    if (!session) throw new Error("completeLogin needs a session");
    if (!tenantId) {
      throw new Error(
        "completeLogin needs a tenantId — the multi-tenant branch does not auto-pick, " +
          "and selectTenant's tenants[0] fallback would mint for an arbitrary org",
      );
    }
    const known = (session.tenants?.length ?? 0) === 0 ||
      (session.tenants ?? []).some((t) => t.id === tenantId);
    if (!known) {
      throw new Error(`tenant ${tenantId} is not one of this session's memberships`);
    }
    await this.mintProductRoles(session, tenantId, rolePermissions, "tenant_choice");
  }

  /**
   * Runs the handler and re-mints the session through `/auth/token`, updating
   * it in place.
   *
   * With NO handler configured and an access token ALREADY in hand it returns
   * immediately: a round trip that could only reproduce the token we are holding
   * is pure cost, and skipping it is what keeps D10 from taxing every consumer
   * who never adopts the claim.
   *
   * The remaining condition — no handler, no access token — is exactly the guard
   * RealmID's own BFF hand-rolled (`if (!sess.accessToken)`), with a comment
   * explaining that the issuer skips its inline single-tenant mint under MFA and
   * that the 412 gate "fires on /auth/token, which login never calls". That is
   * SDK documentation living in a consumer; once `login` mints, the guard
   * collapses and the gate surfaces for EVERY consumer.
   */
  private async mintProductRoles(
    session: LoginResponse,
    tenantId: string,
    rolePermissions?: string[],
    flow: AuthFlow = "login",
  ): Promise<void> {
    // The post-identity, pre-derived-claims hook — first statement of the
    // body, ABOVE the round-trip short-circuit below, so it fires on every
    // call regardless of whether productRoles/scopes are configured. See
    // identity-resolved.ts's module doc for why the guarantee is stated this
    // way rather than "once per authentication".
    let roleForTenant: string | undefined;
    for (const t of session.tenants ?? []) {
      if (t.id === tenantId) {
        roleForTenant = t.role;
        break;
      }
    }
    await fireIdentityResolved(this.onIdentityResolved, {
      flow,
      realmId: this.realmId,
      tenantId,
      userId: session.user?.id ?? "",
      role: roleForTenant ?? "",
      email: session.user?.email ?? "",
      displayName: session.user?.displayName ?? "",
    });
    if (!this.productRoles && !this.scopes && session.accessToken) return;
    // The handler's error surfaces as a ProductRolesError and is NOT mapped
    // into a RealmError. The session stays intact so the caller can recover.
    const roles = await resolveProductRoles(this.productRoles, tenantId, session.user?.id ?? "");
    // ADR-097 granted authority, resolved on the SAME lanes and by the same
    // rules. A `scopes` handler that worked on refresh but not here would be
    // the mirror of the bug this whole seam exists to close, and would be found
    // the same way: by a partner, in production.
    const scopes = await resolveScopes(this.scopes, tenantId, session.user?.id ?? "");
    const mint = await this.tokenUnlocked({
      refreshToken: session.refreshToken,
      tenantId,
      productRoles: roles,
      scope: scopes,
      rolePermissions,
    });
    session.accessToken = mint.accessToken;
    session.refreshToken = mint.refreshToken;
    session.expiresIn = mint.expiresIn;
    if (mint.refreshExp) session.refreshExp = mint.refreshExp;
    session.tenantId = tenantId;
    for (const t of session.tenants ?? []) {
      if (t.id === tenantId) {
        session.role = t.role;
        break;
      }
    }
  }

  /**
   * Re-mints a freshly-refreshed token so it carries the derived claims
   * (ADR-102 `product_roles`, ADR-097 `scope`), updating `out` IN PLACE.
   *
   * @internal — this is the MIDDLEWARE's seam, not a partner API. It is a
   * method on AuthClient only because the handlers and `token` live here;
   * `enrichRefreshMint` in `derived-claims-refresh.ts` holds the behaviour and
   * its reasoning. Calling it yourself after your own `token()` is harmless but
   * pointless: pass the claims to `token()` instead.
   *
   * A NO-OP when neither handler is configured, which is what keeps the second
   * round trip off every consumer who never adopts either claim.
   */
  async enrichRefresh(out: TokenResponse, tenantId: string): Promise<void> {
    await enrichRefreshMint(
      {
        productRoles: this.productRoles,
        scopes: this.scopes,
        onIdentityResolved: this.onIdentityResolved,
        realmId: this.realmId,
        mint: (req) => this.tokenUnlocked(req),
      },
      out,
      tenantId,
    );
  }

  /**
   * SPEC §4.2 — refresh-token rotation + tenant switch + custom-claim
   * injection on the minted access token. `customClaims` is a v0.1.0
   * feature; the server enforces a per-realm allowlist.
   *
   * With a non-empty `refreshToken` it takes the PER-SESSION refresh lock (the one
   * the middleware's refresh and MFA routes and a direct `mfaVerify` given
   * `refreshToken` take; go `0.64.2`), so concurrent rotations of one session never
   * both reach the issuer: a concurrent identical request adopts the winner's
   * result; one whose request differs retries on the winner's ROTATED token (never
   * the spent one), up to 3 hops, then rejects with a {@link RefreshSupersededError}
   * carrying the newest token. A store error or an unreadable outcome fails CLOSED
   * (retryable 503, the issuer is not called). The lock holds only across replicas
   * sharing one `SessionStateStore`; a raw HTTP call to the issuer is not covered.
   */
  async token(req: TokenRequest): Promise<TokenResponse> {
    const deps = this.lockDeps();
    return deps ? tokenUnderLock(deps, req, (r) => this.tokenUnlocked(r)) : this.tokenUnlocked(req);
  }

  /**
   * `/auth/token` with NO per-session lock — the mint every internal caller
   * uses (the login lanes' derived-claims mint, the middleware's refresh, which
   * already hold or do not need the lock; the lock is not re-entrant).
   * @internal
   */
  async tokenUnlocked(req: TokenRequest): Promise<TokenResponse> {
    // Refused before anything leaves: a mint that fails partway would still
    // have spent (and rotated away) the refresh token, logging the caller out.
    const scopeWire = scopeWireValue(req.scope);
    const headers = await this.originHeaders(req.origin);
    const split = this.session?.split;
    const wire = await this.http.request<RawTokenResponse>({
      method: "POST",
      // SPEC §14.2: a split realm's people call goes to the partial endpoint (it answers 409
      // `split_signing_required` at /auth/token), and the answer is finished here before release.
      path: split ? "/auth/token/partial" : "/auth/token",
      headers,
      body: {
        realm_id: this.realmId,
        refresh_token: req.refreshToken,
        tenant_id: req.tenantId,
        custom_claims: req.customClaims,
        ...(req.rolePermissions !== undefined ? { role_permissions: req.rolePermissions } : {}),
        // Keyed on EMPTINESS, not on `undefined` (ADR-102 D11 rule 2) — the
        // opposite of rolePermissions directly above, and the difference is the
        // whole point. An empty rolePermissions is an instruction ("this role
        // confers nothing here"); an empty productRoles is not, because absent
        // and empty must mean the same thing. Every token issued before ADR-102
        // has no claim at all, so a reader handles absence regardless, and
        // minting [] would invent a third state for them to interpret.
        ...(req.productRoles?.length ? { product_roles: req.productRoles } : {}),
        // Keyed on emptiness, not on `undefined` — the inverse of
        // rolePermissions above, and for the stated reason: parseScope trims
        // and returns nil for "", so an empty scope IS an absent one.
        ...(scopeWire !== "" ? { scope: scopeWire } : {}),
      },
    });
    const raw = split ? ((await split.finish(wire)) as unknown as RawTokenResponse) : wire;
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
   * SPEC §X.4a (issuer ADR-116) — send the sign-in code to a person who is NOT
   * signed in, by SMS or WhatsApp. `POST /auth/otp/send-login` with the platform
   * token. The answer is enumeration-safe by design: `sentIfRegistered` is always
   * true and does not say whether the number belongs to anyone, so show the same
   * text either way, then call `otpLogin` with the same `identifier` (and
   * `tenantId`). `onBehalfOfIp` is the END USER's IP, sent as
   * `X-On-Behalf-Of-IP`; without it only the per-phone limit applies. The 202
   * body is bare, not `{"data":…}`.
   */
  async sendLoginCode(req: {
    identifier: string;
    deliveryMode: "sms" | "whatsapp";
    tenantId?: string;
    onBehalfOfIp?: string;
  }): Promise<SendLoginCodeResponse> {
    const raw = await this.http.request<{ sent_if_registered: boolean }>({
      method: "POST",
      path: "/auth/otp/send-login",
      headers: req.onBehalfOfIp ? { "X-On-Behalf-Of-IP": req.onBehalfOfIp } : undefined,
      body: {
        identifier: req.identifier,
        delivery_mode: req.deliveryMode,
        ...(req.tenantId ? { tenant_id: req.tenantId } : {}),
      },
    });
    return { sentIfRegistered: raw.sent_if_registered };
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
    const session = mapAuthResp(raw);
    // ADR-102 D10 — an OTP login is a login. This lane was uncovered until the
    // Go SDK's AST-derived lane guard found it; the defect report that prompted
    // the guard named only mfaVerify.
    const otpSettled = settledTenant(session);
    if (otpSettled) await this.mintOrThrowWithAnchor(session, otpSettled, "otp");
    return session;
  }

  /**
   * ADR-104 — sign in with a native username/password credential.
   *
   * `identifier` is an email, an E.164 phone, or a USERNAME. The issuer
   * CLASSIFIES IT ONCE, never trying several kinds in turn: a fallthrough would
   * let a string valid as two kinds resolve differently depending on which store
   * answered first — a nondeterministic identity.
   *
   * ⚠️ **`tenantId` is optional for an email or phone and LOAD-BEARING for a
   * username.** Usernames are unique per TENANT, not per realm — `alice` in two
   * orgs is routinely two people — so the issuer resolves the tenant as: this
   * field if present, else the tenant bound to the request's host. **Explicit
   * wins**, including when the two disagree: a partner BFF is server-side and
   * its Origin is its own, so an Origin-wins rule would make BFF-fronted
   * username login unimplementable without one host per org. Neither source
   * yielding one is `400 tenant_required` — a NAMED code, because it is an
   * integration mistake rather than a wrong password. The SDK does NOT guess.
   *
   * Every failure collapses to `401 invalid_credentials`. ⚠️ Except
   * `403 password_must_change`, which is NOT collapsed: the password was
   * CORRECT, but an administrator set it, so it is an assertion rather than a
   * proof and the holder must replace it through `PUT /me/password` first.
   * Saying "invalid credentials" there would send them to a reset flow that does
   * not exist.
   *
   * A `kind=service` account cannot hold a password (ADR-071).
   */
  async passwordLogin(req: {
    identifier: string;
    presented: string;
    tenantId?: string;
    origin?: string;
    /**
     * Change the password at sign-in (SPEC §4.1.8): set it ONLY after a
     * `403 password_must_change`, with `presented` = the CURRENT (temporary)
     * password. Sent as `new_password`; an empty value is not sent. The SDK does
     * not pre-validate its length (the issuer owns the rule). Success is an
     * ordinary login that ends the holder's other sessions (ADR-104 R-e): each
     * is written into the session store and listed in `revokedSids`. A 5xx may
     * leave the NEW password in force: retry with `presented` = the new
     * password and no `newPassword`. Never retried by the SDK.
     */
    newPassword?: string;
  }): Promise<LoginResponse> {
    const headers = await this.originHeaders(req.origin);
    const raw = await this.http.request<RawAuthResponse>({
      method: "POST",
      path: "/auth/login",
      headers,
      body: {
        realm_id: this.realmId,
        grant_type: "password",
        identifier: req.identifier,
        presented: req.presented,
        ...(req.newPassword ? { new_password: req.newPassword } : {}),
        ...(req.tenantId ? { tenant_id: req.tenantId } : {}),
      },
    });
    const session = mapAuthResp(raw);
    // ADR-104 R-e: /auth/login is `raw(...)` (bare), so `revoked_sids` is top-level.
    session.revokedSids = sessionIds(raw.revoked_sids);
    await this.revokeSessions(session.revokedSids);
    // ADR-102 D10 — same mint rule as `login`: once the tenant is settled the
    // product-roles handler runs and the session is re-minted. A password login
    // is a login, so it must not be the one lane returning a role-blind token.
    const settled = settledTenant(session);
    if (settled) await this.mintOrThrowWithAnchor(session, settled, "password");
    return session;
  }

  /**
   * ADR-117 D6 — is an invitation sign-up link still usable? Anonymous: the
   * token is the credential, sent in the POST body only (never a URL) and never
   * logged. Writes and consumes nothing, so a page can show "invalid" BEFORE
   * asking for a username. Every dead link (unknown, used, expired, superseded,
   * withdrawn, membership no longer invited) is ONE code, `invalid_invitation_token`
   * (400): there is no oracle to tell them apart.
   */
  async inspectInvitation(token: string): Promise<InvitationInspection> {
    const raw = await this.http.request<unknown>({
      method: "POST",
      path: "/auth/invitations/inspect",
      body: { token },
    });
    const d = unwrapData<{ tenant_id?: unknown; tenant_display_name?: unknown; expires_at?: unknown }>(raw) ?? {};
    return {
      tenantId: String(d.tenant_id ?? ""),
      tenantDisplayName: String(d.tenant_display_name ?? ""),
      expiresAt: String(d.expires_at ?? ""),
    };
  }

  /**
   * ADR-117 D6 — accept an invitation from its sign-up link: creates the
   * username and password, activates the invited membership and SIGNS THE PERSON
   * IN. The answer is EXACTLY a `passwordLogin` answer from the same completion
   * code (same {@link LoginResponse}): a session, or an MFA challenge /
   * first-login enrolment, so handle it as you handle `passwordLogin` (every MFA
   * floor and session limit applies). Accepting never proves the email.
   *
   * Errors: `invalid_invitation_token` (400, as on inspect), `invalid_username`,
   * `password_too_short` / `password_too_long` (400, checked BEFORE the token is
   * looked up, so the link is not burned; via `details.server_code`),
   * `identifier_collision` (409, username taken in that org; via
   * `details.server_code`). The password is a secret and is never logged.
   */
  async acceptInvitation(req: { token: string; username: string; password: string }): Promise<LoginResponse> {
    const raw = await this.http.request<RawAuthResponse>({
      method: "POST",
      path: "/auth/invitations/accept",
      body: { token: req.token, username: req.username, password: req.password },
    });
    const session = mapAuthResp(raw);
    session.revokedSids = sessionIds(raw.revoked_sids);
    await this.revokeSessions(session.revokedSids);
    const settled = settledTenant(session);
    if (settled) await this.mintOrThrowWithAnchor(session, settled, "password");
    return session;
  }

  /**
   * SPEC §4.10 (ADR-111) — is a reset-link token still usable? Writes nothing,
   * so a page can show invalid / expired / used / superseded BEFORE asking for a
   * password. A 200 is not a reservation.
   *
   * The token goes in the POST body only, never a query string, and is never
   * logged. The SDK sends its platform bearer as on every auth call, which pins
   * the call to the configured realm: a link minted in another realm answers
   * `reset_token_invalid`. Parsing the token out of the link's URL fragment is
   * the page's job. Errors: `reset_token_invalid`, `reset_token_expired`,
   * `reset_token_used`, `reset_token_superseded`.
   */
  async inspectPasswordReset(token: string): Promise<PasswordResetInspection> {
    const raw = await this.http.request<unknown>({
      method: "POST",
      path: "/auth/password/reset/inspect",
      body: { token },
    });
    return { expires_at: String(unwrapData<{ expires_at?: unknown }>(raw)?.expires_at ?? "") };
  }

  /**
   * SPEC §4.10 (ADR-111) — set the password a reset link was sent for. Mints NO
   * session: send the holder to `passwordLogin`, where every MFA and eligibility
   * gate lives. The SDK does not know the identifier and must not chain a login
   * onto a consume.
   *
   * NEVER retried by the SDK: a consume replayed after a lost response answers
   * `reset_token_used` even though the password WAS set. A page that gets
   * `reset_token_used` right after its own submit should say "your password may
   * already be set — try signing in". Length rules are the issuer's
   * (`password_too_short` / `password_too_long` arrive as
   * `details.server_code`); the SDK does not pre-validate. The token and
   * `newPassword` are secrets and are never logged.
   *
   * ADR-104 R-e: the consume ends every session of the person in the realm; the
   * response's `revoked_sids` are written into the session store before this
   * resolves (a store write error is logged, never thrown, as in `logout`).
   */
  async consumePasswordReset(token: string, newPassword: string): Promise<PasswordResetConsumed> {
    const raw = await this.http.request<unknown>({
      method: "POST",
      path: "/auth/password/reset",
      body: { token, new_password: newPassword },
    });
    const revokedSids = sessionIds(unwrapData<{ revoked_sids?: unknown }>(raw)?.revoked_sids);
    await this.revokeSessions(revokedSids);
    return { revokedSids };
  }

  /**
   * Writes each session id into the session store (and the revocation cache),
   * like `logout` does. Never throws on a store failure.
   * @internal `realm.me.setPassword` uses it (ADR-104 R-e).
   */
  async revokeSessions(ids: readonly string[]): Promise<void> {
    for (const id of ids) await this.revokeLocally(id);
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
    /** See {@link MfaVerifyRequest.refreshToken}. */
    refreshToken?: string;
  }): Promise<LoginResponse> {
    return this.mfaVerify({
      challengeToken: req.mfaToken,
      code: req.presented,
      method: "otp",
      origin: req.origin,
      refreshToken: req.refreshToken,
    });
  }

  /**
   * SPEC §4.3 — complete an MFA challenge. Same response shape as login. Given
   * `req.refreshToken` it runs under the per-session refresh lock (go `0.64.2`).
   */
  async mfaVerify(req: MfaVerifyRequest): Promise<LoginResponse> {
    return this.underSessionLock(req.refreshToken, async () => {
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
      return this.finishMfaSession(raw, "mfa_verify");
    });
  }

  /**
   * SPEC §4.3a — complete an MFA challenge with a single-use RECOVERY code in
   * place of the TOTP code (`POST /auth/mfa/recovery`, ADR-077 §2). Post-verify
   * handling is identical to {@link mfaVerify}, under flow `"mfa_recovery"`. The
   * code is consumed and the returned session has `reenrollRequired` set: the old
   * authenticator is cleared, so send the user to re-enroll. Errors: `401` for an
   * invalid challenge or code, `429` `mfa_too_many_fails`. Given `req.refreshToken`
   * it runs under the per-session refresh lock (go `0.64.2`).
   */
  async redeemRecoveryCode(req: RedeemRecoveryCodeRequest): Promise<LoginResponse> {
    return this.underSessionLock(req.refreshToken, async () => {
      const headers = await this.originHeaders(req.origin);
      const raw = await this.http.request<RawAuthResponse>({
        method: "POST",
        path: "/auth/mfa/recovery",
        headers,
        body: {
          realm_id: this.realmId,
          mfa_challenge_token: req.challengeToken,
          code: req.code,
        },
      });
      return this.finishMfaSession(raw, "mfa_recovery");
    });
  }

  /** The post-verify handling shared by every lane that completes an MFA challenge. */
  private async finishMfaSession(raw: RawAuthResponse, flow: AuthFlow): Promise<LoginResponse> {
    const session = mapAuthResp(raw);
    // ADR-102 D10 — a step-up issues the token the user carries for the rest of
    // the session, so it is the LAST lane that may hand back a claim-blind one.
    // Without this, a partner who requires MFA has every human denied by their
    // own ScopePolicy gate immediately after passing the second factor.
    const mfaSettled = settledTenant(session);
    if (mfaSettled) await this.mintOrThrowWithAnchor(session, mfaSettled, flow);
    return session;
  }

  /** SPEC §4.4 — revoke the supplied (or current) refresh token.
   *  When req.accessToken is set AND the Realm has a RevocationCache
   *  wired, the access token's jti is added to the cache on success
   *  (ADR-041 follow-up). Failure to push to the cache does NOT fail
   *  the logout call; the server-side refresh revocation is the
   *  load-bearing operation. */
  async logout(req?: LogoutRequest): Promise<{ status: string; sid?: string; revoked_sids?: string[] }> {
    // SPEC §10.1 step 3a: the session to revoke is named by the ISSUER's
    // response (`sid`, and `revoked_sids` for all=true). Only when it names
    // none — an older issuer, or the call failed — does a VERIFIED, UNEXPIRED
    // bearer stand in. Anything else revokes nothing locally.
    const headers = await this.originHeaders(req?.origin);
    let out: { status: string; sid?: string; revoked_sids?: string[] } | undefined;
    let failure: unknown;
    try {
      out = await this.http.request<{ status: string; sid?: string; revoked_sids?: string[] }>({
        method: "POST",
        path: "/auth/logout",
        headers,
        body: {
          realm_id: this.realmId,
          refresh_token: req?.refreshToken,
          ...(req?.all ? { all: true } : {}),
        },
      });
    } catch (e) {
      failure = e;
    }
    const sids = new Set<string>();
    if (out) {
      if (typeof out.sid === "string" && out.sid) sids.add(out.sid);
      if (Array.isArray(out.revoked_sids)) {
        for (const id of out.revoked_sids) if (typeof id === "string" && id) sids.add(id);
      }
    }
    if (this.session) {
      if (sids.size > 0) {
        for (const id of sids) await this.revokeLocally(id);
      } else if (req?.accessToken) {
        await this.revokeFromBearer(req.accessToken);
      }
    }
    if (failure !== undefined) throw failure;
    return out as { status: string };
  }

  /**
   * SPEC §10.1 step 3a fallback with no issuer call: revoke the session of a
   * VERIFIED, UNEXPIRED bearer; anything unverifiable revokes nothing.
   * @internal the middleware's logout route uses it when no refresh token exists.
   */
  async revokeFromBearer(accessToken: string): Promise<void> {
    if (!this.session) return;
    try {
      await this.session.verify(accessToken); // full verify, expiry included
      const { sessionKey } = (await import("./revocation.js")).peekJwtRevokeFields(accessToken);
      await this.revokeLocally(sessionKey);
    } catch {
      // unverifiable / expired / typed wrong: revoke nothing locally.
    }
  }

  private async revokeLocally(sessionKey: string): Promise<void> {
    if (!sessionKey || !this.session) return;
    await this.session.tokens.revokeSession(sessionKey);
    if (this.revocation) {
      try {
        await this.revocation.revoke(sessionKey, this.session.now() + 24 * 60 * 60 * 1000);
      } catch {
        // Cache failure does not fail logout; server-side refresh revocation is load-bearing.
      }
    }
  }

  /** SPEC §4.5 — server-side revoke of a specific session id. */
  async revokeSession(sessionId: string): Promise<void> {
    await this.http.request({
      method: "DELETE",
      path: `/auth/sessions/${encodeURIComponent(sessionId)}`,
      requireActor: true,
    });
  }

  /**
   * SPEC §4.6 — sessions for the user identified by `userBearer`.
   *
   * Returns a {@link Paginated} handle, the same shape `federationBindings.list()`
   * uses and the direct counterpart of Java's `Paginated<Session>` and Go's
   * `iter.Seq2` iterator. Iterate it to walk EVERY session (the SDK follows
   * `next_cursor` for you), or call `.page(opts)` for exactly one page:
   *
   * ```ts
   * for await (const s of realm.auth.listSessions(jwt)) { ... }
   * const first = await realm.auth.listSessions(jwt).page({ limit: 50 });
   * ```
   *
   * BREAKING in 0.37.0 — this returned `Promise<SessionInfo[]>` through
   * `0.36.0`, and that array was the FIRST PAGE ONLY (server default 50). Past
   * that a caller silently saw a truncated list, which is worse than a wrong
   * one: "sign out everywhere" and "revoke that device" are the controls people
   * reach for when they believe they are compromised, and a session missing
   * from the list is a session they cannot act on. The break is deliberate and
   * loud — a compile error with an obvious fix — rather than the same call
   * quietly returning a different number of rows.
   */
  listSessions(opts?: PageOpts): Paginated<SessionInfo> {
    return paginate<SessionInfo>(async (po) => {
      const raw = await this.http.request<unknown>({
        method: "GET",
        path: "/auth/sessions",
        requireActor: true,
        query: { cursor: po.cursor, limit: po.limit ?? opts?.limit },
      });
      return readSessionPage(raw);
    });
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
      requireActor: true,
      body: { code: req.code },
    });
  }

  /**
   * Revoke all sessions for the current user — `DELETE /auth/sessions`.
   * Escort form like `revokeSession` (R60): the actor rides in X-User-Token. No request body.
   * Returns void; the server's `{ status: "ok" }` ack is ignored. The server rejects
   * revocation-class tokens with `insufficient_scope`, surfaced as a RealmError.
   */
  async revokeAllSessions(_req?: RevokeAllSessionsRequest): Promise<void> {
    await this.http.request({
      method: "DELETE",
      path: "/auth/sessions",
      requireActor: true,
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
  async mintMfaChallenge(_req?: MfaChallengeMintRequest): Promise<MfaChallengeMintResponse> {
    interface Wire { mfa_challenge_token?: string; methods?: string[] }
    let raw: Wire;
    try {
      raw = await this.http.request<Wire>({
        method: "POST",
        path: "/auth/mfa/challenge",
        requireActor: true,
        // Empty body — X-User-Token identifies user, session, and realm.
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
  async listAuthenticators(_req?: ListAuthenticatorsRequest): Promise<AuthenticatorList> {
    return this.http.request<AuthenticatorList>({
      method: "GET",
      path: "/auth/mfa/authenticators",
      requireActor: true,
    });
  }

  /**
   * Regenerate the current user's recovery codes — `POST
   * /auth/mfa/recovery/regenerate`, invalidating the previous set. Requires a
   * CONFIRMED enrollment (RealmError conflict, `not_enrolled`) and a FRESH TOTP
   * within the elevated window (RealmError mfa_required, 412, until re-verified).
   * Codes are shown once and also emailed (ADR-079).
   */
  async regenerateRecoveryCodes(_req?: RegenerateRecoveryCodesRequest): Promise<RecoveryCodesResult> {
    return this.http.request<RecoveryCodesResult>({
      method: "POST",
      path: "/auth/mfa/recovery/regenerate",
      requireActor: true,
    });
  }

  private async originHeaders(perCall?: string): Promise<Record<string, string>> {
    const o = await this.resolveOrigin(perCall);
    return o ? { origin: o } : {};
  }
}

/** Result of `auth.inspectPasswordReset` (SPEC §4.10): the link's expiry, as the wire sends it. */
export interface PasswordResetInspection {
  expires_at: string;
}

/**
 * Result of `auth.consumePasswordReset`. `revokedSids` (ADR-104 R-e) are the
 * sessions the issuer ended (the whole identity in the realm); the SDK has
 * already written each into the session store. Empty when none ended or the
 * issuer predates the field.
 */
export interface PasswordResetConsumed {
  revokedSids: string[];
}

/** De-duplicated, non-empty string members of a wire `revoked_sids`; anything that is not a list yields none. */
export function sessionIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const id of v) if (typeof id === "string" && id && !out.includes(id)) out.push(id);
  return out;
}

function mapAuthResp(r: RawAuthResponse): LoginResponse {
  return {
    // R44/R51: a sign-in answer authenticates and hands back the refresh token; the SDK NEVER reads
    // an `access_token` from it. Every access token comes from /auth/token (or /auth/token/partial).
    accessToken: "",
    refreshToken: r.refresh_token,
    expiresIn: r.expires_in,
    refreshExp: r.refresh_exp,
    idleTtl: r.idle_ttl,
    expiresAt: r.expires_at,
    initiatedByUserId: r.initiated_by_user_id,
    user: r.user,
    tenantId: r.tenant_id,
    role: r.role,
    // `tenant_id` is the wire field; `id` is accepted as a fallback for older
    // and mocked issuers, matching the Go SDK's TenantRef.IDLegacy.
    tenants: (r.tenants ?? []).map((t) => ({
      id: t.tenant_id ?? t.id ?? "",
      role: t.role,
      displayName: t.display_name,
      mfaRequired: t.mfa_required,
    })),
    reenrollRequired: r.reenroll_required,
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

/** Result of `auth.inspectInvitation` (ADR-117 D6): what the sign-up page shows before asking for a username. */
export interface InvitationInspection {
  tenantId: string;
  tenantDisplayName: string;
  /** RFC 3339, as the wire sends it. */
  expiresAt: string;
}
