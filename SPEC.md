# Realm ID SDK — cross-language specification (v0.5.0)

## Breaking changes from 0.4.x

v0.5.0 is a clean cut aligned with the server's v0.5.0 release. Two
breaking changes; no deprecation window, no compat shims.

1. **Admin sub-paths moved from `/realms/{id}/...` to
   `/platforms/{id}/...`** (ADR-044). Affected: `apiKeys.*`,
   `config.update`, `roles.*`. The OIDC discovery surface
   (`/realms/{realm}/.well-known/...`) is unchanged. The high-level
   SDK methods kept their names — only the wire path moved.

2. **`open_signup` bool replaced by `signup_mode` enum** (ADR-045).
   `TenantCreate` and `TenantConfig` carry `signup_mode:
   "closed" | "allowlist" | "open"` instead of an `open_signup`
   boolean. `open` is rejected on any tenant other than the base
   admin tenant.

See `CHANGELOG.md` and the ADRs for full details.

This document is the contract every official SDK in this repository
implements. The TypeScript SDK is the canonical reference; the Go and
Java SDKs mirror it idiomatically.

### Browser SDK split

The `sdk/web/` sub-monorepo packages the browser surface as two
independently consumable SDKs:

| Package              | Role                                              |
|----------------------|---------------------------------------------------|
| `@realmid/web`       | Tenant-app SDK. Auth, login, refresh, storage adapters, multi-tab. Partners building a customer-facing app use this directly. |
| `@realmid/web-admin` | Admin-UI SDK. Tenants, users, roles, api keys, domains, platforms, notes, signing keys, BFF aggregates. Companion to `@realmid/web` for partners building their own admin console. |

`@realmid/web-admin` reuses the hand-written resource clients shipped
by the Node SDK (`@realmid/sdk`) via a new `@realmid/sdk/internal`
entry. That means SPEC §6.1 (tenants), §6.2 (invitations), §6.3
(users), §6.4 (domains), §6.5 (realm self / api keys), §6.7 (token
revocation) are **shared** between the node and browser admin
surfaces — same wire shapes, same semantics; only the transport layer
differs.

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
| `tokenDelivery` | no  | `"cookie" \| "body"`. How the middleware returns refresh tokens (see §10.2). Default `"cookie"`. |
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

### 4.0 Two-endpoint auth surface (ADR-051)

The public auth surface is exactly two endpoints:

```text
POST /auth/login   credentials → refresh token (+ access if resolved)
POST /auth/token   refresh token → rotated refresh + access pair
```

`/auth/login` accepts a `grant_type` discriminator. Five values:

| `grant_type`       | Inbound bearer        | Subject minted | Used by SDK for |
| ---                | ---                   | ---            | --- |
| `provider_token`   | platform access JWT   | `user`         | `auth.login({ method: "firebase" \| "google" })` |
| `password`         | platform access JWT   | `user`         | (roadmap — native u/p) |
| `otp_internal`     | platform access JWT   | `user`         | `auth.otpLogin(...)` |
| `api_key`          | none (raw key in body) | `service`     | (server-only today) |
| `platform_api_key` | none (raw key in body) | `platform`    | the SDK's platform-session bootstrap |

Login is a **two-step exchange** internal to the SDK; partners see one
call. The raw API key is **never** sent on user-login traffic. The SDK
keeps a per-handle session manager that:

1. **Platform login** — first call: `POST /auth/login` with body
   `{ grant_type: "platform_api_key", api_key: "rk_live_..." }`.
   Response: `{ status, subject_type: "platform", refresh_token,
   access_token, expires_in }`. The SDK caches both tokens.
2. **User session mint** — `POST /auth/login` with the cached platform
   access token in `Authorization: Bearer ...` and a user grant in the
   body (`grant_type: "provider_token"`, `provider`, `token`). The
   server validates both — the platform token authorizes the *caller*;
   the provider token authenticates the *user*.
3. **Access refresh** — when the cached platform access token enters
   its 30 s pre-expiry window: `POST /auth/token` with the refresh
   token as `Authorization: Bearer ...`. Response is the same shape
   as `/auth/login` for service/platform grants. If `/auth/token`
   401s (refresh revoked / rotated by another caller), the SDK falls
   back to a fresh platform login (step 1) transparently.

