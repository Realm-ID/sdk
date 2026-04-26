# Realm ID SDK — cross-language specification (v0.1.0)

This document is the contract every official SDK in this repository
implements. The TypeScript SDK is the canonical reference; the Go and
Java SDKs mirror it idiomatically.

A partner application using a Realm ID SDK should never need to call
`auth.realmid.dev` directly. The SDK covers the full lifecycle:
**login, refresh, MFA, verify, and management** (tenants, users,
invitations, domains, platform admin, API keys).

## 1. Construction

The SDK exposes a single handle. Configuration is minimal:

| Field      | Required | Description                                                                 |
|------------|----------|-----------------------------------------------------------------------------|
| `realmId`  | **yes**  | Your realm's id (UUID-ish string).                                          |
| `apiKey`   | **yes**  | Realm API key (`rk_live_...`). Used for every operation, including login. The SDK exchanges it for short-lived platform tokens internally — your raw API key never crosses login traffic (see §4.0). |
| `baseUrl`  | no       | Override the issuer host. Default: `https://auth.realmid.dev`.              |
| `origin`   | no       | Origin host the SDK announces on auth calls. If unset, derived from the realm's claimed domain via `realm.info()`. Override per-call on `auth.login()`. |
| `logger`   | no       | A `Logger` instance (see §9). No-op by default.                             |
| `tokenDelivery` | no  | `"cookie" \| "body"`. How the middleware returns refresh tokens (see §11.2). Default `"cookie"`. |
| `httpClient` / `cacheTtl` / `leeway` / `clock` | no | Standard infrastructure overrides for tests and tuning. |

```ts
const realm = createRealm({ realmId: "01HXYZ...", apiKey: "rk_live_..." });
```

> **Audience auto-discovery:** at first use of `verify()`, the SDK calls
> `GET /platforms/mine` to learn the realm's canonical audience (its
> domain). The result is cached for the lifetime of the handle.
> Override per-call via `verify(token, { audience })`.

## 2. Caching

Only **JWKS** are cached (10 min TTL, unknown-kid forces refetch). All
other responses (realm metadata, tenants, users, etc.) are returned
fresh on every call. There is no in-SDK request coalescing.

## 3. Errors

A single error type, `RealmError`, is thrown / returned for **every**
SDK failure. It carries:

- `code` — a stable, machine-readable identifier (see §3.1 for the full taxonomy).
- `message` — human-readable diagnostic.
- `httpStatus?` — set when the failure originated from an API response.
- `details?` — server-supplied envelope siblings (e.g. `revocation_token`,
  `mfa_challenge_token`, `active_sessions`, `tenant_id`).
- `cause?` — wrapped underlying error.

### 3.1 Error code taxonomy

**Verifier codes** (used by `verify()`):

`malformed`, `wrong_algorithm`, `bad_signature`, `wrong_issuer`,
`wrong_audience`, `expired`, `not_yet_valid`, `unknown_kid`,
`jwks_fetch_failed`.

**Auth-flow codes** (used by `auth.*`):

`provider_token_invalid`, `mfa_required`, `session_limit_reached`,
`tenant_required`, `tenant_invalid`, `account_suspended`,
`account_deactivated`, `realm_origin_mismatch`, `missing_origin`.

**Management / generic codes:**

`unauthorized`, `forbidden`, `not_found`, `conflict`, `rate_limited`,
`bad_request`, `network`, `server_error`.

### 3.2 412 envelope sibling extraction

When the server returns a 412 error envelope with siblings (e.g.
`mfa_required` carrying a `mfa_challenge_token`), the SDK populates
`error.details` with the full server-supplied object. Callers branch on
`error.code` and read `error.details.mfa_challenge_token` directly — no
second round trip to fetch context.

## 4. Authentication surface (`realm.auth.*`)

### 4.0 Dual-token login (defense in depth)

Login is a **two-step exchange** internal to the SDK; partners see one
call. The raw API key is **never** sent on login traffic.

