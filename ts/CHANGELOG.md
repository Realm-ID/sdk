# Changelog — `@realm-id/sdk` (TypeScript)

All notable changes to the TypeScript SDK. Ships with a language-prefixed
tag (`ts-vX.Y.Z`). The monorepo-level `../CHANGELOG.md` records
cross-cutting items affecting every SDK at once.

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
