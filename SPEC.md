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
| `apiKey`   | no       | Realm API key (`rk_live_...`). Required for every management operation; not needed if the handle is used only for `verify()` or `auth.login()`. |
| `baseUrl`  | no       | Override the issuer host. Default: `https://auth.realmid.dev`.              |
| `httpClient` / `cacheTtl` / `leeway` / `clock` | no | Standard infrastructure overrides for tests and tuning. |

```ts
const realm = createRealm({ realmId: "01HXYZ...", apiKey: "rk_live_..." });
```

> **Audience auto-discovery:** at first use of `verify()`, the SDK calls
> `GET /platforms/mine` (with the API key) — or, if no API key is
> available, falls back to a per-realm metadata endpoint — to learn the
> realm's canonical audience (its domain). The result is cached for the
> lifetime of the handle. Override per-call via `verify(token, { audience })`.

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

### 4.1 `login(req)`

Exchanges a provider token for a realm-scoped session.

Request: `{ method, providerToken, origin?, customClaims? }`
- `method`: `"firebase" | "google"`. Other methods are roadmap.
- `providerToken`: opaque string from the upstream IdP.
- `origin`: optional override. If unset, the SDK does not attach an
  Origin header (server resolves by `realm_id` body field).
- `customClaims`: object of extra claims to merge into the minted access
  token, subject to the realm's server-side allowlist (ADR-005).

Response: `{ accessToken, refreshToken, expiresIn, expiresAt, user, tenants }`
- `tenants`: array of `{ id, role, displayName }` the user belongs to.
- If the server replies with a 412 `mfa_required`, the SDK throws
  `RealmError` with `code: "mfa_required"` and
  `details.mfa_challenge_token` set. Caller follows up with `mfaVerify()`.

### 4.2 `token(req)`

Refresh-token rotation and tenant switch.

Request: `{ refreshToken, tenantId, customClaims? }`
- `tenantId`: required (server contract — even single-tenant calls supply it).
- `customClaims`: **roadmap.** Server today does not accept custom
  claims on `/auth/token`; SDK will silently ignore until server support
  lands (tracked in TODO).

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

All management calls authenticate with the API key. Pagination on every
list endpoint (see §7).

### 6.1 Tenants — `realm.tenants.*`

`list(opts?)`, `get(id)`, `create({ displayName, ... })`, `update(id, patch)`,
`updateConfig(id, patch)`, `delete(id)`, `transferOwner(id, newOwnerUserId)`.

### 6.2 Tenant invitations — `realm.tenants.invitations.*`

`list(tenantId)`, `create(tenantId, { email, ... })`,
`delete(tenantId, invitationId)`.

### 6.3 Users — `realm.tenants.users.*`

`list(tenantId, opts?)`, `get(tenantId, userId)`,
`updateStatus(tenantId, userId, status)`,
`enrollMfa(tenantId, userId)`, `confirmMfa(tenantId, userId, code)`,
`resetMfa(tenantId, userId)`.

### 6.4 Domains — `realm.domains.*`

`claim({ hostname })`, `verify({ claimToken })`.

### 6.5 Platform admin — `realm.platforms.*`

For callers with platform-admin role on their API key.

`list()` (alias of `mine()`), `mine()`, `create({ ... })`,
`tenants.list(platformId)`, `tenants.create(platformId, { ... })`,
`tenants.invitations.create(platformId, tenantId, { ... })`.

### 6.6 Realm self — `realm.realm.*`

`info()` (cached metadata used for audience discovery; expose to caller
for convenience), `apiKeys.create({ ... })`,
`apiKeys.list()`, `apiKeys.revoke(id)`.

## 7. Pagination

Every list endpoint returns a paginated iterator. The SDK fetches one
page at a time and yields items lazily.

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

- API key auth: `Authorization: Bearer <api-key>`. Same header is used
  for user JWTs in calls that need user context (e.g. `listSessions`).
- Origin header: SDK does **not** auto-attach an Origin. Callers pass
  `origin` to `auth.login()` if they want the server to resolve realm
  by hostname; otherwise the explicit `realmId` is used.
- Content type: `application/json` on all request and response bodies.
- Idempotency: SDK does not insert idempotency keys; partners may
  pass-through via a future `requestOptions.idempotencyKey` (deferred).

## 9. Logging / observability

The SDK does not log by default. A debug hook is exposed:

```ts
createRealm({ ..., debug: (event) => console.log(event) });
```

Events are typed (`http_request`, `http_response`, `cache_hit`,
`cache_miss`, `verify_ok`, `verify_fail`). The Go SDK accepts a
`Debug func(Event)`; Java exposes `Config.Builder.debug(Consumer<Event>)`.

