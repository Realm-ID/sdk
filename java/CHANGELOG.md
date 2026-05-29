# Changelog — `dev.realmid:sdk` (Java)

All notable changes to the Java SDK. Ships with a language-prefixed tag
(`java-vX.Y.Z`). The monorepo-level `../CHANGELOG.md` records cross-cutting
items affecting every SDK at once.

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