1. **Platform token mint** — SDK calls `POST /auth/platform-token` with
   `Authorization: Bearer <api-key>`. Response is a short-lived
   (default 5 min) platform JWT scoped to the realm.
2. **User session mint** — SDK calls `POST /auth/login` with the
   platform token in `Authorization: Bearer <platform-token>` and the
   user's provider token in the body. The server validates **both** —
   the platform token authorizes the *caller*; the provider token
   authenticates the *user*.

The platform token is cached per-handle until 30 s before its `exp`,
then re-minted automatically. Caller gets one method,
`realm.auth.login(...)`, that handles both legs.

This is a marketing talking point: API keys never travel over login
traffic, and a leaked login-route capture cannot be replayed past the
platform token's TTL.

### 4.1 `login(req)`

Exchanges a provider token for a realm-scoped session.

Request: `{ method, providerToken, origin? }`
- `method`: `"firebase" | "google"`. Other methods are roadmap.
- `providerToken`: opaque string from the upstream IdP.
- `origin`: optional override. If unset, the SDK auto-attaches the
  Origin derived from the realm's claimed domain (see §1).

Response: `{ accessToken, refreshToken, expiresIn, expiresAt, user, tenants }`
- `tenants`: array of `{ id, role, displayName }` the user belongs to.
- If the server replies with a 412 `mfa_required`, the SDK throws
  `RealmError` with `code: "mfa_required"` and
  `details.mfa_challenge_token` set. Caller follows up with `mfaVerify()`.

> Custom claims are **not** accepted on login. The refresh token carries
> identity only. Custom claims belong on the access token (see §4.2).

### 4.2 `token(req)`

Refresh-token rotation, tenant switch, and **custom claim injection on
the minted access token**.

Request: `{ refreshToken, tenantId, customClaims? }`
- `tenantId`: required (server contract — even single-tenant calls supply it).
- `customClaims`: object of extra claims to merge into the minted
  **access token**, subject to a per-realm server-side allowlist. Use
  this to carry app-state fields (e.g. `outlet_ids`) that downstream
  services need to authorize without a database lookup.

Response: `{ accessToken, refreshToken, expiresIn, tenantId, role }`

### 4.3 `mfaVerify(req)`

Completes an MFA challenge.

Request: `{ challengeToken, code, method? }` — `method` defaults to `"totp"`.
Response: same shape as `login()` (refresh + access).

### 4.4 `logout(req?)`

Revokes the current refresh token (or any caller-supplied refresh).
Request: `{ refreshToken? }`. Response: `{ status: "ok" }`.

### 4.5 `revokeSession(sessionId)`

Server-side revoke of a specific session id.

### 4.6 `listSessions()`