## 11. Middleware

Each SDK ships an HTTP middleware adapter for the language's standard
web stack. The middleware is the recommended way to integrate Realm ID
into a partner application — partners do not normally call `auth.login`
or `verify` directly; the middleware does that for them.

| Language    | Adapter                                  |
|-------------|------------------------------------------|
| TypeScript  | Connect-style `(req, res, next) => void` (works with Express, Polka, Connect; thin wrappers shipped for Hono / Cloudflare Workers). |
| Go          | `func(http.Handler) http.Handler`        |
| Java        | `jakarta.servlet.Filter` (with a Spring Security adapter as a sibling artifact). |

### 11.1 Behavior

For every inbound request, the middleware:

1. **Exempt path?** If the request path matches `exemptPaths` (glob list,
   default `["/health", "/public/*"]`), pass through with no auth touched.

2. **Login route?** If `method + path` matches the configured login
   endpoint (default `POST /login`), the middleware **handles the
   request** — it reads `{ method, providerToken, customClaims? }` from
   the body, calls `realm.auth.login(...)`, sets the refresh token as
   an `HttpOnly; Secure; SameSite=Lax` cookie named `realmid_refresh`,
   and returns `{ access_token, expires_in, user, tenants }` as JSON.
   On a 412 `mfa_required`, the response body carries
   `{ status: "mfa_required", mfa_challenge_token, methods }` with a 200
   so the client can branch — the SDK never surfaces the upstream 412.

3. **Logout route?** If `method + path` matches the logout endpoint
   (default `POST /logout`), middleware reads the refresh cookie, calls
   `realm.auth.logout({ refreshToken })`, clears the cookie, returns
   `{ status: "ok" }`.

4. **Refresh route?** If `method + path` matches the refresh endpoint
   (default `POST /token` or `POST /refresh` — pick one default per
   language idiom), middleware reads the refresh cookie + body
   `{ tenant_id }`, calls `realm.auth.token(...)`, rotates the cookie,
   returns `{ access_token, expires_in, tenant_id, role }`.

5. **MFA verify route?** Default `POST /mfa/verify`. Body
   `{ challenge_token, code }`; behaves like login on success.

6. **Otherwise:** require `Authorization: Bearer <access-token>`,
   call `realm.verify(token)`. On success, attach the verified `Claims`
   to the request context (`req.realmid` in TS, `r.Context()` value
   under a typed key in Go, request attribute `realmid.claims` in
   Java). On failure, respond `401` with the SDK's standard error
   envelope: `{ error: { code, message } }`.

### 11.2 Configuration

```ts
const middleware = realm.middleware({
  exemptPaths: ["/health", "/public/*", "/webhooks/*"],
  loginPath: "/login",                    // default
  logoutPath: "/logout",                  // default
  refreshPath: "/token",                  // default
  mfaVerifyPath: "/mfa/verify",           // default
  cookieName: "realmid_refresh",          // default
  cookieDomain?: ".acme.com",             // optional
  cookieSecure: true,                     // default true in production, false otherwise
  onAuthFailure?: (req, err) => Response, // optional override of the 401 response
});
```

Same fields exist in the Go and Java configurations using
language-idiomatic types (`time.Duration`, `Predicate<Request>`, etc.).

### 11.3 Single-shot helpers

For applications that don't want the full middleware (e.g. CLI scripts,
webhooks worker), every operation is also exposed directly on the
`realm` handle (`realm.auth.login(...)`, `realm.verify(...)`, etc.).
The middleware is sugar over those primitives, not a parallel
implementation.

## 12. Roadmap (v0.2.0+)

- **Custom claims on refresh** — `auth.token()` will carry
  `customClaims` once the server supports the allowlist on
  `/auth/token`. Today it is only honored on `/auth/login`.
- **Webhooks** — `realm.webhooks.verify(payload, signature)` for
  signed event delivery. Requires a server-side webhook story.
- **Service-to-service tokens** — `auth.serviceToken()` for M2M flows.
- **OpenID Connect discovery** — `realm.info()` will read the
  per-realm `.well-known/openid-configuration` document for issuer /
  jwks_uri / token_endpoint discovery.

## 13. Versioning

The repository tags per SDK with a language prefix
(`ts-v0.1.0`, `go-v0.1.0`, `java-v0.1.0`). Surface changes that break
wire compatibility require **all three** SDKs to bump together. The
spec in this document is authoritative; if an SDK diverges, it is a
bug in that SDK, not a permitted variation.
