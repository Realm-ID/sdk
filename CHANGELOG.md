# Changelog

All notable changes to the Realm ID SDK monorepo. Each SDK
(`ts/`, `go/`, `java/`) ships independently with a language-prefixed
tag (`ts-vX.Y.Z`, `go-vX.Y.Z`, `java-vX.Y.Z`); cross-cutting items
that affect every SDK at once are recorded under a shared heading.

## All SDKs — partner audit-event feed (ADR-055) (2026-05-25)

**Additive.** Each language SDK gains a new resource for the
partner audit-event feed. Versions bump in lockstep:
`go-v0.12.0`, `ts-v0.10.0`, `java-v0.7.0`.

### Added

- `realm.AuditEvents.List(ctx, ListAuditEventsParams)` (Go) /
  `realm.auditEvents.list(opts?)` (TS) /
  `realm.auditEvents().list(opts)` (Java) — wraps
  `GET /platforms/{id}/audit-events`. The SDK forces the platform id
  from the configured `realmId`, so partners cannot accidentally
  read another platform's events; the server also ignores any
  query-string `platform_id`.
- Filters: `tenantId`, `actorId`, `kind` (repeatable), `since`,
  `until`, `cursor`, `limit` (default 50, max 200). Cursor is
  opaque — forward `next_cursor` verbatim until null.
- New response type `AuditEventsResponse { items: AuditEvent[],
  next_cursor: string | null }`. `AuditEvent` row shape is identical
  to the admin-aggregates surface (§7.5).

### Docs

- `SPEC.md §7.6` added.
- `docs/integration-guide.md §8.6` rewritten — was a workaround +
  roadmap note; now documents the live surface, retention (400 days),
  and the pull-only delivery model. Push (webhooks / event streams)
  remains explicitly out of scope.

## web-v0.3.0 — Request adapters + adopt() (2026-05-09)

**Additive only.** Closes the round-trip on partner-BFF flexibility:

- **`requestAdapters`** — symmetric to v0.2's response adapters. Lets
  partner BFFs receive any wire shape on POST `/login`, `/token`,
  `/switch-tenant`, `/mfa/challenge`, `/mfa/verify`. Without this,
  partners whose BFFs use snake_case (or any non-canonical shape) on
  the *request* side had to fork the SDK; now they pass a small adapter.
- **`realm.adopt({ accessToken, expiresAt, tenantId, user, tenants })`**
  — seed the SDK from an externally persisted session (sessionStorage,
  cookie reflection, SSR handoff) without going through `/login` or
  `/me`. Pairs with the new `realm.peekAccessToken()` getter for
  reading the bearer back out for re-persistence.
- **`@realmid/web-bff-realmid@0.2.0`** ships matching request adapters
  for the reference BFF (`providerToken→token`, `tenantId→tenant_id`,
  `challengeToken→mfa_challenge_token`, body-less `/token`).
- **`TenantRef.mfaRequired?: boolean`** added (additive). Partners that
  surface a per-tenant MFA policy can populate it through the login or
  /me adapter.

Sibling packages (`@realmid/web-react`, `-firebase`, `-google`) bumped
to 0.3.0 in lockstep; their public surface is unchanged.

## web-v0.2.0 — Partner-flexible adapters, gates, tokenless refresh (2026-05-09)

**Additive only.** No wire-shape changes; existing v0.1 BFF integrations
keep working. Adds the missing primitives that prevented partner BFFs
(including our own `Realm-ID/bff-api`) from being used as drop-in targets:

- **Response adapters** (`createRealm({ adapters })`) — pluggable
  normalisers for `/login`, `/me`, `/token`, `/providers`. Lets BFFs ship
  any wire shape (snake_case, envelope-wrapped, flat `/me`, status
  discriminator) and have the SDK translate to the canonical shape.
- **Error gates** (`createRealm({ gates })`) — match HTTP status + body
  `code` to surface canonical `RealmError` codes (`mfa_required`,
  `mfa_registration_required`, `session_limit_reached`, `tenants_required`).
  Gate-specific payloads are exposed via `extract`.