Whether the platform refresh token rotates is **realm-configurable**
(see §4.3). Default: non-rotating — the response's `refresh_token`
field will equal the one the SDK sent. Rotating mode (single-use
refresh, reuse-detection lifecycle) is opt-in per realm.

This is the marketing talking point: API keys never travel over user
login traffic, and a leaked login-route capture cannot be replayed
past the platform access token's TTL.

> **Hard cut from pre-v0.10 SDKs**: the legacy `POST /auth/service-token`
> and `POST /auth/platform-token` endpoints are gone. SDK 0.10+ does
> not call them; older SDKs will fail loudly against an api `v0.7.0`+
> server.

### 4.1 `login(req)`

Exchanges a provider token for a realm-scoped session. On the wire the
SDK posts to `POST /auth/login` with a `grant_type` discriminator
(ADR-051):

| SDK `method`     | Wire `grant_type`  | Extra body |
| ---              | ---                | --- |
| `"firebase"`     | `"provider_token"` | `provider: "firebase_phone"`, `token: <id token>` |
| `"google"`       | `"provider_token"` | `provider: "google"`, `token: <id token>` |
| `"otp_internal"` | `"otp_internal"`   | `identifier`, `presented` (use the `auth.otpLogin` helper) |

Request (Go/TS surface unchanged from 0.9.x): `{ method, providerToken, origin? }`
- `method`: `"firebase" | "google" | "otp_internal"`. `otp_internal`
  is the partner OTP login (see §X), gated server-side by
  `realms.config.otp_login_enabled`. When `method == "otp_internal"`,
  callers should use the typed helper `auth.otpLogin(...)` /
  `Auth.OTPLogin(...)` rather than the generic `login()` — it
  carries the `identifier` + `presented` body shape directly.
  Other methods are roadmap.
- `providerToken`: opaque string from the upstream IdP.
- `origin`: optional override. If unset, the SDK auto-attaches the
  Origin derived from the realm's claimed domain (see §1).

The wire response includes a typed `subject_type` ∈ `{user, service,
platform}` (ADR-051 §3). For user grants the SDK exposes the high-level
fields:

Response: `{ accessToken, refreshToken, expiresIn, expiresAt, user, tenants }`
- `tenants`: array of `{ id, role, displayName }` the user belongs to.
- If the server replies with a 412 `mfa_required`, the SDK throws
  `RealmError` with `code: "mfa_required"` and
  `details.mfa_challenge_token` set. Caller follows up with `mfaVerify()`.

> Custom claims are **not** accepted on login. The refresh token carries
> identity only. Custom claims belong on the access token (see §4.2).

### 4.2 `token(req)`

Refresh-token rotation, tenant switch, and **custom claim injection on
the minted access token**. Wire: `POST /auth/token` with the refresh
token presented as `Authorization: Bearer ...` (or in the body as
`refresh_token`).

Request: `{ refreshToken, tenantId, customClaims? }`
- `tenantId`: required for multi-tenant user picks; ignored on
  service / platform refresh tokens (ADR-051).
- `customClaims`: object of extra claims to merge into the minted
  **access token**, subject to a per-realm server-side allowlist. Use
  this to carry app-state fields (e.g. `outlet_ids`) that downstream
  services need to authorize without a database lookup.

Response: `{ accessToken, refreshToken, expiresIn, tenantId, role,
subjectType }`. `subjectType` ∈ `{user, service, platform}` (ADR-051);
`tenantId` and `role` are user-only.

**Refresh rotation policy (ADR-051):**

- **User refresh** always rotates on `/auth/token` (today's behavior;
  ADR-031 reuse-detection store).
- **Service / platform refresh** rotate **only when the realm opts
  in** via two new realm-config keys (PATCHable on
  `/platforms/{id}/config`):

  | Key                          | Default | Effect when `false`                                                | Effect when `true`                                                                |
  | ---                          | :---:   | ---                                                                | ---                                                                               |
  | `service_refresh_rotates`    | `false` | Service refresh is multi-use until exp; no reuse-detection.        | Single-use; `/auth/token` rotates and runs reuse-detection.                       |
  | `platform_refresh_rotates`   | `false` | Platform refresh is multi-use until exp; no reuse-detection.       | Single-use; `/auth/token` rotates and runs reuse-detection.                       |

  Defaults are off to match the legacy "platform tokens are
  essentially single-shot" posture. Realms that want long-lived
  rotating M2M sessions flip them on and accept the reuse-detection
  lifecycle. `platform_refresh_rotates` is meaningful only on a base
  realm; on partner realms the PATCH succeeds but is a no-op.

  Service / platform refresh TTL reuses
  `realms.config.refresh_ttl_seconds` (no new TTL knob).

