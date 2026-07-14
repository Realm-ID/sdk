# Realm ID SDK — cross-language specification (v0.10.0)

## v0.10.0 — workload identity federation (token-exchange grant, additive, ADR-057)

Additive (non-breaking on the wire). Adds a sixth `/auth/login` grant —
`urn:ietf:params:oauth:grant-type:token-exchange` — letting a partner
workload authenticate with its **ambient** cloud OIDC token (GCP Cloud
Run/GKE/GCE or GitHub Actions) instead of a stored `rk_live_` API key.
The workload token is treated as **≡ the API key**: a bootstrap
credential presented once and exchanged for the *identical*
`class="platform"` session — below the exchange line everything is the
same as the API-key path. SDKs gain a pluggable **`CredentialSource`**
(the static API key becomes one implementation; the ambient-token
providers are the others) plus a zero-config auto-detecting default.
Trust is configured RI-side per platform via `federation_bindings`; the
SDK carries **no secret**. Go ships first; TS/Java follow in lockstep.
See §4.0.1.

## v0.9.0 — verified on-behalf-of via `X-User-Token` (additive, ADR-056)

Additive (non-breaking on the wire). Documents the verified on-behalf-of
variant: a BFF holding the user's access JWT forwards it as `X-User-Token`
alongside the platform bearer, so the issuer authorizes a cryptographically
verified principal instead of a spoofable `X-On-Behalf-Of-User` id. The
issuer prefers the token and rejects (no downgrade) a present-but-invalid
one. Server-side only — the **Go** SDK exposes it now
(`PassthroughOptions.OnBehalfOfUserToken` + `WithUserToken`); TS/Java inherit
it through the existing on-behalf parity gap. See §4.10's "Verified
on-behalf-of" note.

## v0.8.0 — token manager + refresh_invalid + api-key DTO (additive)

Additive (non-breaking on the wire). Adds the `refresh_invalid` error
code (§3.1), the long-lived-client **token manager** construct (§4.2.1),
and pins the api-key list/row DTO to the issuer's authoritative shape
(§6.5 — `role`/`prefix`/unix-second timestamps; the create `value` is a
one-time secret). Go + TS ship this; Java parity is a tracked follow-up.

## Breaking changes from 0.5.x

v0.6.0 aligns the SDKs with the server's v0.11.0 contact model
(ADR-042). A user's identifiers (email / phone) are no longer columns
on the user row — they are `user_contacts` rows with an independent
verification lifecycle. The SDK surface changes accordingly:

1. **Invitations are keyed by `identifier`, not `email`** (§6.2).
   `invitations.create(tenantId, { identifier, role? })` replaces
   `{ email, role? }`. `identifier` is an email **or** an E.164 phone.
   The response is now `{ id, identifier, role, status, expiresAt }`
   where `id` is the **stable user id** allocated at invite time
   (invites pre-provision the user row in `invited` status). Re-inviting
   a still-pending identifier is idempotent.

2. **New admin review surfaces** (additive): `realm.tenants.driftReviews.*`
   (§6.8) for the returning-login contact-drift queue, and
   `realm.tenants.contactVerifications.*` (§6.9) for the first-login
   step-up gate on recycled identifier slots.

3. **`users.updateContact`** (§6.3) — admin email/phone changes now go
   through a dedicated method that soft-releases the old contact and
   issues a new one; the old `users.update`-style contact mutation is
   gone.

See `CHANGELOG.md` and ADR-042 for full details.

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
| `@realm-id/web`       | Tenant-app SDK. Auth, login, refresh, storage adapters, multi-tab. Partners building a customer-facing app use this directly. |
| `@realm-id/web-admin` | Admin-UI SDK. Tenants, users, roles, api keys, domains, platforms, notes, signing keys, BFF aggregates. Companion to `@realm-id/web` for partners building their own admin console. |

`@realm-id/web-admin` reuses the hand-written resource clients shipped
by the Node SDK (`@realm-id/sdk`) via a new `@realm-id/sdk/internal`
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

> **Audience (ADR-064):** the token `aud` is the platform-intrinsic,
> immutable value `realmid:<public_ref>` — decoupled from the routing
> domain so it cannot collide on domain reuse or move on domain transfer.
> At first use of `verify()`, the SDK learns it from `GET /platforms/mine`
> (`audience` field) and caches it for the lifetime of the handle. There is
> **no fallback to the domain** (removed) — a realm always has an audience.
> The token also carries an informational `domain` claim (display/routing
> only, **never** an isolation key). Override the expected audience per-call
> via `verify(token, { audience })`.

## 2. Caching

Only **JWKS** are cached (10 min TTL, unknown-kid forces refetch). All
other responses (realm metadata, tenants, users, etc.) are returned
fresh on every call. There is no in-SDK request coalescing.

## 3. Errors

