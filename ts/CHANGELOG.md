# Changelog — `@realm-id/sdk` (TypeScript)

All notable changes to the TypeScript SDK. Ships with a language-prefixed
tag (`ts-vX.Y.Z`). The monorepo-level `../CHANGELOG.md` records
cross-cutting items affecting every SDK at once.

> **Gap notice (2026-08-06):** entries for `0.29.0`–`0.35.0` are MISSING — this
> file jumps from `0.28.0` straight to `0.36.0` below. The releases happened;
> only their changelog entries don't exist. Backfilling them from the
> version-bump commits is filed in `../TODO.md`. Same shape as the
> `web-admin` `0.8.13`–`0.8.17` gap backfilled on 2026-08-03: a changelog stops
> being trustworthy the moment it silently skips, because a reader cannot tell
> "nothing shipped" from "nobody wrote it down".

## 0.37.0 — `login({ deviceName })` sends `X-Device-Name` (2026-08-21)

ADR-062's device label was half-implemented in TS: `SessionInfo.device_name`
carried the READ half from the start, and nothing ever SENT the header, so a TS
consumer could display a device label it had no way to set. `sdk/TODO.md`
recorded this gap as Java-only; that was wrong, and it went unnoticed because
the read half is the visible one.

`LoginRequest.deviceName` is optional and rides as the `X-Device-Name` header on
the user grant only — never on the platform bootstrap, which is an M2M mint the
issuer records no device for, and never in the body. Absent means **no header**:
the issuer reads a present empty value as a supplied label. The server caps the
value at 120 chars and strips control characters (`sanitizeDeviceName`), so the
SDK sends it raw.

## 0.36.0 — read one platform's fleet row by id (2026-08-06)

`AdminClient.getPlatform(id)` wraps `GET /admin/platforms/{id}` (issuer
`v0.87.0`, spec `0.24.0`) — the singular counterpart of `listPlatforms`,
returning the identical `PlatformSummary` fleet row for one platform. The
issuer resolves it through the same store query and the same serializer as the
list, so a detail screen built on this cannot disagree with the fleet table.

**Why it matters beyond convenience.** The alternative it replaces is paging
the list and matching client-side, which is bounded by whatever page budget the
caller picks — so a platform past that budget is reported as **not found
although it exists**. The console was doing exactly this with a 20-page cap
(2000 rows), a false negative that arrives on its own as a fleet grows.

*(An earlier draft of this entry said the console rendered such a platform as a
plausible empty one with no error. That was inherited from a stale `ui/TODO.md`
note and is incorrect — the screen has always rendered a "Platform not found"
empty state. Corrected here rather than quietly dropped, since the wrong
description had already been copied into two repos.)*

**A `404` here means "not visible to you" OR "never existed", identically, and
must stay that way.** A platform the caller may not see returns the same
`platform_not_found` as an unissued id — never `403` — because a distinct
refusal would confirm the id is live (issuer `DECISIONS.md` 2026-08-06). Do not
re-label it as a permission error in a consumer: rendering "you don't have
access to this platform" reconstructs the oracle the identical 404 exists to
close.

**Taxonomy note:** `platform_not_found` is not in the curated `ErrorCode`
union (nor Go's, nor Java's), so it normalizes to `not_found` with
`httpStatus: 404`. That is the current contract across all three SDKs;
widening the taxonomy is a lockstep SPEC change, filed in `../TODO.md`.

Additive — no existing behaviour changes.

## 0.28.0 — owner-required tenant create + BYO id/created_at (2026-07-24)

`TenantsClient.create` now provisions the org and its owner in one call
(ADR-073 Amendment C, SPEC §6.1). `TenantCreate` gains `owner` (new
`TenantOwner` type — **required on a genuine create**; server returns
`owner_required` otherwise), `id` (bring-your-own tenant UUID, reconciles when
known), and `createdAt` (RFC3339). `ImportUserRow` gains optional `createdAt`
("member since"). Additive wire; the `owner` requirement is the one breaking
change for the create-empty-then-invite flow. See `../CHANGELOG.md`.

## 0.26.0 — role principal typing + invitation scope (2026-07-22)

