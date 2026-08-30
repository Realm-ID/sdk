/**
 * @realm-id/web — browser SDK for RealmID.
 *
 * Talks only to the partner's BFF (per ADR-052). Holds in-memory access
 * tokens; refresh credentials live in an httpOnly cookie set by the BFF.
 *
 * Quick start:
 *   import { createRealm } from "@realm-id/web";
 *   const realm = createRealm({ baseUrl: "https://api.partner.com" });
 *   await realm.ready();
 *   const { providers } = await realm.providers();
 *   await realm.login({ method: "google", providerToken });
 *   const res = await realm.fetch("/api/orders");
 *
 * Partner BFFs whose wire shape diverges from BFF-SPEC.md plug in
 * `adapters` and `gates`. See @realm-id/web-bff-realmid for a worked
 * example against the realmid.dev reference BFF.
 */

export { createRealm, Realm } from "./realm.js";
export type { FetchOptions } from "./realm.js";

export { RealmError, classifyHttpStatus, extractMessage, pluckPath, DEFAULT_CODE_PATHS } from "./errors.js";
export type { ErrorCode } from "./errors.js";

export { resolveExpiresIn, parseExpiresAt } from "./util.js";

export type {
  AdapterContext,
  AuthEvent,
  AuthState,
  AuthStatus,
  CSRFConfig,
  Endpoints,
  GateCode,
  GateRule,
  IdentityProvider,
  LoginMethod,
  LoginRequest,
  LoginResponse,
  MeResponse,
  ProvidersResponse,
  RealmConfig,
  RefreshConfig,
  RequestAdapters,
  ResponseAdapters,
  TenantRef,
  TokenResponse,
  UserSummary,
} from "./types.js";

export { DEFAULT_ENDPOINTS } from "./types.js";

export {
  memoryStorage,
  localStorageAdapter,
  sessionStorageAdapter,
  DEFAULT_STORAGE_KEY,
} from "./storage.js";
export type { StorageAdapter, StoredSession } from "./storage.js";

/**
 * The GoFr wire envelope (SPEC §3.1). `@realm-id/sdk` owns this contract; the
 * copy here exists because this package has zero runtime dependencies, and
 * `envelope.test.ts` holds the two identical.
 */
export { unwrapData, parseErrorEnvelope } from "./envelope.js";
export type { ErrorEnvelope } from "./envelope.js";

/**
 * Operation step-up MFA (ADR-096 D8) — wrap the `fetch` you pass to
 * `createRealm` and every gated call answers its own 412.
 */
export { withStepUpRetry } from "./stepup.js";
export type {
  StepUpChallenge,
  StepUpDeps,
  StepUpFetch,
  StepUpPrompt,
  StepUpVerifyResponse,
} from "./stepup.js";

/** Membership self-service (ADR-092 D5) + its error CODE taxonomy. */
export {
  createMemberships,
  MEMBERSHIP_ACTION_CODES,
  membershipActionCode,
  isMembershipActionCode,
} from "./memberships.js";
export type {
  Memberships,
  MembershipsOptions,
  MembershipActionCode,
  MembershipActionResult,
  TenantChoiceResult,
} from "./memberships.js";

/** The pre-session revocation-token flow behind the session-limit 412 gate. */
export { createRevocationSessions } from "./revocation-sessions.js";
export type {
  RevocableSession,
  RevocationSessions,
  RevocationSessionsOptions,
} from "./revocation-sessions.js";

/** The realm-fetch slice the two clients above need; structural on purpose. */
export type { RealmFetchLike } from "./bff-call.js";
