# Changelog

All notable changes to the Realm ID SDK monorepo. Each SDK
(`ts/`, `go/`, `java/`) ships independently with a language-prefixed
tag (`ts-vX.Y.Z`, `go-vX.Y.Z`, `java-vX.Y.Z`); cross-cutting items
that affect every SDK at once are recorded under a shared heading.

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