Types `assignable_to` (ADR-081) and `can_invite_roles` (ADR-076 WP4) on
`RoleObject` / `RoleCreate` / `RolePatch`, plus the read-only
`migrated_holders` / `migrated_holders_to` the issuer returns when a narrowing
PATCH reassigns a role's human holders. New exported `PrincipalKind =
"human" | "service"` union — the server vocabulary is closed, so a typo should
fail at compile time. Additive; no SPEC change. See `../CHANGELOG.md` for the
cross-SDK entry.

## 0.24.0 — ADR-080 Phase B + session-revoke + MFA-self parity (2026-07-20)

Additive parity port of the Go reference SDK (issuer v0.50.0). No SPEC break.

- **Contact-binding (ADR-080 Part 2/3):** `users.delinkContact(tenantId, userId,
  contactId)` and `users.handBack(tenantId, userId, fromUserId)`. `driftReviews.reject`
  is now the SOFT (non-destructive) reject; new `driftReviews.rejectHard` parks the
  account. `DriftRejectResult` reshaped to `{ id, status, mode, parked?, revoked_bindings? }`
  (the old `new_user_id`/`original_value` fields are removed — the reject no longer
  forks a user).
- **Session-revoke (ADR-080):** new `realm.sessions` client — `revokeUser(tenantId,
  userId)` (admin force-logout) and `revokeAll()` (realm-wide mass logout). Distinct
  from `auth.revokeAllSessions` (the caller's own sessions).
- **MFA self-service:** `auth.listAuthenticators()` and `auth.regenerateRecoveryCodes()`
  (the latter may surface `mfa_required` (412) step-up or `conflict`/`not_enrolled`).
- **Error code:** `contact_admin_required` (409) added to the `ErrorCode` union +
  KNOWN_CODES so `isCode()` matches it on login.

## 0.22.1 — fix: auth.login wire body mismatch (2026-07-15)

Bug fix, no SPEC change. `auth.login` was posting
`{ method, provider_token }` — the issuer's `/auth/login` handler reads
`grant_type`/`provider`/`token` and never had a `provider_token` field, so
the provider credential silently never reached the server; `method` rode
the deprecated `legacyMethodToGrant` shim (Sunset 2026-08-01). Now sends
`{ grant_type: "provider_token", provider, token }`, mirroring the Go
reference SDK (`sdk/go/auth.go`). See `sdk/DECISIONS.md`.

## 0.20.0 — service accounts + OTP-login cutover + sources (ADR-071/072) (2026-07-14)

Additive parity port of the go reference SDK (WP6). See `../CHANGELOG.md`.

- **OTP login grant cutover** — `auth.otpLogin` now sends `grant_type: "otp"`
  on `POST /auth/login` (was `method: "otp_internal"`; ADR-071 §4 direct
  cutover, no dual-accept). `auth.mfaVerifyOtp` sends `method: "otp"`.
- **`otp.issue` gains `deliveryMode`** (`"view_bff"`, exported
  `DELIVERY_MODE_VIEW_BFF` / `OtpDeliveryMode`), threaded onto the body as
  `delivery_mode`.
- **`LoginResponse.initiatedByUserId`** — decodes the issuer's
  `initiated_by_user_id` provenance (the owner/admin who minted a service
  account's login OTP, ADR-071 §8).
- **`realm.serviceAccounts`** (new `ServiceAccountsClient`) — `create` / `list`
  / `get` / `resetHandle` / `suspend` / `unsuspend` / `deactivate` / `revoke`
  over `/tenants/{id}/service-accounts`.
- **`realm.sources`** (new `SourcesClient`, ADR-072) — `list` / `create` /
  `update` / `delete` over `/sources`.
- **New error codes** on `RealmError.code`: `handle_taken`, `invalid_role`,
  `service_account_not_found`, `not_service`, `method_violates_kind`,
  `source_not_found`, `user_not_found`.

## 0.19.0 — roles disable/enable + owner signing-keys client (2026-07-13)

Additive. Parity for the issuer v0.32.0 roles/signing-keys overhaul.

- **`RolesClient`** gains `disable(roleId)` / `enable(roleId)`; `RoleObject`
  gains `disabled` / `disabled_at`; `RoleListOpts` gains `includeSystem`
  (→ `?include_system=true`).
- **`SigningKeysClient`** (new, `realm.signingKeys`) — `list()` returns the
  keyring + rotation policy (`{ keys, rotation }`); `rotate()` self-serve
  rotates and returns `{ kid, retired_kids }`. Owner-scoped
  (`/platforms/{id}/signing-keys`).
- **`TenantConfigPatch`** — typed `updateConfig` body for the org-governance
  keys (`role_overrides`, `default_invitation_role`).
- Re-exported from `@realm-id/sdk/internal` for `@realm-id/web-admin`.

## ts-v0.18.0 — `idle_ttl` on login + token responses (ADR-070, 2026-07-10)

Additive. `LoginResponse` and `TokenResponse` now carry `idleTtl?` (wire
`idle_ttl`, seconds) — the sliding-window idle-timeout **duration** for the
session (ADR-070). `undefined`/`0` means no idle timeout; the BFF reads it to
enforce a per-realm idle window. Cut in lockstep with the go + java SDKs
(`../CHANGELOG.md` / `../DECISIONS.md` 2026-07-10). Version/tag picked centrally.

## 0.17.0 — `refresh_exp` on login + token responses

Additive. `LoginResponse` and `TokenResponse` now carry `refreshExp?` (wire
`refresh_exp`, unix seconds) — the refresh token's absolute expiry (SPEC §4.1).
`undefined` against a pre-refresh_exp issuer; consumers sizing a session from it
must fall back to a local ceiling. Cut in lockstep with go/v0.26.0 +
java-v0.15.0 (`../CHANGELOG.md` / `../DECISIONS.md` 2026-07-09).

## 0.16.1 — decode session last-used from `last_seen_at`

Fix. `listSessions` cast raw server JSON with no snake→camel mapping, so
`SessionInfo.lastUsedAt`/`createdAt` were never populated. Realigned the
`SessionInfo` interface to the issuer wire shape (`last_seen_at`, `created_at`,
`origin`, `device_name`; int64 unix seconds). Cut in lockstep with go/v0.25.1 +
java-v0.14.1 (`../CHANGELOG.md`).

## 0.16.0 — IdP provider `config` on the admin write surface

Additive. Mirrors the monorepo lockstep entry (`../CHANGELOG.md`, cut with the
Go + Java SDKs). `identityProviders` create/update now carry a `config` object
(provider-specific settings — e.g. Microsoft tenant/authority, Google hosted
domain) alongside the existing `type` / `client_id` fields, so a platform owner
can configure an IdP row's provider settings through the SDK rather than only
issuer-side.

## 0.15.0 — Refresh-authed MFA self-enrollment (ADR-061)

Breaking. Mirrors the monorepo lockstep entry (`../CHANGELOG.md`, cut with
`go/v0.18.0` + `java-v0.13.0` + web bff-realmid 0.3.3).

### Changed (breaking)
- `auth.selfEnrollMfa({ refreshToken, tenantId, method? })` replaces
  `enrollMfa` + `confirmMfa`. Posts to `POST /auth/mfa/enroll` and returns
  `{ secret, qrUrl, recoveryCodes, mfaChallengeToken, tenantId }`. The
  enroll-scoped `mfaChallengeToken` is completed via `mfaVerify` — one
  verify confirms the new secret **and** mints tokens. `enrollMfa`,
  `confirmMfa`, and `ConfirmMfaRequest` are removed; `MfaEnrollment` gained
  `mfaChallengeToken` + `tenantId`.

### Known issue
- `recoveryCodes` are returned but not yet redeemable (no issuer redemption
  path); do not present them as a recovery mechanism until the follow-up
  ships.

## 0.14.0 — workload identity federation (2026-06-02)

Additive (non-breaking). Implements SPEC v0.10.0 §4.0.1 (ADR-057).

### Added
- `CredentialSource` abstraction for the platform-session bootstrap, plus
  built-in sources `staticApiKey`, `googleWorkloadIdentity`,
  `githubActionsOidc`, and a zero-config auto-detect.
- `RealmConfig.credential` to pin a source explicitly. `RealmConfig.apiKey`
  is now sugar for `staticApiKey(apiKey)` and **optional** — when both are
  unset the SDK auto-detects an ambient workload identity (GCP / GitHub
  Actions) and exchanges its OIDC token via
  `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`.

## Unreleased

Additive (non-breaking surface) plus one wire-shape correction on
`apiKeys`. Mirrors the Go SDK and SPEC v0.7.0 §3.1 / §4.2.1 / §6.5.

### Added

- **Token manager** (SPEC §4.2.1): `realm.auth.newTokenManager(refreshToken,
  { tenantId?, refreshSink?, clock? })` returns a `TokenManager` for
  long-lived single-identity clients (desktop apps, sync agents, daemons)
  that hold one refresh token. `accessToken()` returns a cached token while
  it has ≥60s of life, otherwise mints a new one via `POST /auth/token`.
  Concurrent `accessToken()` calls single-flight onto one shared in-flight
  refresh (one-time-use refresh tokens must never be presented twice in
  parallel). The optional `refreshSink` is awaited with
  persist-before-return semantics: the rotated refresh token is committed to
  memory first, then handed to the sink; only if the sink resolves is the
  new access token cached and returned. A `refresh_invalid` response is
  terminal — surfaced verbatim, never retried or fallen back on.
- **`refresh_invalid` error code** (SPEC §3.1): added to the `ErrorCode`
  taxonomy and the HTTP error decoder's known-code allowlist, so a server
  `refresh_invalid` (returned by `POST /auth/token` when the refresh token is
  expired, revoked, or reuse-detected) is surfaced as
  `RealmError({ code: "refresh_invalid" })` rather than a generic
  `unauthorized`.

### Changed

- **`apiKeys` DTO alignment** (SPEC §6.5, issuer-authoritative — "code
  wins"): `ApiKey` now mirrors the issuer `APIKey` / `APIKeyListItem` wire
  shapes. Create returns `{ id, value, scope, label }` (the one-time secret
  is `value`, **not** `secret`); list rows are `{ id, prefix, role,
  created_at, last_used_at, revoked_at }` (`role` is a singular string,
  **not** a `scopes` array; the `*_at` fields are unix-seconds numbers,
  with `last_used_at` / `revoked_at` nullable). `ApiKeyCreate` is now
  `{ scope, label? }` (**not** `displayName` / `scopes`). `list()` accepts
  the issuer `{ items, next_cursor, total }` envelope and tolerates a flat
  array or legacy `{ api_keys }` envelope. Added `isApiKeyRevoked(key)`
  helper (mirrors Go's `APIKey.Revoked()`).