**Success vs failure boundary.** Every SDK treats the **entire `2xx`
class** as success — never an exact `200` check. The API uses a uniform
`200` `{data:...}` envelope (issuer ADR-069): every endpoint returns
`200` on success, including all DELETEs (which carry a `{status:...}`
body), EXCEPT genuine resource-creation POSTs (`POST /platforms`,
`/identity-providers`, `/platforms/{id}/{api-keys,roles,origins,
federation-bindings}`, `/platforms/{pid}/tenants`, and the invitation
creates), which return `201 Created`. A response is an error iff its
status is `>= 400`; `204` (should not occur post-ADR-069) decodes to an
empty success. This is descriptive — the SDKs already behave this way
(Go: `< 400`; TS: `resp.ok`; Java: `200 ≤ s < 300`), so ADR-069 requires
no SDK code change and no version bump.

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
`account_deactivated`, `realm_origin_mismatch`, `realm_mismatch`,
`missing_origin`, `refresh_invalid`.

> `realm_mismatch` is a **client-side** code (ADR-041 realm pin): the SDK
> decodes the platform access token it just minted and confirms the `iss`
> references the configured `realmId`. A mismatch (the SDK was constructed
> for realm A but the API key / workload credential belongs to realm B)
> is a confused-deputy bug; the SDK raises `realm_mismatch` locally
> **before** any subsequent management call rather than letting it surface
> as a cryptic downstream 4xx. It is never emitted by the issuer on the
> partner surface. Go and TS perform this pin today; Java carries the code
> for taxonomy parity (its pin is a tracked follow-up).

> `refresh_invalid` is returned by `POST /auth/token` (and surfaced by
> `auth.token()` / the token manager) when the presented refresh token is
> **expired, revoked, or reuse-detected** — terminal for the caller, no
> retry will help. It is distinct from a generic `unauthorized` so
> long-lived clients can deterministically branch on "re-authentication
> required" versus a transient 401. The SDK does **not** subdivide
> expiry / revocation / reuse: all three collapse to `refresh_invalid`
> (the issuer does not distinguish them on the wire).

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

`/auth/login` accepts a `grant_type` discriminator. Six values:

| `grant_type`       | Inbound bearer        | Subject minted | Used by SDK for |
| ---                | ---                   | ---            | --- |
| `provider_token`   | platform access JWT   | `user`         | `auth.login({ method: "firebase" \| "google" })` |
| `password`         | platform access JWT   | `user`         | (roadmap — native u/p) |
| `otp`              | platform access JWT   | `user`/`service` | `auth.otpLogin(...)` (ADR-071 §4 renamed from `otp_internal`) |
| `api_key`          | none (raw key in body) | `service`     | (server-only today) |
| `platform_api_key` | none (raw key in body) | `platform`    | the SDK's platform-session bootstrap |
| `urn:ietf:params:oauth:grant-type:token-exchange` | none (workload OIDC JWT in body) | `platform` | the SDK's zero-config workload bootstrap (§4.0.1) |

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

### 4.0.1 Workload identity federation (token-exchange grant, ADR-057)

A partner workload running with an **ambient** cloud identity (a GCP
Cloud Run/GKE/GCE service account or a GitHub Actions workflow) can mint
a short-lived OIDC token on demand and present it **in place of** a
stored API key. The token is a bootstrap credential equivalent to the
API key: it is exchanged once at `POST /auth/login` for the *identical*
`class="platform"` session, and never re-sent on subsequent traffic
(the SDK rides the platform access token exactly as it does for the
API-key path).

**Wire — the exchange (step 1 substitute for `platform_api_key`):**

```text
POST /auth/login
{
  "grant_type":         "urn:ietf:params:oauth:grant-type:token-exchange",
  "subject_token":      "<workload OIDC JWT>",
  "subject_token_type": "urn:ietf:params:oauth:token-type:jwt"
}
→ { status, subject_type: "platform", refresh_token, access_token, expires_in }
```

The response shape is identical to the `platform_api_key` exchange;
steps 2 (user-session mint) and 3 (refresh) are unchanged.

**`CredentialSource` (SDK).** The per-handle session manager's credential
is generalized from a fixed API-key string to a `CredentialSource` that
yields a fresh credential at login time:

- `StaticAPIKey(key)` — today's behavior; emits `{ grant_type:
  "platform_api_key", api_key }`. Selected when `APIKey` is configured.
- `GoogleWorkloadIdentity` — fetches an ID token from the GCP metadata
  server.
- `GitHubActionsOIDC` — fetches a token from `ACTIONS_ID_TOKEN_REQUEST_URL`.
- **auto-detect** (the zero-config default when no `APIKey`/explicit
  source is set): probe GCP metadata, then GitHub Actions, in that
  deterministic precedence. Each workload source emits `{ grant_type:
  "...token-exchange", subject_token: <fresh OIDC JWT> }`.

The OIDC token is fetched only on initial login + refresh-death and
cached until ~its `exp`; it is never sent per request. `RealmID` stays
required and continues to power the client-side realm-pin (§4.0, ADR-041)
— it is identity, not a secret.

**Audience.** A zero-config SDK bakes the requested `aud` in, so it is a
single well-known global constant (the RI public API origin), not
per-platform. This is safe because the **tenant boundary is the binding's
claim-allowlist, not `aud`** (see below); `aud` only blocks cross-RP
replay.

**Trust binding (RI-side, no SDK config).** The platform owner registers,
per source, a `federation_binding` describing *where their workload runs*
via `POST /platforms/{id}/federation-bindings` (admin-gated, §6). A
binding pins `issuer` + `audience` + a `match_claims` allowlist (AND
semantics) → mapped role/scope. v1 issuers are RI-known and RI-pinned
(GCP `accounts.google.com`; GitHub `token.actions.githubusercontent.com`)
so the partner never supplies a JWKS URL. A binding **must** constrain at
least the provider's mandatory claim — GCP `sub` (the SA's immutable
numeric `uniqueId`, never the reassignable email); GitHub `repository` —
and the `(issuer, match_claims)` tuple must be unambiguous.

**Security / replay.** The issuer verifies the assertion against the
RI-pinned JWKS (RS256, `exp`/`nbf`), enforces `aud` == the binding's
audience, rejects assertions whose `iat` is older than ~5 min (30 s
leeway), and rejects **reuse** via a one-time-use cache keyed on the
assertion's identity (its `jti` when present — GitHub — else a hash of
the raw assertion — GCP Google ID tokens carry no `jti`). The SDK mints a
fresh token at exchange time, so freshness never bites a real caller.
Federation is **additive** — `platform_api_key` is unchanged and not
deprecated — and **issuer-direct** (the exchange hits `auth.realmid.dev`
directly; the BFF is not in the path).

### 4.1 `login(req)`

Exchanges a provider token for a realm-scoped session. On the wire the
SDK posts to `POST /auth/login` with a `grant_type` discriminator
(ADR-051):

| SDK `method`     | Wire `grant_type`  | Extra body |
| ---              | ---                | --- |
| `"firebase"`     | `"provider_token"` | `provider: "firebase_phone"`, `token: <id token>` |
| `"google"`       | `"provider_token"` | `provider: "google"`, `token: <id token>` |
| `"otp"`          | `"otp"`            | `identifier`, `presented` (use the `auth.otpLogin` helper; ADR-071 §4 renamed the grant from `otp_internal`) |

Request (Go/TS surface unchanged from 0.9.x): `{ method, providerToken, origin? }`
- `method`: `"firebase" | "google" | "otp"`. `otp` (ADR-071 §4;
  formerly `otp_internal`) is the partner OTP login (see §X), gated
  server-side by `realms.config.otp_login_enabled`. When `method == "otp"`,
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

Response: `{ accessToken, refreshToken, expiresIn, refreshExp?, idleTtl?, expiresAt, user, tenants }`
- `tenants`: array of `{ id, role, displayName }` the user belongs to.
- `idleTtl` (wire `idle_ttl`): the realm's **idle-session timeout** as a
  sliding-window **duration** in **unix seconds** (a JSON number), ADR-070 —
  the maximum inactivity before the session is force-logged-out, distinct from
  `refreshExp` (an absolute instant) and from `expiresIn` (the access-token
  lifetime). It is per-realm config (`idle_ttl_seconds`), passed straight
  through with no min-of-N computation, and **sliding**: activity resets the
  clock. Enforced by the interactive-session holder (the BFF session store),
  not by machine-to-machine consumers. **Optional / forward-compatible:** a
  realm with no idle timeout, and any older issuer, omit it; the SDK decodes an
  absent field as `0` (Go/Java) / `undefined` (TS), meaning **no idle timeout**.
- `refreshExp` (wire `refresh_exp`): absolute wall-clock expiry of the
  **refresh token**, in **unix seconds** (a JSON number) — the instant past
  which the refresh token can no longer be rotated. The issuer computes it as
  the minimum of the rolling `refresh_ttl_seconds` ceiling, the ADR-054
  scheduled daily cutoff (when the realm opts in), and the ADR-058 absolute
  user-session cap. Distinct from `expiresIn`, which is the **access token**
  lifetime in seconds. **Optional / forward-compatible:** older issuers omit
  it; the SDK decodes an absent field as `0` (Go/Java) / `undefined` (TS), and
  a consumer that sizes a session from it (e.g. the BFF session store) MUST
  fall back to its own ceiling on the zero/absent value rather than treating
  the session as already expired.
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

Response: `{ accessToken, refreshToken, expiresIn, refreshExp?, idleTtl?, tenantId,
role, subjectType }`. `subjectType` ∈ `{user, service, platform}` (ADR-051);
`tenantId` and `role` are user-only. `refreshExp` (wire `refresh_exp`, unix
seconds) is the rotated refresh token's absolute expiry — same semantics and
optionality as §4.1; a rotation carries the recomputed cap forward (anchored
to first login for the ADR-058 absolute bound). `idleTtl` (wire `idle_ttl`)
carries the realm's idle-timeout duration on refresh with the same semantics as
§4.1 (0/absent = no idle timeout); the BFF binds the idle window at session
creation, so refresh preserves it rather than re-arming it.

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

### 4.2.1 Token manager (long-lived clients)

A convenience wrapper over §4.2 `token()` for **long-lived,
single-identity clients** — desktop apps, sync agents, daemons — that
hold one refresh token and need a continuously-valid access token
without hand-rolling the refresh loop. It is *not* for browser/BFF flows
(those use the middleware in §10) or for the SDK's internal platform
session (§4.0).

**Construction.** The manager is created from a refresh token the client
already holds (obtained out-of-band, e.g. at install/enrollment):

```text
mgr := realm.auth.newTokenManager(refreshToken, { tenantId?, refreshSink? })
accessToken := mgr.accessToken(ctx)   // cached, or refreshed on demand
```

- **Identity / transport.** The manager is created from a configured
  `realm` handle (`realm.auth.newTokenManager(...)`) and rides that
  handle's platform session: each `POST /auth/token` carries the
  **platform access token** in `Authorization: Bearer ...` (minted from
  the handle's API key / workload credential per §4.0) **and** the
  manager's own refresh token in the request body. This matches the
  issuer's BFF gate (§4.2 / ADR-041): when the refresh-bound realm has
  `require_bff_login=true`, the bearer MUST be the platform token and the
  refresh MUST be in the body. The long-lived client's *identity* is its
  refresh token; the platform bearer authorizes the *caller* (the handle).
  The raw API key itself is **never** placed on the wire as a credential —
  it is exchanged once for the platform token (§4.0 defense-in-depth) — so
  a handle embedded in a long-lived client still does not leak the key on
  `/auth/token` traffic.
- **`accessToken(ctx)`** returns a cached access token while it has ≥30s
  of life, otherwise performs one refresh and returns the new one.
- **Single-flight.** Concurrent `accessToken` calls collapse to a single
  in-flight `/auth/token` request. This is mandatory, not an
  optimization: user refresh tokens are one-time-use (ADR-031), so two
  parallel refreshes on the same token would trip reuse-detection and
  kill the session.
- **Proactive refresh.** Implementations SHOULD refresh ~60s before
  expiry so callers never observe an expired access token under steady
  load. Whether this runs on a background goroutine/timer or lazily on
  `accessToken` is language-idiomatic; the observable contract is the
  same.

**`refreshSink` — crash-safe rotation (REQUIRED semantics).** User
refresh tokens rotate on every `/auth/token` (§4.2). A long-lived client
that persists its refresh token across restarts MUST be handed the
rotated token **before** the manager hands back the new access token, so
a crash in the window can never strand the client holding a
consumed-and-rotated refresh:

1. `/auth/token` returns a new `{ accessToken, refreshToken }`.
2. The manager invokes `refreshSink(newRefreshToken)` and **waits for it
   to complete**.
3. **Only if the sink succeeds** does the manager cache the new access
   token and return it. If the sink reports an error, the acquisition
   fails (the caller retries; the persisted refresh is still the last one
   the sink durably stored).

This ordering — *persist-before-return* — is the whole point of the
sink. A best-effort / fire-and-forget sink does **not** satisfy this
contract.

**Terminal failure.** When `/auth/token` returns `refresh_invalid`
(§3.1) — refresh expired, revoked, or reuse-detected — the manager
surfaces a `RealmError{ code: "refresh_invalid" }` and does **not** retry
or fall back to any other credential. This is the signal for the client
to discard its stored refresh token and re-run its enrollment / login
flow. (Contrast §4.0's platform *session* manager, which on a dead
platform refresh re-bootstraps with a fresh `platform_api_key` login. The
token manager never re-bootstraps the *user* identity — the user refresh
is the only thing that can mint a user access token, and it is gone — so a
dead refresh is terminal here even though the underlying handle still
holds a live platform session.)

### 4.3 `mfaVerify(req)`

Completes an MFA challenge.

Request: `{ challengeToken, code, method? }` — `method` defaults to
`"totp"`. Set `"otp"` (ADR-071 §4; formerly `otp_internal`) to consume
a manager-issued partner OTP as the second factor (see §X); the typed helper
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

### 4.7 `revokeAllSessions(req)`

Revokes **every** session for the current user in one call —
`DELETE /auth/sessions`. Current-user operation: identify the user the
same way `revokeSession` / `listSessions` do (BFF mode: `userId` +
platform token + `X-On-Behalf-Of-User`; legacy mode: the user's own
access JWT as `userBearer`). A revocation token is rejected
(`insufficient_scope`). Response `{ status: "ok" }`; the SDK returns
void.

### 4.8 `selfEnrollMfa(req)` / 4.9 `disableMfa(req)`

Self-service TOTP MFA for the **current user** (distinct from the
admin-initiated `tenants.users.{enrollMfa,confirmMfa,resetMfa}` in
§6.2, which act on an admin-named target).

- `selfEnrollMfa(req)` → `POST /auth/mfa/enroll` (ADR-061).
  **Refresh-authed**: the request carries the user's `refreshToken` (the
  handle to their login session) + `tenantId` (+ `method?`, defaults
  `"totp"`). This is the one enrollment path for both timings — a
  first-login user who has no access token yet (the MFA gate withheld
  it) and a post-login user switching into an MFA-required tenant. In
  BFF mode the platform token is the Authorization bearer and the
  refresh rides the **body** (as for `token`). Returns `{ secret, qrUrl,
  recoveryCodes, mfaChallengeToken, tenantId }` — render the secret/QR
  and recovery codes, then complete enrollment by passing the
  **enroll-scoped** `mfaChallengeToken` to `mfaVerify` (§4.x): a single
  verify confirms the new secret **and** mints tokens. There is **no**
  separate `confirmMfa` step.
  > **Recovery codes are not yet redeemable.** `recoveryCodes` are
  > generated and hash-stored, but there is **no redemption endpoint**
  > today — losing the authenticator is currently an unrecoverable
  > lockout. Do not present them to end users as a recovery mechanism
  > until the redeem path ships (tracked in the project punch list).
  Returns `already_enrolled` (409) if a
  confirmed factor already exists (reset/disable first),
  `not_a_member` (403), or `refresh_invalid` (401).
- `disableMfa(req)` → `DELETE /auth/mfa`. Request: bearer + `code`
  (step-up). Returns void. `not_enrolled` (400) if MFA isn't active.

> **History:** the JWT-authed self `enrollMfa` + the separate
> `confirmMfa` (`POST /auth/mfa/confirm`) were removed in favour of the
> single refresh-authed `selfEnrollMfa` above (ADR-061). The admin
> `tenants.users.{enrollMfa,confirmMfa,resetMfa}` surface (§6.2) is
> unchanged — an admin enrolling a factor for a named target genuinely
> needs the admin JWT + a separate confirm.

> **Verified on-behalf-of (`X-User-Token`, ADR-056):** the bare
> `X-On-Behalf-Of-User` id is *asserted* — any platform-token holder can
> name any in-realm user. A BFF that holds the user's access JWT SHOULD
> instead forward it as `X-User-Token` **alongside** the platform bearer
> (not replacing it — the platform token stays primary for ADR-041
> defense-in-depth). The issuer then authorizes a **verified** principal
> (signature + realm checked), with role/tenant re-fetched from the store
> so a stale `role` claim is harmless. **Preference + no-downgrade rule:**
> when `X-User-Token` is present the issuer uses it and **ignores** any
> bare `X-On-Behalf-Of-User`; a present-but-invalid `X-User-Token` is
> **rejected** (`x_user_token_invalid`) rather than downgraded to the bare
> id. So a BFF holding a user JWT SHOULD send **only** `X-User-Token`
> (omit the bare id). This is a **server-side** concern: the Go SDK
> exposes it via `PassthroughOptions.OnBehalfOfUserToken` /
> `WithUserToken(ctx, accessJWT)` on the `Realm.Do` passthrough; browser
> SDKs never forward it (they reach the BFF over the `rsid_` cookie).
> TS/Java inherit it through the existing on-behalf parity gap below — no
> speculative lockstep.

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

This is the **only** path for user creation in a tenant. Inviting
pre-provisions the user row in `invited` status and allocates its
stable `id` up front; the identifier is held as an unverified
`user_contacts` row until the invitee logs in and verifies it.

- `list(tenantId, opts?)` — paginated. `opts: { status?, cursor?, limit? }`.
- `create(tenantId, { identifier, role? })` — sends an invitation.
  `identifier` is an email **or** an E.164 phone. `role` defaults to
  `"member"`; only an `owner` may invite at `"admin"` or `"owner"`.
  Returns `Invitation { id, identifier, role, status, expiresAt }` —
  `id` is the stable user id, `status` is `"pending"`, `expiresAt` is a
  unix-seconds timestamp. Re-inviting an identifier whose invite is
  still pending is **idempotent** (refreshes expiry, re-emits the
  invite); inviting an identifier already bound to an active member
  fails `RealmError(already_member)` (409).
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
  `"active" | "suspended" | "deactivated"`. Deactivating cascades:
  the user's contacts are released and their verifications revoked.
  The sole remaining `owner` cannot be deactivated → `RealmError(last_owner)`
  (409).
- `updateContact(tenantId, userId, { email?, phone? })` — change a
  user's email and/or phone (at least one required). Soft-releases the
  previous contact of that kind and issues a fresh unverified
  `user_contacts` row; the recycled slot is held for 30 days. Returns
  the updated `User`. A collision with another active member's
  identifier fails `RealmError(identifier_collision)` (409).
- Role updates live on the tenant surface (so they sit alongside
  `transferOwner`): use `tenants.updateUserRole(tenantId, userId, role)`
  / Go `Tenants.UpdateUserRole(ctx, tenantID, userID, role)`. Cannot
  demote the last owner; use `tenants.transferOwner` for an owner
  handover. Caller must hold a role of `owner` (or realm-admin via API
  key).
- `enrollMfa(tenantId, userId)`, `confirmMfa(tenantId, userId, code)`,
  `resetMfa(tenantId, userId)` — admin-initiated MFA flows. The
  self-service equivalents on `auth.mfa.*` are roadmap (§11).

#### Roles (custom, platform-defined — shipped in server v0.11.x, ADR-040)

The role space is **no longer a fixed enum**. Roles are platform-authored
per realm and validated against a `realm_roles` catalog. Declare every
role your app gates on at bootstrap via `realm.roles.*`:

- `realm.roles.create({ name, displayName?, permissions? })` — `POST /platforms/{id}/roles`
- `realm.roles.list()` — `GET /platforms/{id}/roles`
- `realm.roles.update(roleId, { displayName?, permissions? })` — `PATCH`
- `realm.roles.rename(roleId, newName)` — atomic rename
- `realm.roles.delete(roleId)` — `DELETE`

Assigning a role not present in the catalog returns `unknown_role`;
creating a duplicate returns `role_exists`. The `role` value in the
access token is sourced free-form from the catalog.

These four ship as **system roles** by default, but you may add any others
(`accounts`, `salesman`, `dispatch`, …):

| Wire value | Meaning                                                                 |
|------------|-------------------------------------------------------------------------|
| `owner`    | Full tenant control. Can change roles, delete the tenant, transfer ownership. Each tenant has at least one owner. |
| `admin`    | Manage users + invitations + tenant config; cannot delete the tenant or change owners.                            |
| `member`   | Default role for invited users. Can use the application; no admin operations.                                     |
| `viewer`   | Read-only access. Useful for stakeholders / observers.                                                            |

> **`permissions[]` is stored but not yet surfaced in the JWT** (ADR-040
> §2). Gate on role *name* for now; when the permissions claim lands it
> will be additive (non-breaking). See §11.

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
  keys. The list/row DTO mirrors the issuer's `APIKeyListItem` (code
  wins — the issuer response is authoritative):
  `{ id, prefix, role, label?, createdAt, lastUsedAt?, revokedAt? }`.
  - `prefix` — non-secret key prefix, stable across logs.
  - `role` — the key's bound role (singular; **not** a `scopes` array).
  - `label` — optional human name supplied on create.
  - `createdAt` / `lastUsedAt` / `revokedAt` — unix seconds;
    `lastUsedAt` and `revokedAt` are nullable. A non-null `revokedAt`
    means the key is revoked.
  - `create({ scope, label? })` returns the row **plus** a one-time
    `value` (the secret) that is shown only on creation and never
    returned by `list`. `revoke(id)` is a soft-delete (sets
    `revokedAt`).
- `realm.config.update(patch)` — patch realm-level config (TTL
  overrides, default audience, etc., subject to the server's
  configurable-keys allowlist).

### 6.8 Contact drift reviews — `realm.tenants.driftReviews.*`

When a returning user logs in with an identifier that differs from the
one on file (e.g. the IdP now asserts a new email), the server does not
silently mutate the contact. It enqueues a **drift review** and lets a
tenant admin decide. ADR-042.

- `list(tenantId, opts?)` — paginated. `opts: { userId?, cursor?, limit? }`
  (`limit` 1..200, default 50). Yields `DriftReview` rows:
  `{ id, contactId, userId, assertedValue, assertedMethod,
  assertedProviderUid, seenCount, firstSeenAt, lastSeenAt, status }`.
  `status` ∈ `"pending" | "accepted" | "rejected" | "superseded" | "expired"`;
  `*At` fields are unix seconds. Only `pending` rows are actionable.
- `accept(tenantId, reviewId)` — adopt the asserted value as the user's
  new contact (releases the old one). Returns
  `{ id, status: "accepted", acceptedValue, newContactId }`. A review
  that is already resolved, or whose value now collides, fails
  `RealmError(conflict)` (409).
- `reject(tenantId, reviewId)` — treat the drift as a different person:
  the asserting login is split off onto a fresh deactivated user and the
  original contact is left intact. Returns
  `{ id, status: "rejected", newUserId, originalValue }`.

### 6.9 Contact verifications — `realm.tenants.contactVerifications.*`

First-login step-up gate. When a user logs in for the first time on an
identifier slot that was recycled from a previously-released contact
(the 30-day hold from `updateContact`), the login is held `pending`
until a tenant admin approves it. ADR-042.

- `list(tenantId, opts?)` — paginated. `opts: { state?, cursor?, limit? }`
  (`state` defaults to `"pending"`; `limit` 1..200, default 50). Yields
  `ContactVerification` rows: `{ id, contactId, userId, method,
  providerUid, state, createdAt, expiresAt? }`. `state` ∈
  `"pending" | "active" | "rejected" | "revoked"`; `expiresAt` is
  present only while `pending`.
- `approve(tenantId, verificationId)` — admit the login; the contact
  becomes verified/active. Returns `{ id, state: "active" }`. Already
  resolved, or the active slot is taken → `RealmError(conflict)` (409).
- `reject(tenantId, verificationId)` — deny the login. Returns
  `{ id, state: "rejected" }`.

### 6.10 Identity-provider configuration — `realm.identityProviderConfig.*`

Realm-admin CRUD over the realm's login providers (Google, Microsoft,
Facebook, Apple). Distinct from the read-only **discovery** surface
(`realm.identityProviders(...)` / `Realm.IdentityProviders`, ADR-047)
that an SPA uses to list providers — this is the admin surface that
*defines* them. Authenticates with the platform token, like
`realm.roles.*`. The realm's own id is sent as `platform_id`
automatically; callers never pass it. An optional `tenantId` scopes a
provider to a single tenant within the realm.

An `IdpConfig` is `{ id, entityType ("realm"|"tenant"), entityId,
provider, clientType ("web"|"ios"|"android"|"desktop"|"other"),
clientId, allowedOrigins[], comments, config?, enabled, createdAt,
updatedAt }`.

`config` is a provider-specific **PUBLIC** config map (string→string,
never secrets) — e.g. the Firebase web config (`apiKey`, `authDomain`,
`projectId`, `appId`). It is echoed verbatim on the public **discovery**
surface so a browser SDK can bootstrap sign-in with no app-side config;
it is omitted from responses when empty.

- `list({ tenantId? })` — `GET /identity-providers`. Returns
  `{ items: IdpConfig[] }`.
- `create({ provider, clientType, clientId, allowedOrigins?, comments?,
  config?, tenantId? })` — `POST /identity-providers`. Returns the
  `IdpConfig`. `clientType: "web"` **requires** non-empty
  `allowedOrigins`; any other client type **requires** it absent.
  `provider_exists` (409) if a row for that scope/provider/clientType
  already exists.
- `update(id, { enabled?, clientId?, allowedOrigins?, comments?,
  config? })` — `PATCH /identity-providers/{id}`. At least one field
  required (`empty_patch` otherwise). A supplied `config` **replaces**
  the stored map wholesale (not merged). Returns the updated `IdpConfig`.
- `delete(id)` — `DELETE /identity-providers/{id}`. Returns
  `{ status: "deleted" }`. `provider_not_found` (404) if absent.

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

### 7.6. Partner audit-event feed (ADR-055)

The partner-facing slice of the same `audit_log` exposed at
`/admin/events`. Scoped (and forced) to the platform the SDK is
authenticated for — the SDK passes the configured `realmId` into the
URL path and the server ignores any query-string `platform_id`, so
a caller cannot read another platform's events.

Auth: either the platform-token bearer (the SDK's default) or the
platform admin user JWT.

Surface (matches across all SDKs):

- `auditEvents.list(opts?)` → `AuditEventsResponse`
  Wraps `GET /platforms/{id}/audit-events`. Filters: `tenantId`,
  `actorId`, `kind` (repeatable), `since` / `until` (unix seconds,
  half-open), `cursor`, `limit` (default 50, max 200). The cursor is
  opaque; forward `next_cursor` verbatim until null.

Response shape (identical in all SDKs):

```
AuditEventsResponse { items: AuditEvent[],
                      next_cursor: string | null }
