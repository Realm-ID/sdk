# Changelog

All notable changes to the Realm ID SDK monorepo. Each SDK
(`ts/`, `go/`, `java/`) ships independently with a language-prefixed
tag (`ts-vX.Y.Z`, `go-vX.Y.Z`, `java-vX.Y.Z`); cross-cutting items
that affect every SDK at once are recorded under a shared heading.

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
| `PATCH /realms/{id}/roles/{name}` | `PATCH /platforms/{id}/roles/{name}` |
| `DELETE /realms/{id}/roles/{name}` | `DELETE /platforms/{id}/roles/{name}` |
| `POST /realms/{id}/roles/{name}/rename` | `POST /platforms/{id}/roles/{name}/rename` |

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