- **Tokenless `/token` rotation** (`refresh: { tokenless: true }`) —
  `/token` returns `{ expiresAt }` only; SDK keeps using the existing
  opaque bearer with an advanced expiry.
- **`refresh.sendBearer`** — optionally attach `Authorization` to `/token`
  for BFFs that authenticate refresh with the current session bearer.
- **CSRF header injection** (`csrf: { headerName, cookieName | tokenProvider }`)
  on POST/PUT/PATCH/DELETE.
- **`switchTenant` fallback** — set `endpoints.switchTenant: null` and
  the SDK falls back to a `/login` second pass with `{ tenantId }`.
- **`expiresIn`/`expiresAt` reciprocal derivation** — partners can ship
  either; the SDK schedules refresh from whichever is present.
- **`AuthState.status: "error"`** — distinguishes a network/5xx failure
  during `/me` restore from a clean anonymous state.
- **`tenants_required` success-body gate** — surfaces a typed error and
  populates `state.pendingTenants` for the caller's tenant picker.
- **Open `LoginMethod` and provider strings** — partners can use
  `apple`, `magic_link`, etc. without forking the SDK.
- **New companion package `@realmid/web-bff-realmid`** — bundles the
  adapters, gates, endpoints, and refresh flags needed to drop the SDK
  in front of `Realm-ID/bff-api` (the reference BFF) in one import.
- **BFF-SPEC.md** rewritten around the canonical+adapter model.

Sibling packages (`@realmid/web-react`, `@realmid/web-firebase`,
`@realmid/web-google`) bumped to 0.2.0 in lockstep; their public surface
is unchanged.

## go-v0.11.0 — Error + session helpers, typed IdentityProviders (2026-05-24)

**Additive only.** Promotes three pieces of duplication that BFF /
partner consumers were reinventing into the SDK surface:

- **Error helpers** (`errors.go`): `IsUnauthorized(err)`,
  `IsTimeout(err)`, `AsRealmError(err, &re)`, `HTTPStatus(err)`. Every
  consumer mapping an SDK error onto its own HTTP/UI surface was
  unwrapping `*RealmError` by hand; these collapse that to a single
  call. `IsTimeout` is `errors.Is`-based so it sees through wrapped
  `*RealmError{Cause: ctx.Err()}` rather than string-matching.
- **`Session.NeedsTenantChoice()` + `Session.SelectTenant(preferred)`**
  (`auth.go`): the two arithmetic pieces every server-side login flow
  re-implements — "did the issuer return a picker?" and "resolve final
  (tenant_id, role) given a caller preference". Pure functions on the
  existing `*Session`, no new state.
- **`Realm.IdentityProviders(ctx, *IdentityProvidersOptions)`**
  (`identity_providers.go`): typed wrapper over
  `GET /platforms/{realm_id}/identity-providers` with optional
  `Platform`, `TenantID`, `Origin`. Returns
  `*IdentityProvidersResponse`. Removes ~25 lines of
  `r.Do` + ReadAll + Unmarshal boilerplate from every consumer that
  populates a SPA login picker.

No SPEC change; no wire-shape change; existing call sites keep
working unchanged. TS / Java SDK lockstep additions are tracked
separately — bump those when a consumer needs them.

## go-v0.10.0 / ts-v0.9.0 — Two-endpoint auth surface (ADR-051) (2026-05-08)

**BREAKING.** Tracks api `v0.7.0`. The legacy
`POST /auth/service-token` and `POST /auth/platform-token` endpoints
are gone (server-side, hard cut, no aliases). The SDK now drives the
two-endpoint flow:

```text
POST /auth/login   {grant_type, ...} → refresh + (resolved) access
POST /auth/token   refresh-bearer    → rotated refresh + access
```

Authoritative reference:
- `api/docs/adr/051-two-endpoint-auth-surface.md`
- `api/docs/proposals/two-endpoint-auth-surface.md`