Returns sessions for the current user (the user identified by the
caller's bearer token; this is a user-token operation, not API-key).

## 5. Verifier surface (`realm.verify`)

```ts
const claims = await realm.verify(accessToken /*, { audience? } */);
```

- Algorithm enforced: `RS256`.
- `iss` must start with `${baseUrl}/${realmId}`.
- `aud` must match the realm's auto-discovered audience, or the per-call
  override.
- `exp` / `nbf` checked with leeway (default 30s).
- JWKS fetched per-realm, cached 10m, unknown-kid forces refetch.

## 6. Management surface

All management calls authenticate via the dual-token mechanism (§4.0):
SDK exchanges the API key for a short-lived platform token, then sends
the platform token as `Authorization: Bearer ...`. Pagination on every
list endpoint (see §7).

> **Why no `realm.platforms.*`?** A partner has exactly one platform
> (themselves) and exactly one realm. The cross-platform admin surface
> (creating new platforms, listing all platforms) is a RealmID
> operations concern, not a partner concern, and lives in a separate
> `realmid-admin` CLI. The partner SDK exposes only what a partner
> integration actually uses.

### 6.1 Tenants — `realm.tenants.*`

- `list(opts?)` — paginated. `opts: { cursor?, limit? }`.
- `get(id)`
- `create({ displayName, allowedDomains?, openSignup? })` — creates a
  tenant under the calling platform. The realm is implicit (the API
  key's realm); there is no separate "platform" parameter because a
  partner has one platform per realm.
- `update(id, { displayName? })` — top-level mutable fields.
- `updateConfig(id, patch)` — patches `tenants.config`. Honoured keys:
  `allowedDomains: string[]` (auto-provision domain allowlist),
  `openSignup: boolean` (let users at allowed domains self-provision
  without an invite). Server enforces an allowlist of accepted keys;
  unknown keys → `RealmError(bad_request)`.
- `delete(id)` — soft delete.
- `transferOwner(id, newOwnerUserId)` — atomic owner swap; the previous
  owner becomes a `member`.

### 6.2 Tenant invitations — `realm.tenants.invitations.*`

This is the **only** path for user creation in a tenant.

- `list(tenantId, opts?)` — paginated. `opts: { status?, cursor?, limit? }`.
- `create(tenantId, { email, role? })` — sends an invitation. `role`
  defaults to `"member"`; only an `owner` may invite at `"admin"` or
  `"owner"`.
- `delete(tenantId, invitationId)` — revoke a pending invite.

### 6.3 Users — `realm.tenants.users.*`

User **creation** is invite-only — there is no `users.create` method.
The path is `tenants.invitations.create(tenantId, { email, role })` →
the invitee accepts → user record is provisioned.

- `list(tenantId, opts?)` — paginated, filterable. `opts` shape:
  ```ts
  {
    role?:    Role,                    // exact match
    status?:  "active" | "suspended" | "deactivated",
    q?:       string,                  // case-insensitive substring on email
    cursor?:  string,
    limit?:   number,                  // 1..200, default 50
  }
  ```
- `get(tenantId, userId)`
- `updateStatus(tenantId, userId, status)` —
  `"active" | "suspended" | "deactivated"`.
- `updateRole(tenantId, userId, role)` — change the user's role within
  the tenant. Cannot demote the last owner; use `tenants.transferOwner`
  for an owner handover. Caller must hold a role of `owner` (or
  realm-admin via API key).
- `enrollMfa(tenantId, userId)`, `confirmMfa(tenantId, userId, code)`,
  `resetMfa(tenantId, userId)` — admin-initiated MFA flows. The
  self-service equivalents on `auth.mfa.*` are roadmap (§11).

#### Roles (v0.1.0)

A fixed enum — same value across all tenants in the realm:

| Wire value | Meaning                                                                 |
|------------|-------------------------------------------------------------------------|
| `owner`    | Full tenant control. Can change roles, delete the tenant, transfer ownership. Each tenant has at least one owner. |
| `admin`    | Manage users + invitations + tenant config; cannot delete the tenant or change owners.                            |
| `member`   | Default role for invited users. Can use the application; no admin operations.                                     |
| `viewer`   | Read-only access. Useful for stakeholders / observers.                                                            |

Custom platform-defined roles + a permissions matrix are roadmap
(§11). Until they ship, partners should map their concept of "role"
onto this enum.

### 6.4 Domains — `realm.domains.*`

`claim({ hostname })`, `verify({ claimToken })`.

### 6.5 Realm self — top-level

Promoted from a nested namespace for ergonomics:

- `realm.info()` — cached metadata (id, domain/audience, signing key
  rotation status). Backs §1's audience auto-discovery; callers can
  read it for diagnostics.
- `realm.apiKeys.{create, list, revoke}` — manage the realm's own API
  keys.
- `realm.config.update(patch)` — patch realm-level config (TTL
  overrides, default audience, etc., subject to the server's
  configurable-keys allowlist).

## 7. Pagination

Every list endpoint returns a paginated iterator. The SDK fetches one
page at a time and yields items lazily.

**Wire shape (server contract):** every paginated response is
`{ items: [...], next_cursor: "..." | null, total?: number }`. SDKs
**reject** any other shape — surfaces hidden behind that uniformity
must not vary across endpoints.

- **TypeScript:** returns an `AsyncIterable<T>`. Idiomatic usage:
  ```ts
  for await (const tenant of realm.tenants.list()) { ... }
  ```
  Each call to `.list()` also exposes `.page({ cursor?, limit? })` for
  manual paging.

- **Go:** returns a typed cursor object. Idiomatic usage:
  ```go
  it := realm.Tenants.List(ctx, nil)
  for it.Next() { t := it.Item() ; ... }
  if err := it.Err(); err != nil { ... }
  ```

- **Java:** returns a `Stream<T>` lazily backed by an `Iterator`.
  ```java
  realm.tenants().list().stream().forEach(t -> { ... });
  ```

## 8. HTTP wire conventions

- **Auth header:** `Authorization: Bearer <token>`. The token is a
  short-lived platform token (§4.0) for management calls, the user's
  bearer JWT for user-context calls (e.g. `listSessions`), or the
  raw API key for the **single** call to `POST /auth/platform-token`.
- **Origin header:** SDK auto-attaches `Origin` on every auth call,
  derived from the realm's claimed domain via `realm.info()`. Override
  per-call (`auth.login({ origin })`) or globally
  (`createRealm({ origin })`).
- **Content type:** `application/json` on all request and response bodies.
- **Idempotency:** SDK does not insert idempotency keys; partners may
  pass-through via a future `requestOptions.idempotencyKey` (deferred).

## 9. Logging / observability

The SDK accepts a **logger interface** at construction. No-op by
default. Idiomatic per language:

- **TypeScript:**
  ```ts
  interface Logger {
    debug(msg: string, meta?: Record<string, unknown>): void;
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  }
  createRealm({ ..., logger: console });           // works
  createRealm({ ..., logger: pino() });            // works
  ```
- **Go:** `*slog.Logger` (Go 1.21+). `logger: slog.Default()` typical.
- **Java:** `java.lang.System.Logger` (built-in, JDK 9+). No SLF4J dep
  forced on consumers.

Events the SDK emits at each level:

| Level | Event                                       |
|-------|---------------------------------------------|
| debug | every outbound HTTP request + response      |
| debug | JWKS cache hit / miss / refresh             |
| info  | platform-token mint and refresh             |
| warn  | retry-after responses, cache eviction       |
| error | verify failure, network failure (with code) |

Raw API keys, refresh tokens, and access tokens are **never** logged.
Only the first 6 chars of any bearer credential appear in messages.

## 10. Middleware

Each SDK ships an HTTP middleware adapter for the language's standard
web stack. The middleware is the recommended way to integrate Realm ID
into a partner application — partners do not normally call `auth.login`
or `verify` directly; the middleware does that for them.

| Language    | Adapter                                  |
|-------------|------------------------------------------|
| TypeScript  | Connect-style `(req, res, next) => void` (works with Express, Polka, Connect; thin wrappers shipped for Hono / Cloudflare Workers). |
| Go          | `func(http.Handler) http.Handler`        |
| Java        | `jakarta.servlet.Filter` (with a Spring Security adapter as a sibling artifact). |

### 10.1 Behavior

For every inbound request, the middleware:

1. **Exempt path?** If the request path matches `exemptPaths` (glob list,
   default `["/health", "/public/*"]`), pass through with no auth touched.

2. **Login route?** If `method + path` matches the configured login
   endpoint (default `POST /login`), the middleware **handles the
   request** — it reads `{ method, providerToken }` from the body
   (custom claims are NOT accepted on login; see §4.1), calls
   `realm.auth.login(...)`, returns the refresh token per
   `tokenDelivery` (cookie or body — see §10.2), and the access token
   in the JSON body along with `{ expires_in, user, tenants }`.
   On a 412 `mfa_required`, the response is `200` with body
   `{ status: "mfa_required", mfa_challenge_token, methods }` so SPAs
   can branch without `fetch` rejecting on the 4xx.

3. **Logout route?** If `method + path` matches the logout endpoint
   (default `POST /logout`), middleware reads the refresh token (cookie
   or body per `tokenDelivery`), calls `realm.auth.logout(...)`, clears
   the cookie if applicable, returns `{ status: "ok" }`.

4. **Refresh route?** If `method + path` matches the refresh endpoint
   (default `POST /token`), middleware reads the refresh token + body
   `{ tenant_id, custom_claims? }`, calls `realm.auth.token(...)`, and
   returns `{ access_token, expires_in, tenant_id, role }` (refresh
   rotated via cookie or body per `tokenDelivery`). `custom_claims` is
   the documented place for partner-supplied access-token claims.

5. **MFA verify route?** Default `POST /mfa/verify`. Body
   `{ challenge_token, code }`; behaves like login on success.

6. **Otherwise:** require `Authorization: Bearer <access-token>`,
   call `realm.verify(token)`. On success, attach the verified `Claims`
   to the request context (`req.realmid` in TS, `r.Context()` value
   under a typed key in Go, request attribute `realmid.claims` in
   Java).

   On verify failure (bad signature, expired, malformed, unknown kid,
   missing header): respond **`401`** with `{ error: { code, message } }`.

   On a path that requires MFA (declared via `mfaProtectedPaths` glob
   list) where the token verifies but lacks the MFA marker (`amr`
   missing `"mfa"`, or no `acr` claim): respond **`412`** with
   `{ error: { code: "mfa_required", message }, mfa_challenge_token,
   methods }` so the client can prompt and re-mint.

### 10.2 Configuration

```ts
const middleware = realm.middleware({
  exemptPaths: ["/health", "/public/*", "/webhooks/*"],
  mfaProtectedPaths: ["/admin/*", "/billing/*"],   // optional
  loginPath: "/login",                              // default
  logoutPath: "/logout",                            // default
  refreshPath: "/token",                            // default
  mfaVerifyPath: "/mfa/verify",                     // default

  // Token delivery — inherited from createRealm({ tokenDelivery }) but
  // overridable per middleware instance.
  tokenDelivery: "cookie",  // "cookie" (browser SPA, default) | "body" (mobile / native client)
  cookieName: "realmid_refresh",                    // when tokenDelivery="cookie"
  cookieDomain?: ".acme.com",                       // optional
  cookieSecure: true,                               // default true in prod
  cookieSameSite: "lax",                            // "lax" | "strict" | "none"

  onAuthFailure?: (req, err) => Response,           // optional override of the 401/412 response
});
```

Same fields exist in the Go and Java configurations using
language-idiomatic types (`time.Duration`, `Predicate<Request>`, etc.).

### 10.3 Single-shot helpers

For applications that don't want the full middleware (e.g. CLI scripts,
webhooks worker), every operation is also exposed directly on the
`realm` handle (`realm.auth.login(...)`, `realm.verify(...)`, etc.).
The middleware is sugar over those primitives, not a parallel
implementation.

## 11. Roadmap (deferred)

Detailed proposals tracked in repo `TODO.md`. Headlines:

- **Platform-defined custom roles + permissions matrix** — replace the
  fixed v0.1.0 enum (§6.3) with platform-authored role definitions
  bound to a permissions list. Needs an ADR (storage shape, default
  roles per platform, migration of existing `owner`/`admin`/`member`/
  `viewer` users, RI-UI surface for role definition).
- Webhooks (`realm.webhooks.verify(payload, signature)`)
- Service-to-service tokens (`auth.serviceToken()`)
- OpenID Connect discovery (`/.well-known/openid-configuration`)
- Impersonation (`auth.impersonate({ targetUserId, reason })`)
- WebAuthn / passkeys
- Custom domains for hosted UIs
- Bulk user import
- CSRF protection layer in the middleware (double-submit-cookie pattern)
- Self-service MFA flows for the current user
  (`realm.auth.mfa.{enroll, confirm, reset}`)
- Idempotency-key pass-through on mutations

## 12. Versioning

The repository tags per SDK with a language prefix
(`ts-v0.1.0`, `go-v0.1.0`, `java-v0.1.0`). Surface changes that break
wire compatibility require **all three** SDKs to bump together. The
spec in this document is authoritative; if an SDK diverges, it is a
bug in that SDK, not a permitted variation.
