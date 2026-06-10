# Changelog — `@realmid/sdk` (TypeScript)

All notable changes to the TypeScript SDK. Ships with a language-prefixed
tag (`ts-vX.Y.Z`). The monorepo-level `../CHANGELOG.md` records
cross-cutting items affecting every SDK at once.

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
