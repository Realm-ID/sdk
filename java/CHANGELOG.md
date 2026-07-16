# Changelog — `dev.realmid:sdk` (Java)

All notable changes to the Java SDK. Ships with a language-prefixed tag
(`java-vX.Y.Z`). The monorepo-level `../CHANGELOG.md` records cross-cutting
items affecting every SDK at once.

## java-v0.22.0 — fix: tenants().create route + body alignment (2026-07-16)

Source-breaking fix. `tenants().create` posted to `POST /tenants` with
`{display_name, owner_user_id?, config?}` — no such route exists (404 against
the live issuer), and neither `owner_user_id` nor `config` is accepted on
create. Now issues the contract call `POST /platforms/{realmId}/tenants` with
`{display_name, allowed_domains?, signup_mode?}`, matching SPEC §6.1 / swagger
and the Go + TS SDKs. `TenantCreate` is now `(displayName, allowedDomains,
signupMode)` — the removed `ownerUserId`/`config` accessors are a compile-break
for any caller that set them (the old call could never have succeeded).
Ownership is set via the seat/invite path + `PUT …/owner`; per-tenant config via
`PATCH …/config`. Two pinning tests guard the route/body + the retired keys.
See `../DECISIONS.md`.

## java-v0.21.0 — parity batch: S-03/04/05/06/07 + WP6 (2026-07-15)

Additive parity port (changelog backfill — the tag shipped without an entry).
`users.importUsers` (S-03, ADR-073), `tenants.updateUserRole` (S-04), IdP
discovery surface (S-05), federation-bindings client (S-06, ADR-057), list
filters `role`/`status`/`q` + invitation status (S-07), owner-transfer optional
params (WP6, ADR-076). See git log + `../CHANGELOG.md`.

## java-v0.20.1 — fix: AuthClient.login wire body mismatch (2026-07-15)

Bug fix, no SPEC change. `login()` was putting `method`, `token`, AND a
redundant `provider_token` — the issuer's `/auth/login` handler reads
`grant_type`/`provider`/`token`, never `provider_token`, and `method` rode
the deprecated `legacyMethodToGrant` shim (Sunset 2026-08-01). Now puts
`{ grant_type: "provider_token", provider, token }` only, mirroring the Go
reference SDK (`sdk/go/auth.go`). See `sdk/DECISIONS.md`.

## java-v0.20.0 — roles: required_mfa_methods write surface (ADR-075) (2026-07-15)

Additive port of the go/ts surface. See `../CHANGELOG.md`.

- **`RoleObject.requiredMfaMethods()`** decodes the role's ADR-075 MFA method set
  (`required_mfa_methods`, subset of `{"totp","otp"}`).
- **`RoleCreate` / `RolePatch` gain a `requiredMfaMethods` component**, forwarded
  as `required_mfa_methods` on create/patch. Back-compat constructors preserved
  (the 3-arg `RoleCreate` and 2-arg `RolePatch` still compile);
  `RolePatch.onlyRequiredMfaMethods(...)` added.
- No breaking change; the platform `mfa_policy` config key rides the generic
  realm-config PATCH (no new typed method).

## java-v0.19.0 — roles: listPermissions + delete migrate_to (ADR-074) (2026-07-14)

Additive port of the go/ts surface. See `../CHANGELOG.md`.

- **`roles().listPermissions()`** returns the live ADR-074 catalog
  (`GET /platforms/{id}/permissions`) as `List<Permission>`
  (`Permission{key, resource, action, label}`).
- **`roles().delete(roleId, migrateTo)`** overload forwards `?migrate_to=<name>`
  to reassign an in-use role's holders server-side instead of a 409.
- No breaking change; `RoleObject.permissions()` already existed.

## java-v0.18.0 — service accounts + OTP-login cutover + sources (ADR-071/072) (2026-07-14)

Additive parity port of the go reference SDK (WP6). See `../CHANGELOG.md`.

- **OTP login grant cutover** — `auth().otpLogin(...)` now sends
  `grant_type=otp` on `POST /auth/login` (was `method=otp_internal`; ADR-071 §4
  direct cutover, no dual-accept). `auth().mfaVerifyOtp(...)` sends `method=otp`.
- **`otp().issue(...)` gains delivery mode** — `OtpIssueRequest` gains a
  `deliveryMode` component (+ `withDeliveryMode(...)` and
  `DELIVERY_MODE_VIEW_BFF`), threaded onto the body as `delivery_mode`. The
  back-compat 5-arg constructor is preserved.