```

`AuditEvent` is the same shape as in §7.5.

**Retention** is 400 days server-side; partners pulling for long-term
compliance archives should pull at least quarterly. **No backfill** —
the feed begins at the moment the endpoint was deployed.
**Push delivery** (webhooks / event streams) is **not** on the v1
roadmap.

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

  // Origin enforcement (ADR-065). "auto" (default) follows the realm
  // policy from realm.info().origin_enforcement; "on"/"off" force it.
  originEnforcement: "auto",                        // "auto" | "on" | "off"

  // Extension hooks (ADR-065) — §10.5.
  beforeLogin?:   (ctx, loginRequest) => void,      // mutate the login request pre-Auth.Login
  onAuthSuccess?: (ctx, event) => void,             // post-mint, pre-cookie; throw to fail-closed
  onAuthFailure?: (ctx, event) => void,             // observe-only; SDK still writes the envelope
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

### 10.5 Extension hooks (ADR-065)

The middleware owns the **entire** auth flow (login / token / logout /
mfa / origin / cookie / response). Partners do **not** hand-roll these
routes; they register callbacks at four seams. All are optional — the
zero value reproduces the base behavior.

**`originEnforcement`** — the confused-deputy Origin guard (SPEC §6.6) on
the unauthenticated `/auth/*` routes:

- `"auto"` (default) — enforce iff the realm policy
  `realm.info().origin_enforcement == "required"`. The policy is RI-owned
  (per-realm `RealmConfig.origin_enforcement`, set via
  `PATCH /platforms/{id}/config`); the SDK only enforces it. On an
  Auto-mode discovery failure the middleware **fails open** (does not
  enforce) and logs, to avoid bricking a login on a transient RI outage.
- `"on"` / `"off"` — force the guard regardless of realm policy. `"off"`
  is the escape hatch for a non-browser / M2M deployment on a realm whose
  policy is `"required"`.

When enforcing, the middleware validates the request `Origin` against the
realm allowlist (`origins.validate`) before dispatch and rejects with
`missing_origin` (blank Origin) or `realm_origin_mismatch`
(present-but-unlisted).

**`beforeLogin(ctx, loginRequest)`** — runs after the login body is
parsed and before `auth.login`. May mutate the request in place (e.g.
substitute a server-held API key, pin `tenant_id`). Failure aborts the
login (routed to `onAuthFailure`).

**`onAuthSuccess(ctx, event)`** — runs after a successful
login/refresh/mfa mint and **before** the refresh cookie + success body
are written. Failure aborts the response (routed to `onAuthFailure`) so
no session reaches the browser. The event is **normalized** across all
three flows — `userId`, `tenantId`, `role` are always populated; on the
refresh flow the issuer's mint result carries no user object, so the SDK
recovers `userId` by verifying the freshly-minted access token's `sub`
(only when the hook is registered). `session`/`tenants` are populated on
login/mfa and absent on refresh.

> For **best-effort** post-auth work (e.g. a tenant/user mirror
> reconcile), handle your own errors and return normally — throwing on the
> refresh/mfa flow leaves the just-rotated session unusable (the old
> refresh credential is already dead; the issuer keeps no grace window).
> Keep hook work idempotent and fast.

**`onAuthFailure(ctx, event)`** — **observe-only**, invoked on every auth
failure (origin reject, `beforeLogin`/`auth.*` error, `onAuthSuccess`
error, bearer verification failure) for side effects such as audit
logging or brute-force counters. The middleware **always** writes the
canonical `{error:{code,message}}` envelope; the hook cannot alter the
response. The event carries a `stage` discriminator (`origin` |
`before_login` | `login` | `refresh` | `mfa_verify` | `on_success` |
`verify`).

> **Breaking change (ADR-065).** `onAuthFailure` was previously a
> response-**owning** callback (`(req, err) => Response`). It is now
> observe-only. Partners that wrote a custom error body must move that
> logic elsewhere or request the planned `errorResponder` option.

### 10.4 MFA freshness model

A middle-ground between "MFA once per session" and "MFA on every
operation" — partner picks per route.

**Token claim.** Access tokens carry `mfa_at` (unix-seconds) — the
timestamp of the user's most recent successful MFA challenge **for the
token's tenant**. Absent or `0` means MFA never verified for this
(session, tenant).

**Server source of truth (ADR-059).** Per-(session, tenant) MFA proof,
keyed `(jti, tenant_id)` in `session_tenant_mfa`; the Redis MFA cache is
an advisory speed-up keyed identically. Because one user-scoped session
legitimately spans tenants (tenant switching off a single refresh token),
**MFA completion does not transfer across tenants** — completing MFA for
tenant A never satisfies the gate for tenant B.
- `POST /auth/mfa/verify` → upserts proof for the challenge's
  `(jti, tenant_id)`.
- `POST /auth/login` → no proof unless the login itself completed MFA
  for the resolved tenant.
- `POST /auth/token` (refresh-mint for `tenant_id`) → reads the
  `(jti, tenant_id)` proof and projects it into the access token's
  `mfa_at` claim; the per-tenant gate fires when that proof is absent.
- Logout / session revoke → proof rows cascade away with the session.
- `DELETE /auth/mfa` (disable MFA for the current user) → drops proof
  for **all** tenants across **all** sessions of that user, forcing
  re-MFA on the next protected operation.

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

Wraps `POST /auth/login` with `grant_type=otp` (ADR-071 §4; formerly
`otp_internal`). Optional `deliveryMode` (`view_bff`) selects OTP
delivery. Realm precondition: `otp_login_enabled = true`.

Request: `{ realmId, identifier, presented }` — `identifier` is an
E.164 phone or email; the server resolves it to a tenant-scoped user.
Response: same shape as `login()`.

### X.5 `auth.mfaVerifyOtp(req)` / `Auth.MFAVerifyOTP(...)` — second factor

Wraps `POST /auth/mfa/verify` with `method=otp` (ADR-071 §4; formerly
`otp_internal`). Realm precondition: `otp_mfa_enabled = true` **and**
the user is enrolled in `otp` (per-user `mfa_methods` or per-role
`required_mfa_methods`).

Request: `{ mfaToken, presented }` (TS) / `{ MFAToken, Presented }` (Go).
Response: same shape as `login()`.

### X.6 Worked examples

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

- **`permissions[]` JWT claim** — `realm_roles.permissions` is stored and
  editable today (§6.3) but not yet inlined into the access token. When
  demand materializes it's added non-breakingly by sourcing from the
  catalog. No committed ETA. (Platform-defined custom *roles* themselves
  already shipped — see §6.3, ADR-040 — and are no longer roadmap.)
- Webhooks (`realm.webhooks.verify(payload, signature)`)
- Service-to-service tokens (`auth.serviceToken()`)
- OpenID Connect discovery (`/.well-known/openid-configuration`)
- Impersonation (`auth.impersonate({ targetUserId, reason })`)
- WebAuthn / passkeys
- Custom domains for hosted UIs
- Bulk user import
- CSRF protection layer in the middleware (double-submit-cookie pattern)
- BFF on-behalf-of (`userId` + `X-On-Behalf-Of-User`) parity for the TS
  SDK's current-user session/MFA methods (§4.5–4.10) — Go and Java
  already support it; TS is `userBearer`-only today
- Idempotency-key pass-through on mutations

## 12. Versioning

The repository tags each SDK independently. Surface changes that break
wire compatibility require **all three** SDKs to bump together. The
spec in this document is authoritative; if an SDK diverges, it is a
bug in that SDK, not a permitted variation.

**Tag forms.** The Go SDK is a *subdirectory* module
(`github.com/Realm-ID/sdk/go`), so its release tags MUST use the
**slash** form `go/vX.Y.Z` — that is the only form
`go get github.com/Realm-ID/sdk/go@vX.Y.Z` resolves. The `go-vX.Y.Z`
hyphen label is a legacy human convention (stopped at `go-v0.10.0`) and
is **not** a resolvable module version; do not cite it as an install
target. TS and Java use `ts-vX.Y.Z` / `java-vX.Y.Z`.

**Per-language tag matrix** (latest released ↔ this SPEC version):

| Language | Latest released tag | Notes |
|----------|---------------------|-------|
| Go       | `go/v0.18.0`        | slash form; resolved by `go get`. ADR-057 federation + ADR-056 `X-User-Token`. |
| TS       | `ts-v0.15.0`        | token manager + `refresh_invalid` + api-key DTO + federation. |
| Java     | `java-v0.10.0`      | v0.8.0 parity + ADR-051 migration. Federation lockstep tag pending. |

> **SPEC v0.10.0 (ADR-057 workload identity federation, §4.0.1) is
> released for Go (`go/v0.18.0`) and TS (`ts-v0.15.0`).** Java's
> lockstep federation tag (`java-v0.11.0`) is still pending — until it
> lands, the Java federation surface ships only from `main`. The SPEC
> header tracks the *implemented* surface (CLAUDE.md "spec is law / code
> wins"), which may lead the newest released tag.