SPEC.md §4.0, §4.1, §4.2 rewritten to match.

### Changed — Go (`v0.10.0`)

- `internal: platformTokenManager` renamed to `sessionManager`.
  Public surface unchanged: every `realm.platformToken.get(ctx)`
  call site keeps returning the platform access token.
- `sessionManager` now holds **both** an access token and a refresh
  token. First call hits `POST /auth/login {grant_type:
  "platform_api_key", api_key}`; near-expiry calls hit `POST
  /auth/token` with the refresh token as the Authorization Bearer.
  401 on `/auth/token` falls back transparently to a fresh
  `/auth/login`.
- Refresh-token rotation gated by the realm's
  `platform_refresh_rotates` config (default off, non-rotating;
  the response's `refresh_token` will equal what was sent).
- Removed `platformTokenResponse`; introduced `loginResponse` matching
  the new wire shape (`subject_type`, `refresh_token`,
  `access_token`, `expires_in`).

### Changed — TS (`0.9.0`)

- `PlatformTokenManager` (kept the class name + `getToken()` surface
  for source compatibility) reimplemented against the two-endpoint
  flow. Same fallback semantics as Go.
- `invalidate()` now clears only the access token; the cached refresh
  token is preserved so the next `getToken()` can attempt
  `/auth/token` before a full re-login.

### Removed

- All references to `POST /auth/service-token` and
  `POST /auth/platform-token` in source, tests, and SPEC.md.

### Migration

Bump the SDK to `go-v0.10.0` / `ts-v0.9.0` whenever you bump the API
to `v0.7.0`. No partner code changes required — call surface (`auth.login`,
`auth.token`, `tenants.*`, etc.) is unchanged.

## go-v0.9.0 / ts-v0.8.0 — Partner OTP primitive + `mfa_challenge_token` wire fix (2026-05-08)

Tracks api `v0.6.0`. Both SDKs ship the partner OTP primitive
(issue / view / verify) and two login integrations
(`auth.otpLogin` single-factor, `auth.mfaVerifyOtp` second-factor),
plus a wire-shape fix on `/auth/mfa/verify`. SPEC.md gains §X (OTP
primitive). Authoritative reference:
`api/docs/proposals/partner-otp-primitive.md`.

> Versioning note: the previous Go SDK release was `0.8.2`. Bumping
> Go to `0.9.0` (not `0.8.0`) since 0.8.x is already in flight.
> TS jumps from `0.6.0` to `0.8.0` to keep the lockstep numbering
> aligned with Go on the OTP cut.

### Added — Go (`v0.9.0`)

- `realm.OTP.Issue(ctx, tenantID, OTPIssueRequest{SubjectRef, Purpose})` →
  `OTPIssueResponse{ID, Value, ExpiresAt, Purpose, SubjectRef}`.
- `realm.OTP.View(ctx, tenantID, otpID)` →
  `OTPViewResponse{..., IssuerUserID}`.
- `realm.OTP.Verify(ctx, OTPVerifyRequest{TenantID, SubjectRef, Purpose, Presented})` →
  `OTPVerifyResponse{OTPID, IssuerUserID, IssuedAt, SubjectRef, Purpose}`.
- `Auth.OTPLogin(ctx, OTPLoginRequest{RealmID, Identifier, Presented})` —
  wraps `POST /auth/login` with `method=otp_internal`. Realm gate:
  `otp_login_enabled`.
- `Auth.MFAVerifyOTP(ctx, MFAVerifyOTPRequest{MFAToken, Presented})` —
  wraps `POST /auth/mfa/verify` with `method=otp_internal`. Realm
  gate: `otp_mfa_enabled` + per-user/per-role enrollment.

### Added — TS (`0.8.0`)

- `realm.otp.issue({ subjectRef, purpose })`,
  `realm.otp.view(otpId)`,
  `realm.otp.verify({ subjectRef, purpose, presented })`.
- `realm.auth.otpLogin({ realmId, identifier, presented })`.
- `realm.auth.mfaVerifyOtp({ mfaToken, presented })`.

### Fixed — both SDKs (`mfa_challenge_token` wire shape)

`Auth.MFAVerify` (Go) and `auth.mfaVerify` (TS) previously sent the
challenge token under JSON key `challenge_token`, but the API's
`mfaVerifyReq` JSON tag is `mfa_challenge_token` — every MFA verify
broke at the wire. Pre-existing bug; surfaced when Phase 4b's
`MFAVerifyOTP` path inherited it. Both SDKs now serialise the body
key as `mfa_challenge_token`. The TS Connect-style middleware's
inbound body parser (`handleMfaVerify`) accepts both
`mfa_challenge_token` (canonical) and `challenge_token` (legacy)
keys from partner UI code so existing partner integrations don't
regress while they update.

### SPEC

- Adds `§X OTP primitive` with full surface + a partner examples.
- Updates `§4.1 login()` and `§4.3 mfaVerify()` to mention
  `otp_internal` and the new typed helpers.
- Calls out the corrected `mfa_challenge_token` wire-shape on §4.3.

## Unreleased — Admin aggregates surface (all SDKs)

Admin aggregates surface (ADR-048, SPEC §7.5) shipped on all three
SDKs: `realm.admin.{listPlatforms, stats, listEvents, search}`. Wraps
the base-realm-staff-only `GET /admin/platforms`, `/admin/stats`,
`/admin/events`, `/admin/search` endpoints. The SDKs do not gate
locally; the server's `403 forbidden` envelope is surfaced as the
standard `RealmError(forbidden)` / `RealmException(FORBIDDEN)`.

## 0.8.2 — PassthroughOptions.UserBearer (Go) (2026-05-02)

Adds `UserBearer` to `PassthroughOptions`. When set, replaces the
default platform-token bearer with the supplied bearer (typically a
user JWT or a one-shot revocation_token). The platform token is
still minted (cache stays warm, mint-errors surface), but the wire
bearer is the user's. Required for the BFF's session-limit-modal
flow where the auth server validates a one-shot revocation_token.

## 0.8.1 — LoginRequest.TenantID (Go) (2026-05-02)

`LoginRequest` now carries an optional `TenantID`. When set, the SDK
forwards `tenant_id` on the `/auth/login` body so the auth server can
mint a tenant-scoped session in one round-trip. When empty and the
user has >1 tenants, the auth server's existing tenant-picker
response (no tokens, just `tenants[]`) is preserved.

## 0.8.0 — Realm.Do passthrough (Go) (2026-05-02)

Adds a public escape hatch for BFF / proxy consumers that need to
forward arbitrary admin-API calls without re-implementing the
dual-token dance:

- **`Realm.Do(ctx, method, path, body, *PassthroughOptions)`** — issues
  an authenticated request and returns the raw `*http.Response`. The
  platform token is minted (and cached) behind the scenes; the caller
  closes `resp.Body`.
- **`PassthroughOptions`** carries `OnBehalfOfUser`
  (→ `X-On-Behalf-Of-User`), `OnBehalfOfIP` (→ `X-On-Behalf-Of-IP`),
  and a free-form `http.Header` for forwarding things like
  `Idempotency-Key` or `Content-Type`. `Authorization` is always
  overwritten with the platform-token bearer.

Typed methods (`Tenants`, `Roles`, `Origins`, …) remain the
recommended surface for application code; `Do` exists for the BFF at
`api.realmid.dev` and for partner backends doing protocol-level
gateway work.

## 0.7.0 — BFF alignment fixes (Go) (2026-05-02)

Alignment fixes surfaced while standing up the `api.realmid.dev` BFF
(ADR-050). Wire-compatible for callers using the typed request structs;
only direct `map[string]any` consumers of the body JSON would notice
the field rename.

- **Login wire shape (Go)** — `Auth.Login` body field renamed
  `provider_token` → `token` to match `api/internal/httpapi/auth.go`
  (`loginReq.Token`). Pre-existing SDK/api drift; was failing every
  Login at the dev provider in BFF mode. The Go-side `LoginRequest`
  struct field stays `ProviderToken`.
- **Tenant ID JSON tag (Go)** — `TenantRef.ID` now decodes from
  `tenant_id` (matches `authsvc.TenantMembership.TenantID`); legacy
  `id` accepted via fallback for older mocked issuers / tests.
- **Session shape (Go)** — added top-level `TenantID` and `Role`
  (the api's login response carries them flat alongside `Tenants[]`).
  `User.ID/Email/DisplayName` now backfilled from the access JWT's
  `sub/email/name` claims when the wire response omits the `user`
  object (it does today — see `api/internal/httpapi/auth.go.loginResp`).
- **New helper (Go, private)** — `peekJWTUserFields` decodes JWT
  user claims for the backfill above.
- **`Auth.ListSessions` + `Auth.RevokeSession` — request structs +
  on-behalf-of (Go, breaking)**. Both now take `ListSessionsRequest` /
  `RevokeSessionRequest`. Two mutually-exclusive auth modes:
  - `UserID` → SDK attaches the cached platform token as bearer and
    `X-On-Behalf-Of-User: <UserID>`. Required when the realm has
    `config.require_bff_login=true` (ADR-041 §7) — the user's own JWT
    won't pass the BFF gate against base realm once that flips on.
  - `UserBearer` → that JWT rides as `Authorization: Bearer` (legacy /
    public-client realms; subject read from the JWT).
  Optional `OnBehalfOfIP` rides as `X-On-Behalf-Of-IP` so the issuer's
  per-IP rate limits attribute to the SPA's IP, not the BFF's egress
  (ADR-050 plan §8.2). Old signatures `(ctx, sessionID, userBearer)` /
  `(ctx, userBearer)` are gone — there are no in-tree callers.
- **`Auth.MintMFAChallenge` — request struct (Go, breaking)**. Now
  takes `MFAChallengeRequest{AccessToken, OnBehalfOfIP}`. The SDK's
  own MFA middleware was migrated in the same change.
- **`MFAVerifyRequest.OnBehalfOfIP` (Go)** — new optional field
  forwards SPA IP via `X-On-Behalf-Of-IP` for the same rate-limit
  reason.

TS + Java are not affected by this set; they don't have a Server-mode
consumer landed yet.



## 0.5.0 — platforms-namespace cut + signup_mode enum (2026-04-29)

Cross-cutting **breaking** bump aligning with RealmID v0.5.0
(ADR-044 + ADR-045). All three SDKs (`ts/`, `go/`, `java/`) bumped in
lockstep. a partner is on 0.4.0; partners on 0.4.x must upgrade
when they cut over to a v0.5.0 server.

### Breaking — admin sub-paths moved to `/platforms/{id}/...` (ADR-044)

Every realm-admin sub-path was renamed:

| Old wire path | New wire path |
|---|---|
| `POST /realms/{id}/api-keys` | `POST /platforms/{id}/api-keys` |
| `GET /realms/{id}/api-keys` | `GET /platforms/{id}/api-keys` |
| `DELETE /realms/{id}/api-keys/{keyId}` | `DELETE /platforms/{id}/api-keys/{keyId}` |
| `PATCH /realms/{id}/config` | `PATCH /platforms/{id}/config` |
| `GET /realms/{id}/roles` | `GET /platforms/{id}/roles` |
| `POST /realms/{id}/roles` | `POST /platforms/{id}/roles` |
| `PATCH /realms/{id}/roles/{name}` | `PATCH /platforms/{id}/roles/{roleId}` |
| `DELETE /realms/{id}/roles/{name}` | `DELETE /platforms/{id}/roles/{roleId}` |
| `POST /realms/{id}/roles/{name}/rename` | `POST /platforms/{id}/roles/{roleId}/rename` |

The high-level SDK surface (`realm.apiKeys.*`, `realm.config.update`,
`realm.roles.*`, etc.) is unchanged — only the wire path constants
inside the SDKs moved. Partners who use the SDK methods don't need to
touch their code; partners who hand-rolled HTTP calls must update.

OIDC discovery URLs (`/realms/{realm}/.well-known/jwks.json` and
`/realms/{realm}/.well-known/openid-configuration`) **stay** on the
`/realms/...` namespace. They are the realm-as-issuer surface. Verifier
behavior is unchanged.

There is no dual-mount window. v0.5.0 is a clean cut; old paths are
404. See ADR-044 for the rationale.

### Breaking — `signup_mode` enum replaces `open_signup` bool (ADR-045)

`TenantConfig` and `TenantCreate` no longer carry an `open_signup`
boolean. They carry `signup_mode: "closed" | "allowlist" | "open"`
instead.

- `closed` (default) — invitation-only; `allowed_domains` ignored.
- `allowlist` — auto-provision when the verified email domain is in
  `allowed_domains`. List must be non-empty.
- `open` — auto-provision every authenticated user. Reserved for the
  base admin tenant; partner tenants cannot set this mode (server
  rejects with `signup_mode_invalid_for_tenant`).

Migration on existing data is automatic on the server side
(see ADR-045 §"Migration from today's model"). For SDK callers:

- TS: `tenants.create({ ..., openSignup: true })` →
  `tenants.create({ ..., signupMode: "allowlist" })`.
- Go: `TenantCreate{ ..., OpenSignup: true }` →
  `TenantCreate{ ..., SignupMode: SignupModeAllowlist }`.
- Java: `TenantCreate` is config-blob shaped; pass
  `Map.of("signup_mode", "allowlist", ...)` instead of
  `"open_signup", true`.

There is no compatibility shim — sending `open_signup` to a v0.5.0
server is a `bad_request` and the SDKs no longer encode that field.

### What changes in your SDK code

If you call `realm.apiKeys.*`, `realm.config.update`, `realm.roles.*`,
or pass `tenants.create` with the basic fields covered above: nothing
beyond bumping the dependency.

If you talked to the server directly without the SDK, see the table
and the `signup_mode` section above.

### Compatibility

- SDK 0.5.0 talks to RealmID v0.5.0+ realms.
- SDK 0.5.0 against pre-v0.5.0 realms: admin sub-paths 404 (the
  server still has `/realms/{id}/...`); do not mix.
- SDK 0.4.0 against v0.5.0 realms: admin sub-paths 404, `open_signup`
  on tenant create is rejected. Upgrade to 0.5.0 in lockstep with
  the server.

## 0.4.0 — BFF login enforcement (2026-04-27)

Cross-cutting bump aligning with RealmID v0.4.0 (ADR-041).

### What changed on the wire

RealmID v0.4.0 ships a per-realm flag `realms.config.require_bff_login`.
When true, every `/auth/*` call against the realm MUST carry an
`Authorization: Bearer <platform_token>` minted from an API key bound
to a `platform_api`/`owner` user in the realm's admin tenant. Direct
browser → RealmID `/auth/login` is rejected with `bff_bearer_required`.

### What changes in your SDK code

Nothing. Both `@realmid/sdk` (TS) and `realmid-go` already attach the
platform token to every `/auth/*` call as Bearer — that's been the
SDK's wire shape since the dual-token surface locked. The 0.4.0 bump
is the version compatible with the server side that enforces it.

### Compatibility

- SDK 0.4.0 talks to RealmID v0.4.0+ realms (BFF or non-BFF).
- SDK 0.4.0 talks to pre-v0.4.0 realms unchanged (those realms ignore
  the bearer; the gate isn't enforced server-side).
- SDK 0.3.0 talks to v0.4.0 BFF realms — the platform token attach is
  already there; no behavioural difference.

### Also in 0.4.0 (rolled forward from the planned 0.4.1)

Pre-public release; no point shipping the gate without the surrounding
hardening that makes BFF mode usable end-to-end.

- **Client-side platform-token realm pinning.** Both Go and TS decode
  the JWT minted from `/auth/platform-token` and verify its `iss`
  claim references the configured `realmId`. Mismatch throws
  `realm_mismatch` (TS) / `unauthorized` (Go) locally before any
  subsequent API call goes out — catches confused-deputy bugs (SDK
  constructed for realm A but key actually belongs to realm B) at the
  source instead of as cryptic 4xx on first partner call.

- **Optional shared revocation cache.** Pluggable `RevocationCache`
  interface; ships with `MemRevocationCache` (in-process LRU) for
  single-replica partners. Multi-replica partners implement the
  interface against Redis/memcached/etc. The verifier checks the
  cache after signature + claim checks; cache hit on the JWT's `jti`
  → reject as `unauthorized`/`token revoked`. `auth.logout()` learns
  to push the access token's jti when `accessToken` is supplied in
  the request. Bridges the gap between user logout and the access
  token's stateless natural expiry. OPT-IN: nil cache → no-op,
  unchanged behaviour.

  ```ts
  import { createRealm, MemRevocationCache } from "@realmid/sdk";

  const realm = createRealm({
    realmId, apiKey,
    revocation: new MemRevocationCache(),
  });

  await realm.auth.logout({ refreshToken, accessToken });
  // Subsequent realm.verify(accessToken) → throws "unauthorized"
  ```

  ```go
  realm, _ := realmid.NewRealm(realmid.Config{
      RealmID: realmID, APIKey: apiKey,
      Revocation: realmid.NewMemRevocationCache(nil),
  })

  realm.Auth.Logout(ctx, &realmid.LogoutRequest{
      RefreshToken: refreshToken,
      AccessToken:  accessToken,
  })
  // Subsequent realm.Verify(ctx, accessToken, nil) → ErrCodeUnauthorized
  ```

- **Dual-token (`Authorization` + `X-User-Token`) for `/auth/sessions/*`
  and `/auth/mfa/*`.** Server-side change shipped in RealmID v0.4.0;
  the SDK already attaches both headers on the user-on-self call
  helpers (no SDK API change). Partner can no longer impersonate
  arbitrary users — they have to actually possess the user's access
  JWT to make a call on their behalf.

### Compatibility

- SDK 0.4.0 ↔ RealmID v0.4.0+: full feature surface.
- SDK 0.4.0 ↔ pre-v0.4.0 RealmID: bearer attach is a no-op server-side;
  revocation cache is purely client-side, also works.
- SDK 0.3.0 ↔ RealmID v0.4.0 BFF realm: works for everything except
  `/auth/sessions/*` and `/auth/mfa/*` on partner-brokered calls
  (those need the X-User-Token header which 0.3.0 doesn't send).


## Unreleased — locked surface (2026-04-26)

The cross-language SDK contract was finalized in
[`SPEC.md`](./SPEC.md). All three SDKs are being aligned to the
locked surface; the next published versions of `ts/`, `go/`, and
`java/` will all match it.

### Major surface decisions

- **`apiKey` is required.** Verifier-only callers can still use the
  low-level `createVerifier` (or `Verifier.builder()`) primitive, but
  the integrated `createRealm` handle now requires the API key as a
  first-class input.
- **Dual-token login.** The SDK exchanges the API key for a
  short-lived platform JWT via `POST /auth/platform-token`, then sends
  the platform JWT (not the API key) on every subsequent call —
  including `/auth/login`. The raw key is sent on exactly one mint
  call. See [`docs/dual-token.md`](./docs/dual-token.md).
- **Custom claims move from refresh to access tokens.** `auth.login`
  no longer accepts `customClaims`. `auth.token` (the access-token
  mint endpoint) accepts a `customClaims` map, gated by a per-realm
  server-side allowlist.
- **`realm.platforms.*` removed.** Partners have one platform per
  realm; cross-platform admin is a RealmID-ops concern that lives in
  a separate `realmid-admin` CLI.
- **`realm.realm.*` flattened.** `info()`, `apiKeys.*`, and
  `config.update` are now top-level on the handle.
- **Paginated wire shape locked** to `{ items, next_cursor, total? }`.
  SDKs reject any other shape with a `RealmError(server_error)`.
- **Origin auto-attached** on every auth call, derived from the
  realm's claimed domain via `realm.info()`. Per-call and per-handle
  override.
- **Logger interface** replaces the earlier debug callback. TS uses a
  4-method `Logger` interface; Go uses `*slog.Logger`; Java uses
  `java.lang.System.Logger`. Raw credentials are never logged — only
  the first 6 chars of any bearer credential appear.
- **Middleware adds `tokenDelivery`** (`"cookie"` | `"body"`) and
  `mfaProtectedPaths`. Cookie mode is the SPA default; body mode
  serves mobile clients. MFA-protected paths surface a 412 envelope
  matching the login flow when a verified-but-non-MFA token hits one
  of them.

### New cross-language surface

The handle now exposes:

- `realm.verify(token, opts?)`
- `realm.auth.{login, token, mfaVerify, logout, revokeSession, listSessions}`
- `realm.tenants.{list, get, create, update, updateConfig, delete, transferOwner}`
- `realm.tenants.invitations.{list, create, delete}`
- `realm.tenants.users.{list, get, updateStatus, enrollMfa, confirmMfa, resetMfa}`
- `realm.domains.{claim, verify}`
- `realm.info()` (cached)
- `realm.apiKeys.{create, list, revoke}`
- `realm.config.update(patch)`
- `realm.middleware(opts)` — Connect-style (TS), `http.Handler`
  middleware (Go), or `jakarta.servlet.Filter` (Java)

### Server changes driven by this redesign

Tracked in the auth-monorepo TODO under "Server changes driven by SDK
SPEC.md (2026-04-26)":

- `POST /auth/platform-token` (new; mints the short-lived platform
  JWT used for dual-token login)
- Drop `customClaims` from `POST /auth/login` (with a `Deprecation:`
  + `Sunset:` header for one release)
- Accept `customClaims` on `POST /auth/token` (per-realm allowlist
  via `realms.config.access_token_custom_claim_keys`)
- 412 `mfa_required` envelope on MFA-protected resources (today
  emitted only on login)
- Standardize paginated list responses to
  `{ items, next_cursor, total? }`
- `GET /realms/{id}/api-keys` + `DELETE /realms/{id}/api-keys/{kid}`
- Self-MFA endpoints (`POST /auth/mfa/{enroll,confirm}`,
  `DELETE /auth/mfa`) for the bearer user (today only the admin
  surface exists)
- `PATCH /realms/{id}/config` allowlist documented in `swagger.yaml`

### Roadmap (deferred)

CSRF middleware layer, webhooks, service-to-service tokens, OIDC
discovery, impersonation, WebAuthn / passkeys, custom domains for
hosted UIs, bulk user import, idempotency-key pass-through.

## ts-v0.1.0 (initial public release, 2026-04-25)

First public TypeScript SDK as a verifier-only surface
(`createVerifier({ baseUrl, audience })`). Web Crypto + JWKS fetch,
runs in Node ≥ 20, Deno, Bun, Cloudflare Workers, modern browsers.
Superseded by the locked surface above.

## go-v0.1.0 (initial public release, 2026-04-25)

First public Go SDK as a verifier-only surface
(`realmid.NewVerifier(realmid.Config{...})`). Stdlib only.
Superseded by the locked surface above.

## java-v0.1.0 (initial public release, 2026-04-25)

First public Java SDK as a verifier-only surface
(`Verifier.create(Config.builder()...build())`). Java 17+, single
Jackson dependency. Superseded by the locked surface above.