- **`Session.initiatedByUserId()`** — decodes the issuer's
  `initiated_by_user_id` provenance (ADR-071 §8).
- **`realm.serviceAccounts()`** (new `ServiceAccountsClient`) — `create` /
  `list` / `get` / `resetHandle` / `suspend` / `unsuspend` / `deactivate` /
  `revoke` over `/tenants/{id}/service-accounts`.
- **`realm.sources()`** (new `SourcesClient`, ADR-072) — `list` / `create` /
  `update` / `delete` over `/sources`.
- **New `ErrorCode` constants**: `HANDLE_TAKEN`, `INVALID_ROLE`,
  `SERVICE_ACCOUNT_NOT_FOUND`, `NOT_SERVICE`, `METHOD_VIOLATES_KIND`,
  `SOURCE_NOT_FOUND`, `USER_NOT_FOUND`.

## java-v0.17.0 — roles disable/enable + owner signing-keys client (2026-07-13)

Additive. Parity for the issuer v0.32.0 roles/signing-keys overhaul.

- **`RolesClient`** gains `disable(roleId)` / `enable(roleId)`; `RoleObject`
  gains `disabled()` / `disabledAt()`; `RoleListOpts` gains `includeSystem`
  (`RoleListOpts.includingSystem()`, → `?include_system=true`).
- **`SigningKeysClient`** (new, `realm.signingKeys()`) in package
  `dev.realmid.sdk.signingkeys` — `list()` returns `SigningKeysResponse`
  (`keys` + `rotation`); `rotate()` returns `RotateSigningKeyResult`
  (`kid` + `retiredKids`). Owner-scoped (`/platforms/{id}/signing-keys`).
- Per-tenant `updateConfig` already accepts an arbitrary config map — no
  change needed for `role_overrides` / `default_invitation_role`.

## java-v0.16.0 — `idle_ttl` on login + token responses (ADR-070, 2026-07-10)

Additive. `Session` and `TokenResponse` gain `idleTtl` (wire `idle_ttl`,
seconds, `long`) — the sliding-window idle-timeout **duration** for the session
(ADR-070). `0` means no idle timeout; the BFF reads it to enforce a per-realm
idle window. Cut in lockstep with the go + ts SDKs (`../CHANGELOG.md` /
`../DECISIONS.md` 2026-07-10). Version/tag picked centrally.

## 0.15.0 — `refresh_exp` on login + token responses

Additive. `Session` and `TokenResponse` gain `refreshExp` (wire `refresh_exp`,
unix seconds, `long`) — the refresh token's absolute expiry (SPEC §4.1). `0`
against a pre-refresh_exp issuer. Cut in lockstep with go/v0.26.0 + ts-v0.17.0
(`../CHANGELOG.md` / `../DECISIONS.md` 2026-07-09).

## 0.12.0 — workload identity federation (2026-06-02)

Additive (non-breaking). Implements SPEC v0.10.0 §4.0.1 (ADR-057).

### Added
- `CredentialSource` + `Credential` and the `CredentialSources` factory
  (`staticApiKey`, `googleWorkloadIdentity`, `githubActionsOidc`,
  `autoDetect`) for the platform-session bootstrap.
- `Realm.Builder.credential(...)` to pin a source explicitly.
  `Builder.apiKey(...)` is now sugar for `staticApiKey` and **optional** —
  when neither is set the SDK auto-detects an ambient workload identity
  (GCP / GitHub Actions) and exchanges its OIDC token via
  `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`.

## 0.11.0 — OTP surface parity + MFA-verify wire fix (2026-05-29)

Closes the two cross-language drifts where Java trailed Go (`go-v0.15.0`)
and TS (`ts-v0.13.0`): the entire OTP surface was missing, and MFA verify
sent the wrong wire field.

### Fixed

- **MFA verify wire field (breaking against a live issuer).** `mfaVerify`
  sent `challenge_token`; the issuer requires `mfa_challenge_token`
  (`MFAVerifyRequest required: [mfa_challenge_token, code]`). Go/TS were
  already correct. Every Java `mfaVerify` call previously 400'd. A new
  `AuthClientTest` body-assertion locks the field name.

### Added