### 4.3 `mfaVerify(req)`

Completes an MFA challenge.

Request: `{ challengeToken, code, method? }` — `method` defaults to
`"totp"`. Set `"otp_internal"` to consume a manager-issued partner
OTP as the second factor (see §X); the typed helper
`auth.mfaVerifyOtp(...)` / `Auth.MFAVerifyOTP(...)` wraps this. On
the wire the request body uses `mfa_challenge_token` (not
`challenge_token`) — the SDK serialises it correctly; partners
hitting HTTP directly should match.

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

All management calls authenticate via the two-endpoint flow (§4.0,
ADR-051): the SDK exchanges the API key for a platform session via
`POST /auth/login {grant_type: "platform_api_key"}`, refreshes via
`POST /auth/token`, and sends the cached platform access token as
`Authorization: Bearer ...` on every management call. Pagination on
every list endpoint (see §7).

> **Why no `realm.platforms.*`?** A partner has exactly one platform
> (themselves) and exactly one realm. The cross-platform admin surface
> (creating new platforms, listing all platforms) is a RealmID
> operations concern, not a partner concern, and lives in a separate
> `realmid-admin` CLI. The partner SDK exposes only what a partner
> integration actually uses.

### 6.1 Tenants — `realm.tenants.*`

- `list(opts?)` — paginated. `opts: { cursor?, limit? }`.
- `get(id)`
- `create({ displayName, allowedDomains?, signupMode? })` — creates a
  tenant under the calling platform. The realm is implicit (the API
  key's realm); there is no separate "platform" parameter because a
  partner has one platform per realm. Wire call:
  `POST /platforms/{realmId}/tenants`. `signupMode` defaults to
  `"closed"` server-side (ADR-045).
- `update(id, { displayName? })` — top-level mutable fields.
- `updateConfig(id, patch)` — patches `tenants.config`. Honoured keys:
  `allowedDomains: string[]` (auto-provision domain allowlist),
  `signupMode: "closed" | "allowlist" | "open"` (per-tenant signup
  policy, ADR-045 — `open` is reserved for the base admin tenant and
  rejected on partner tenants). Server enforces an allowlist of
  accepted keys; unknown keys → `RealmError(bad_request)`.
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
- Role updates live on the tenant surface (so they sit alongside
  `transferOwner`): use `tenants.updateUserRole(tenantId, userId, role)`
  / Go `Tenants.UpdateUserRole(ctx, tenantID, userID, role)`. Cannot
  demote the last owner; use `tenants.transferOwner` for an owner
  handover. Caller must hold a role of `owner` (or realm-admin via API
  key).
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

### 6.6 Origin allowlist enforcement — `realm.origins.*`

ADR-047 §1.1 redrafted the v0.6.0 login surface so that **every scoped
read or write against RealmID flows through a partner backend holding
a platform token**. Browsers do not call `/auth/login` or
`/platforms/{id}/identity-providers` directly; the partner exposes
its own unauthenticated proxy, and origin enforcement moves out of
RealmID and into the SDK.

Partners MUST call `origins.validate(...)` (or fetch + check manually
via `origins.list(...)`) inside any unauthenticated proxy that
forwards to a platform-token-gated RealmID endpoint. Skipping the
validation step opens the proxy to confused-deputy callers — RealmID
no longer inspects `Origin` on those routes.

Surface — symmetric across runtimes:

- `client.origins.list({ realmId })` — paginated `Origin` rows from
  `GET /platforms/{realmId}/origins` (ADR-049 §A.7.2). Auth via the
  per-handle platform token. Wire shape per §7.
- `client.origins.validate({ realmId, origin })` → `boolean`.
  Normalises `origin` (lowercase, strip scheme + port + path), looks
  it up in the per-realm cache, returns true iff a live row matches.

Cache semantics:

- In-memory, keyed by `realmId`.
- TTL: **5 minutes**. Expiry triggers a full refetch on the next
  validate.
- On `401 unauthorized` from the underlying list call, the SDK
  invalidates its cached platform token, mints a fresh one, and
  retries once. A second 401 propagates as a `RealmError(unauthorized)`.
- The allowlist contains every live `domain` regardless of
  `entity_type` — partners' SPAs may legitimately sit on either a
  realm SPA origin or a tenant custom-domain row. Both pass.

Staleness window: a domain attached or detached on RealmID may take
up to 5 minutes to propagate to a given partner-backend replica.
Partners that need stricter freshness for a high-risk operation can
call `origins.invalidate(realmId)` to drop the cache and force a
refetch, but the default TTL is the documented contract.

### 6.7 Access-token revocation cache — `client.tokens.*`

ADR-047 §1.1 routes every scoped read/write through the partner
backend, which uses the SDK to call RealmID. RealmID handles
**refresh-token** revocation server-side via `POST /auth/logout`. The
SDK adds **partner-side defense-in-depth** for access tokens: on
logout, the SDK caches the access token's JTI locally so subsequent
requests presenting that JTI are rejected without needing a server
round-trip. This bounds the "stolen access token" replay window
without requiring RI to add per-access-token revocation state.

Surface — symmetric across runtimes:

- `tokens.markRevoked(accessToken)` — extracts the JWT's `jti` and
  `exp`, stores the JTI in cache with TTL = `exp - now()`. No-op when
  `exp` is in the past or when `jti`/`exp` are missing.
- `tokens.isRevoked(accessToken)` — `boolean`. True iff the JTI is in
  cache and not expired. Lazy GC: stale entries are evicted on read.
- `tokens.revokeOnLogout` — composable middleware that wraps a
  `logout()` call. Extracts JTI/exp from the access token **before**
  the network call, runs the network logout (RI's `POST /auth/logout`),
  then on **either success or transport failure** marks the JTI
  revoked locally. Rationale: partner backend should fail closed — if
  RI is unreachable, the access token still gets blackholed locally
  so the user is logged out from the partner's perspective.
- `tokens.gateRequest(accessToken)` — per-request gate the partner's
  middleware calls before forwarding upstream. If the JTI is in cache,
  throws `TokenRevokedError` (TS) / returns `ErrTokenRevoked` wrapped
  in `RealmError(unauthorized, details.revoked=true)` (Go) / throws
  `TokenRevokedException` (Java).

Cache implementation:

- TS: `Map<jti, expiresAt>`, single-threaded.
- Go: `sync.RWMutex` + `map[string]time.Time`, lazy GC on read.
- Java: `ConcurrentHashMap<String, Long>`, lazy GC on read.
- All three accept an injectable clock (default = system clock) for
  deterministic testing — same pattern as the origins cache.

TTL semantics: an entry's TTL equals the access token's remaining
`exp`. Lazily evicted on read; repeated `markRevoked` of the same JTI
does not grow the cache.

**Multi-pod staleness window.** The cache is **per-process**. A logout
served by pod A does not propagate to pod B; a stolen access token
can still be replayed against pod B for up to its remaining TTL. This
is acceptable for v1; partners running multi-replica deployments
should be aware of the bound. **v1.1 swap-in:** a Redis-backed
implementation behind the same surface, out of scope for the initial
ship.

Recommended partner integration:

- Wire `tokens.revokeOnLogout(authClient.logout)` on the BFF logout
  handler so logout is a single call from the SPA's perspective.
- Wire `tokens.gateRequest(accessToken)` in the inbound middleware
  immediately after `verify()` succeeds, before forwarding to RealmID
  or to internal services.

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

## 7.5 Admin surface (`realm.admin.*`)

Read-only aggregates for the RealmID admin console (ADR-048). All four
endpoints are gated **server-side** on base-realm staff (a base-realm
admin-user JWT or a service JWT scoped to the base realm). The SDK
does **not** gate locally — it forwards the platform-token bearer and
surfaces the API's `403 forbidden` envelope as the standard
`RealmError(forbidden)`. Cursor pagination follows §7 (opaque base64
offset cursor; `next_cursor: null` signals the last page).

Surface — symmetric across runtimes:

- `admin.listPlatforms(opts?)` → `AdminPlatformsResponse`
  Wraps `GET /admin/platforms`. Filters: `q`, `status[]`, `signupMode[]`,
  `domain`, `ownerUserId`, `hasCustomDomain`, `createdAfter`,
  `createdBefore`, `lastActivityAfter`, `lastActivityBefore` (all unix
  seconds), `sort`, `cursor`, `limit` (1..200, default 50). Multi-value
  filters are sent as comma-joined values; the server accepts both
  comma-separated and repeated-param forms.

- `admin.stats()` → `AdminStats`
  Wraps `GET /admin/stats`. Server caches for 30s.

- `admin.listEvents(opts?)` → `AdminEventsResponse`
  Wraps `GET /admin/events`. Filters: `platformId`, `tenantId`,
  `actorId`, `kind[]`, `since`, `until` (unix seconds), `cursor`,
  `limit`.

- `admin.search(q, limit?)` → `AdminSearchResponse`
  Wraps `GET /admin/search`. Typeahead over platforms + tenants. Not
  paginated — server caps `limit` at 25 (default 10).

Response shapes (JSON wire, identical in all SDKs):

```
PlatformSummary { id, display_name, slug, status, signup_mode,
                  domains[], owner { user_id, name, email },
                  tenants_count, users_count,
                  last_activity_at (unix s), created_at (unix s) }
AdminPlatformsResponse { items: PlatformSummary[],
                         next_cursor: string | null,
                         total: int }
AdminStats { platforms_count, tenants_count, users_count,
             sessions_active, events_24h }
AuditEvent { id (int64), occurred_at (unix s), kind,
             actor_user_id?, actor_label?,
             platform_id?, tenant_id?,
             target_type?, target_id?,
             summary? }
AdminEventsResponse { items: AuditEvent[],
                      next_cursor: string | null }
SearchHit { type: "platform" | "tenant", id, label,
            sublabel?, platform_id? }
AdminSearchResponse { items: SearchHit[] }
```

The cursor is opaque (base64-encoded offset). Callers must forward the
returned `next_cursor` verbatim on the next call; tampered or invalid
cursors are silently treated as the first page.

## 8. HTTP wire conventions

- **Auth header:** `Authorization: Bearer <token>`. The token is a
  short-lived platform access token (§4.0, ADR-051) for management
  calls, the user's bearer JWT for user-context calls
  (e.g. `listSessions`), or the platform refresh token for `POST
  /auth/token`. The raw API key never travels in `Authorization`; on
  the bootstrap call it lives only inside the body of `POST
  /auth/login` with `grant_type: "platform_api_key"`.
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
| info  | platform login + access-token refresh (§4.0)|
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

   On a path that requires MFA (declared via `mfaProtectedPaths`),
   evaluate **MFA freshness** (see §10.4). On miss, respond **`412`**
   with the standard envelope:
   ```json
   {
     "error":              { "code": "mfa_required", "message": "..." },
     "mfa_challenge_token": "...",
     "methods":            ["totp"],
     "max_age_seconds":     900,
     "reason":              "no_mfa" | "stale_mfa" | "fresh_required"
   }
   ```

### 10.2 Configuration

```ts
const middleware = realm.middleware({
  exemptPaths: ["/health", "/public/*", "/webhooks/*"],

  // Sugar — strings inherit the realm-default freshness window.
  // Use the object form for per-route overrides.
  mfaProtectedPaths: [
    "/admin/*",                                          // realm default (typically 15 min)
    { path: "/account/email",  maxAgeSeconds: 300 },     // 5-min freshness window
    { path: "/billing/charge", requireFresh: true },     // every operation requires a fresh challenge
  ],

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
language-idiomatic types (`time.Duration` for `MaxAge`,
`Predicate<Request>`, etc.).

#### Cookie vs body — when to pick which

- **`"cookie"` (default).** Refresh token is set as `HttpOnly; Secure;
  SameSite=Lax` on the BFF response, so browser JS can never read it
  and XSS cannot exfiltrate it. This is the right choice for **any
  browser SPA whose API requests go through a same-site BFF** — i.e.
  the partner's frontend and backend share an eTLD+1. The SDK's
  middleware reads/writes the cookie; the SPA only sees the
  short-lived access token.
- **`"body"`.** Refresh token is returned inline in the JSON response
  and the client is responsible for storing it. Pick this only when a
  cookie is not viable: native iOS/Android apps, CLIs, server-to-server
  agents, or cross-origin SPAs that genuinely cannot front their API
  through a same-site BFF. Treat the refresh token as a credential —
  store it in the platform secure store (Keychain / Keystore), not in
  `localStorage`.

If you are unsure, you almost certainly want `"cookie"`. A "SPA on
`app.example.com` calling `api.example.com`" deployment is still
same-site and should use cookie mode with `cookieDomain: ".example.com"`.

### 10.4 MFA freshness model

A middle-ground between "MFA once per session" and "MFA on every
operation" — partner picks per route.

**Token claim.** Access tokens carry `mfa_at` (unix-seconds) — the
timestamp of the user's most recent successful MFA challenge.
Absent or `0` means MFA never verified for this session.

**Server source of truth.** `sessions.mfa_verified_at` (TIMESTAMPTZ).
- `POST /auth/mfa/verify` → `UPDATE sessions SET mfa_verified_at = now()`.
- `POST /auth/login` → set if the login flow itself completed MFA;
  otherwise NULL.
- `POST /auth/token` (refresh-mint) → reads `sessions.mfa_verified_at`
  and projects into the next access token's `mfa_at` claim.
- Logout / session revoke → row dropped; freshness vanishes with it.
- `DELETE /auth/mfa` (disable MFA for the current user) → NULLs
  `mfa_verified_at` for **all** sessions of that user, forcing re-MFA
  on the next protected operation.

**Per-route policy.** Each entry in `mfaProtectedPaths` is either a
string (sugar for the realm default) or an object:
```ts
{
  path: string;           // glob: "*" matches a segment, "**" matches any
  maxAgeSeconds?: number; // freshness window. Omitted → realm default.
                          // 0 → reject any non-fresh proof (≈ requireFresh).
  requireFresh?: boolean; // true → require mfa_at within ~30 s.
                          // Use for irreversible / high-risk operations.
}
```
Realm-wide default lives at
`realms.config.mfa_session_ttl_seconds` (suggested 900 = 15 min).

**Gate logic** (run after `realm.verify(token)` succeeds):
1. Find the matching `mfaProtectedPaths` entry. If none, pass.
2. If `requireFresh: true`: require `now - mfa_at ≤ 30 s` (small grace
   so the client has time to retry the original op after `mfaVerify`).
3. Else: require `now - mfa_at ≤ maxAgeSeconds` (or the realm default
   if unspecified).
4. On miss: respond `412 mfa_required` with the envelope above. The
   `reason` field distinguishes:
   - `no_mfa` — `mfa_at` missing or `0`.
   - `stale_mfa` — `mfa_at` present but older than `maxAgeSeconds`.
   - `fresh_required` — route demanded a fresh challenge regardless.

**SDK middleware enforces locally.** The middleware reads `mfa_at`
from the verified claims it already holds and applies the policy
without an extra round trip. The server's `RequireMFA(pattern, opts)`
registry is the backstop for non-SDK callers.

**Step-down semantics (advanced).** Some workflows want "after this
op, fall back to non-MFA" (require fresh MFA next time). Expose a
`session.clearMFA()` helper for protected handlers — the gate itself
does not auto-clear. Combined with `requireFresh: true`, this
enforces "fresh MFA per operation" without coupling the gate to the
handler.

### 10.5 Single-shot helpers

For applications that don't want the full middleware (e.g. CLI scripts,
webhooks worker), every operation is also exposed directly on the
`realm` handle (`realm.auth.login(...)`, `realm.verify(...)`, etc.).
The middleware is sugar over those primitives, not a parallel
implementation.

## X. OTP primitive (`realm.otp.*` + `auth.otpLogin` / `auth.mfaVerifyOtp`)

Partner-issued one-shot codes. Issuer mints, RealmID hashes, consumer
verifies; the same primitive composes into `/auth/login` (single
factor) and `/auth/mfa/verify` (second factor) and as a generic
delivery / approval gate. Authoritative reference:
`api/docs/proposals/partner-otp-primitive.md`. Server-side semantics:
`api/docs/design.md §OTP Primitive`.

### X.1 `realm.otp.issue(req)` / `Realm.OTP.Issue(...)`

Mints a code for `(subject_ref, purpose)`. Multiple issuers may issue
concurrently; codes stack until consumed or expired.

Request: `{ subjectRef, purpose }` — both opaque tenant-scoped strings.
Response: `{ id, value, expiresAt, purpose, subjectRef }`.

Length and TTL come from `realms.config.otp_length` (default 6) and
`realms.config.otp_ttl_seconds` (default 60). Per-call overrides are
rejected.

### X.2 `realm.otp.view(otpId)` / `Realm.OTP.View(...)`

Re-fetches plaintext from Redis. Issuer-scoped (the bearer's
`(tenant_id, user_id)` must match the row's). After TTL the cache
expires and the call returns `RealmError("not_found")` even if the
underlying row remains verifiable. Use this when the partner UI
re-renders the manager's pending codes.

Response: `{ id, value, expiresAt, purpose, subjectRef, issuerUserId }`.

### X.3 `realm.otp.verify(req)` / `Realm.OTP.Verify(...)`

Hashes `presented` and consumes the first matching active row.

Request: `{ subjectRef, purpose, presented }`.
Response: `{ otpId, issuerUserId, issuedAt, subjectRef, purpose }`.
Errors:
- `RealmError("invalid_otp")` — no active row matches.
- `RealmError("otp_expired")` — matched row is expired.
- `RealmError("otp_locked")` — ≥5 fails / 15 min on the
  `(tenant, subject_ref, purpose)` triple.

### X.4 `auth.otpLogin(req)` / `Auth.OTPLogin(...)` — single factor

Wraps `POST /auth/login` with `method=otp_internal`. Realm
precondition: `otp_login_enabled = true`.

Request: `{ realmId, identifier, presented }` — `identifier` is an
E.164 phone or email; the server resolves it to a tenant-scoped user.
Response: same shape as `login()`.

### X.5 `auth.mfaVerifyOtp(req)` / `Auth.MFAVerifyOTP(...)` — second factor

Wraps `POST /auth/mfa/verify` with `method=otp_internal`. Realm
precondition: `otp_mfa_enabled = true` **and** the user is enrolled
in `otp_internal` (per-user `mfa_methods` or per-role
`required_mfa_methods`).

Request: `{ mfaToken, presented }` (TS) / `{ MFAToken, Presented }` (Go).
Response: same shape as `login()`.

### X.6 a partner worked examples

```ts
// Two-factor login
try {
  await realm.auth.login({ method: "google", token: idToken });
} catch (e) {
  if (e instanceof RealmError && e.code === "mfa_required") {
    const mfaToken = String(e.details?.mfa_challenge_token);
    // (manager-side) issue
    const otp = await realm.otp.issue({ subjectRef: `user:${saId}`, purpose: "login" });
    // (SA-side) verify
    const session = await realm.auth.mfaVerifyOtp({ mfaToken, presented: otp.value });
  }
}

// Single-factor login
const session = await realm.auth.otpLogin({
  realmId, identifier: "+919999000011", presented: otp.value,
});

// Delivery gate
await realm.otp.verify({
  subjectRef: `booking:${bookingId}`, purpose: "delivery", presented: code,
});
```

```go
// Two-factor login
_, err := r.Auth.Login(ctx, realmid.LoginRequest{Method: "google", Token: idToken})
var rerr *realmid.RealmError
if errors.As(err, &rerr) && rerr.Code == "mfa_required" {
    mfaToken, _ := rerr.Details["mfa_challenge_token"].(string)
    otp, _ := r.OTP.Issue(ctx, tenantID, realmid.OTPIssueRequest{
        SubjectRef: "user:" + saID, Purpose: "login",
    })
    sess, _ := r.Auth.MFAVerifyOTP(ctx, realmid.MFAVerifyOTPRequest{
        MFAToken: mfaToken, Presented: otp.Value,
    })
    _ = sess
}

// Single-factor login
_, _ = r.Auth.OTPLogin(ctx, realmid.OTPLoginRequest{
    RealmID: realmID, Identifier: "+919999000011", Presented: otp.Value,
})
```

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