- **OTP surface (SPEC §X)** — new `dev.realmid.sdk.otp` package: `OtpClient`
  (`issue` → `POST /auth/otp/issue`, `view` → `GET /auth/otp/{id}`,
  `verify` → `POST /auth/otp/verify`), wired as `realm.otp()`. Supports the
  dual-mode bearer trio (`userBearer` legacy / `userId` BFF +
  `X-On-Behalf-Of-User`), matching Go's `OTPClient`.
- `AuthClient.otpLogin(...)` (`POST /auth/login` with `method=otp_internal`)
  and `mfaVerifyOtp(...)`.
- Six OTP `ErrorCode`s: `INVALID_OTP`, `OTP_EXPIRED`, `OTP_LOCKED`,
  `OTP_NOT_FOUND`, `INVALID_PURPOSE`, `INVALID_SUBJECT_REF` (wire strings
  match Go/TS; decoded from nested `error.code`).
- Tests: `OtpClientTest` (8) + OTP cases in `AuthClientTest`. Full suite 100/100.

## 0.10.0 — token manager + refresh_invalid + api-key DTO + ADR-051 (2026-05-28)

Brings the Java SDK to parity with Go (`go-v0.15.0`) and TS (`ts-v0.13.0`)
for SPEC v0.8.0. Additive on the public auth surface, with one wire-shape
correction on `apiKeys` and the ADR-051 platform-auth migration (the latter
fixes a hard break against issuer ≥ v0.7.0).

### Added

- **Token manager** (SPEC §4.2.1): `realm.auth().newTokenManager(refreshToken)`
  / `newTokenManager(refreshToken, new TokenManagerOptions().tenantId(…)
  .refreshSink(…).clock(…))` returns a `TokenManager` for long-lived,
  single-identity clients (desktop apps, sync agents, daemons) that hold one
  refresh token. `accessToken()` returns a cached token while it has ≥60s of
  life, otherwise mints a new one via `POST /auth/token`. Concurrent
  `accessToken()` calls single-flight onto one shared in-flight refresh
  (one-time-use refresh tokens must never be presented twice in parallel —
  reuse-detection). The optional `RefreshSink` is invoked with
  persist-before-return semantics: the rotated refresh token is committed to
  memory first, then handed to the sink; only if the sink returns normally is
  the new access token cached and returned (a sink that throws fails the
  acquisition). A `refresh_invalid` response is terminal — surfaced verbatim,
  never retried or fallen back on. Thread-safe.
- **`REFRESH_INVALID` error code** (SPEC §3.1): added to the `ErrorCode` enum.
  The HTTP error decoder already reads the issuer's nested
  `{"error":{"code":…}}` envelope, so a server `refresh_invalid` (returned by
  `POST /auth/token` when the refresh token is expired, revoked, or
  reuse-detected) now surfaces as `RealmException` with
  `getCode() == ErrorCode.REFRESH_INVALID` rather than the generic
  `UNAUTHORIZED`.

### Changed

- **api-key DTO aligned to the issuer (code wins)** (SPEC §6.5): `APIKey` now
  mirrors the issuer `APIKey` / `APIKeyListItem` wire shapes. List rows are
  `{ id, prefix, role, createdAt, lastUsedAt?, revokedAt? }` — `role` is a
  singular string (**not** a `scopes` array), and the `*At` fields are
  unix-seconds `Long`s (`lastUsedAt` / `revokedAt` nullable). Create returns
  the row plus a one-time `value` secret (**not** `secret`). `APIKeyCreate`
  is now `{ scope (required), label? }` (**not** `displayName` / `scopes`).
  Added `APIKey.revoked()` helper (mirrors Go's `APIKey.Revoked()`).
  **Breaking** for any caller that read the prior `displayName` / `scopes` /
  `secret` / string-timestamp fields.
- **ADR-051 platform-auth migration**: `PlatformTokenManager` no longer calls
  the removed `POST /auth/platform-token` (hard-cut server-side in v0.7.0).
  It now bootstraps the SDK's platform session via the two-endpoint flow —
  `POST /auth/login {grant_type:"platform_api_key", api_key}` for the initial
  mint, `POST /auth/token` (refresh token as bearer) to refresh, falling back
  to a fresh login on a 401. The public surface (`getToken()`, `invalidate()`)
  is unchanged; `invalidate()` now preserves the refresh token so the next
  acquire prefers `/auth/token` before a full re-login. `auth().login()` now
  also sends the `token` field (alongside the legacy `provider_token`) to
  match the issuer's `loginReq.Token`. The raw API key only ever travels on
  the first `/auth/login` call.
