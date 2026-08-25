# Realm ID SDK — cross-language specification

**Current as of 2026-08-24 — go `go/v0.46.0` · ts `ts-v0.38.0` · java
`java-v0.36.0`** (see §12 for the tag matrix).

> **Revision history.** This body is kept **current** — it always
> describes the shipped surface, not an amendment trail. The
> per-release changelog (what changed when, breaking-change notes,
> per-language rollout state) lives in `sdk/CHANGELOG.md` + git tags;
> design rationale lives in the referenced ADRs and `DECISIONS.md`.

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

`provider_token_invalid`, `mfa_required`, `mfa_registration_required`,
`session_limit_reached`, `tenant_required`, `tenant_invalid`,
`account_suspended`, `account_deactivated`, `realm_origin_mismatch`,
`realm_mismatch`, `missing_origin`, `refresh_invalid`.

> `mfa_registration_required` (412) is the first-factor-ENROLLMENT variant of
> `mfa_required`: the realm or tenant requires MFA and the user has no
> confirmed factor yet, so the remedy is an enrollment screen, not a code
> prompt. It carries `mfa_challenge_token` + `tenant_id` in the same 412
> envelope. **Registered in ts and Java as of `ts-v0.38.0` / `java-v0.36.0`** —
> Go has had it since ADR-061, and the two languages that lacked it collapsed
> it into the generic 412 mapping, losing the distinction for exactly the
> clients that must render the other screen.

> `realm_mismatch` is a **client-side** code (ADR-041 realm pin): the SDK
> decodes the platform access token it just minted and confirms the `iss`
> references the configured `realmId`. A mismatch (the SDK was constructed
> for realm A but the API key / workload credential belongs to realm B)
> is a confused-deputy bug; the SDK raises `realm_mismatch` locally
> **before** any subsequent management call rather than letting it surface
> as a cryptic downstream 4xx. It is never emitted by the issuer on the
> partner surface. **All three SDKs perform this pin.** A token whose payload
> cannot be decoded is deliberately NOT a mismatch — the pin answers "which
> realm is this token for", and an unreadable answer is left to the verifier,
> so an opaque access token from a mock or a future issuer does not become an
> auth failure.

> `refresh_invalid` is returned by `POST /auth/token` (and surfaced by
> `auth.token()` / the token manager) when the presented refresh token is
> **expired, revoked, or reuse-detected** — terminal for the caller, no
> retry will help. It is distinct from a generic `unauthorized` so
> long-lived clients can deterministically branch on "re-authentication
> required" versus a transient 401. The SDK does **not** subdivide
> expiry / revocation / reuse: all three collapse to `refresh_invalid`
> (the issuer does not distinguish them on the wire).

**Membership self-service codes** (used by `realm.me.*`, §6.15, ADR-092):

`owner_cannot_be_revoked`, `single_tenant_not_required`, `not_invited`,
`not_pending`, `invitations_unavailable`, `owner_cannot_leave`,
`already_left`.

> Six of these arrive as 409s. They are registered as **known** codes in
> all three languages so the specific code reaches `error.code` rather
> than collapsing into the generic `conflict` — each has its own remedy
> (transfer ownership, use `leave` instead of `reject`, nothing to do),
> and the HTTP status alone cannot tell them apart.

**Service-account (ADR-071) + source (ADR-072) codes:**

`handle_taken`, `invalid_role`, `method_violates_kind`,
`service_account_not_found`, `source_not_found`, `user_not_found`.

> **Registered in Go as of `go/v0.46.0`.** ts and Java had carried all six
> since those ADRs shipped; Go had not, so for Go callers alone every one of
> them collapsed into the generic status code. `sdk/TODO.md` had recorded the
> taxonomy as "consistent across the three SDKs" — measured on 2026-08-24 it
> was eight codes out of sync. `scripts/taxonomy-parity.py` now measures it on
> every CI run instead of asserting it in prose.
>
> `not_service` is declared by ts and Java and is **deliberately not in Go**:
> no issuer handler emits it (its only near-match is the distinct
> `role_not_service_typed`). A code with no producer is a phantom; the parity
> gate carries it as a reviewed exception, and removing it from ts/Java is
> filed separately.

**Platform codes:**

`platform_not_found`.

> **Registered in all three languages as of `ts-v0.38.0` / `go/v0.46.0` /
> `java-v0.36.0`.** The issuer answers it on every by-id platform route (16
> call sites); before registration it fell back to the 404 mapping and callers
> saw a generic `not_found`.
>
> **BREAKING for a caller that matched `not_found` on a platform route** — it
> now receives `platform_not_found` instead. The migration is to match both,
> which is already the idiom for the sibling codes:
> `case "platform_not_found": case "not_found":`.
>
> It never distinguishes "not yours" from "never existed" — the issuer answers
> both identically on purpose (issuer `v0.78.0` oracle rule). That is a
> security property and no taxonomy change may erode it.

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
| `integration_installation` | none (source platform's `platform_api` key in body) | `service` | the brokered cross-realm mint, `realm.integrations.mintToken(...)` (§6.14, ADR-082/083) |

Login is a **two-step exchange** internal to the SDK; partners see one
call. The raw API key is **never** sent on user-login traffic. The SDK
keeps a per-handle session manager that:

1. **Platform login** — `POST /auth/login` with body
   `{ grant_type: "platform_api_key", api_key: "rk_live_..." }`.
   Response: `{ status, subject_type: "platform", access_token,
   expires_in }`. The SDK caches the access token.

   **ADR-089: there is NO `refresh_token` in this response.** An SDK
   that *requires* the field fails hard against issuer `v0.68.0`+ on the
   very first call; treat it as absent, and ignore it if a
   pre-`v0.68.0` server still sends one.
2. **User session mint** — `POST /auth/login` with the cached platform
   access token in `Authorization: Bearer ...` and a user grant in the
   body (`grant_type: "provider_token"`, `provider`, `token`). The
   server validates both — the platform token authorizes the *caller*;
   the provider token authenticates the *user*.
3. **Access re-mint** — when the cached platform access token enters
   its 30 s pre-expiry window, the SDK repeats step 1. Concurrent
   callers MUST collapse into a single in-flight login.

**There is no platform refresh step (ADR-089).** A session bootstrapped
from a re-presentable credential — an API key or a workload assertion —
is issued an access token only. The rule: *a session keeps its refresh
token iff the credential that created it cannot be presented again.* A
refresh token here would be a strictly weaker duplicate of a credential
the caller is already holding, and one that outlives revocation of its
source; the two lanes guarding that gap had both silently failed in
production. `POST /auth/token` answers `401 m2m_refresh_withdrawn` for
such a session.

This changes the cost profile, not the security posture: one
`/auth/login` per access-token lifetime (5 min by default) instead of one
`/auth/token`. The same single round trip, with the credential attached.

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
→ { status, subject_type: "platform", access_token, expires_in }
```

The response shape is identical to the `platform_api_key` exchange —
including ADR-089's absence of `refresh_token`. Steps 2 (user-session
mint) and 3 (re-mint) are unchanged; a workload re-mints by exchanging a
fresh assertion.

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

Request: `{ method, providerToken, origin?, deviceName? }`
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
- `deviceName` (ADR-062): optional human-readable label for the device the
  login happens on — a CLI hostname, a browser name. It travels as the
  **`X-Device-Name` header**, never in the body, and **only on the user
  grant**: the platform bootstrap that precedes it is an M2M mint the issuer
  records no device for. The issuer persists it on the created session and
  echoes it back in `listSessions` (§4.6, `device_name`), which is the point —
  a user revoking a session needs to tell their sessions apart. Absent means
  **no header at all**; a present empty value reads server-side as a supplied
  label. All three SDKs send it (Go `LoginRequest.DeviceName`, TS `deviceName`,
  Java `LoginRequest.withDeviceName(...)`).

  **Sanitizing is split, and the split is deliberate.** The server strips
  control characters and caps the value at **120 characters**
  (`sanitizeDeviceName`); no SDK duplicates the CAP, because that is policy and
  a client-side copy drifts the day either end changes. Each SDK does strip
  what an HTTP header field value cannot carry (C0 controls and DEL), because
  that is a TRANSPORT constraint, not a policy: undici, the JDK client and Go's
  `net/http` all refuse such a value outright, so before this the whole login
  failed with an error naming the network rather than the argument. The stripped
  value is byte-identical to what the server would have stored; a label
  consisting only of control characters sends no header.

The wire response includes a typed `subject_type` ∈ `{user, service,
platform}` (ADR-051 §3). `service` is minted for a **service account**
(ADR-071: a `kind=service` user logging in via a `view_bff`-delivered
OTP, or a raw `api_key` grant) — its session is `class="service"` with
its own refresh-TTL clamp. For user grants the SDK exposes the
high-level fields:

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
- `tenantChoiceRequired` (wire `tenant_choice_required`) + `tenantChoices`
  (wire `tenant_choices`: `{ tenantId, displayName, isOwner }`), ADR-092
  D5 — the caller holds more than one ACTIVE membership in a realm that
  requires single-tenant membership and must give the extras up. **The
  login SUCCEEDED**: an access token and a refresh token are returned as
  usual, so this is a *reconciliation prompt, not an authentication
  failure* — refusing the login would strand exactly the users the drain
  exists to resolve. Settle it with `me.chooseTenant` (§6.15). `isOwner`
  marks a membership that CANNOT be given up (releasing it would leave the
  org ownerless); do not offer it — the server refuses it regardless.
  **Optional / forward-compatible:** both are omitted unless the realm has
  `single_tenant_membership` on, and decode as `false`/absent (Go, Java)
  or `undefined` (TS) everywhere else.
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
- `tenantId`: required for multi-tenant user picks; ignored on service
  refresh tokens (ADR-051). There is no *platform* refresh token to ignore
  it on — ADR-089 withdrew it (§4.0). "Service" here means the ADR-071
  OTP-bootstrapped account, the one `class=service` lane that keeps a
  refresh token.
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
- **Service-account refresh** (ADR-071: `class=service` bootstrapped by a
  one-shot OTP — the only M2M lane that still holds a refresh token after
  ADR-089) rotates **only when the realm opts in**, via one realm-config
  key (PATCHable on `/platforms/{id}/config`):

  | Key                          | Default | Effect when `false`                                                | Effect when `true`                                                                |
  | ---                          | :---:   | ---                                                                | ---                                                                               |
  | `service_refresh_rotates`    | `false` | Service refresh is multi-use until exp; no reuse-detection.        | Single-use; `/auth/token` rotates and runs reuse-detection.                       |

  `platform_refresh_rotates` was **removed** by ADR-089: `class=platform`
  is always credential-bootstrapped, so it has no refresh token left to
  rotate and the knob could only ever decide nothing. `PATCH
  /platforms/{id}/config` now rejects the key with `unknown_config_key`.

  Service refresh TTL reuses `realms.config.refresh_ttl_seconds` (no new
  TTL knob).

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
flow. (Contrast §4.0's platform *session* manager, which simply re-mints
from the bootstrap credential whenever its access token expires — it holds
no refresh token to go dead, per ADR-089. The
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

The response is the issuer's locked paged envelope
`{ items, next_cursor, total }` (`httpapi.pagedSlice`) — **not** a bare
`{sessions: [...]}`, a shape no issuer emits and which the TS client decoded
until `0.37.0`, returning an empty list against every real server. Go and TS
accept the flat shape as a legacy/mock fallback; Java reads the envelope
through `Paginated`.

**All three languages follow `next_cursor`** as of go `0.45.0` / ts `0.37.0` /
java `0.35.0`, each in its own idiom: Go returns
`iter.Seq2[*SessionInfo, error]`, Java returns `Paginated<Session>`, TS returns
`Paginated<SessionInfo>` (an `AsyncIterable` that also exposes `.page(opts)`).
TS returned a bare first-page array through `0.36.0`; past the server default of
50 that silently truncated, which is sharper here than on most list surfaces —
a session missing from the list is one the user cannot revoke, and this is the
surface someone uses when they believe they are compromised. The `0.37.0` change
is BREAKING and deliberately so: a compile error with an obvious fix beats the
same call quietly returning a different number of rows.

Neither legacy shape carries a cursor, so a pre-envelope server yields one page
and stops — it cannot put a client in an endless loop.

Each row (`SessionInfo` / `Session`) mirrors the issuer's session DTO:
`{ id, class, created_at, last_seen_at, device_name?, ... }`. Note the
last-used timestamp's wire field is **`last_seen_at`** (unix seconds) —
the SDKs decode it into their last-used accessor (Go
`SessionInfo.LastUsedAt`, Java `Session.lastUsedAt`, TS keeps the raw
`last_seen_at`); there is no `last_used_at` field on this DTO (that
name exists only on the api-key DTO, §6.5). `device_name` is the ADR-062
label supplied at login (§4.1) and is carried by all three SDKs (Go
`SessionInfo.DeviceName`, Java `Session.deviceName()`, TS raw
`device_name`); it is absent on sessions created without one and on every
M2M session.

### 4.7 `revokeAllSessions(req)`

Revokes **every** session for the current user in one call —
`DELETE /auth/sessions`. Current-user operation: identify the user the
same way `revokeSession` / `listSessions` do — **BFF mode: the platform
token as bearer plus the user's verified access JWT as `X-User-Token`**
(`realm.withUserToken(jwt)`; in Go `WithUserToken(ctx, jwt)`); legacy
mode: the user's own access JWT as `userBearer`. A `userId` may ride
alongside as `X-On-Behalf-Of-User` for attribution, but **is not an
identity on its own** — issuer v0.66.0 answers `401
x_user_token_required` — and the SDKs refuse such a call locally rather
than issue one that cannot succeed. A revocation token is rejected
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
> (omit the bare id). Browser SDKs never forward it (they reach the BFF
> over the `rsid_` cookie).
>
> **Every server SDK forwards it on the TYPED surface, not just on the
> passthrough** — a partner BFF calling `tenants.list()` on the user's
> behalf must be able to say so without dropping to raw HTTP:
>
> | SDK | How |
> |---|---|
> | Go | `WithUserToken(ctx, accessJWT)` — a context value, so it reaches every typed method and `Realm.Do` alike. Per-call override: `PassthroughOptions.OnBehalfOfUserToken`. |
> | TS | `realm.withUserToken(accessJWT)` → a derived `Realm`. |
> | Java | `realm.withUserToken(accessJWT)` → a derived `Realm`. |
>
> TS and Java have no ambient request context, so they **derive a client**
> instead: the returned handle shares the parent's platform-token cache,
> verifier and JWKS cache (all platform-scoped), and only its transport
> differs. Derivation is required, not stylistic — a settable field on a
> long-lived realm handle would let one request's user leak into the next.
> Deriving per request is cheap. A per-call header (e.g. the `userToken`
> mode on `realm.me.*`, §6.15) still wins over the client-scoped token,
> and an SDK MUST send the header exactly once: header names are
> case-insensitive, so a naive merge of `x-user-token` with
> `X-User-Token` puts two values on the wire and the issuer rejects the
> result. The SDK stores nothing — persistence and refresh of the user
> JWT stay the caller's responsibility.

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
`POST /auth/login {grant_type: "platform_api_key"}`, re-mints the same way
when that access token nears expiry (ADR-089 — `POST /auth/token` is not
part of this identity's lifecycle), and sends the cached access token as
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
- `create({ id?, displayName, signupMode?, createdAt?, owner })`
  — creates a tenant under the calling platform, provisioning the org and
  its **owner** in one transaction. The realm is implicit (the API key's
  realm); there is no separate "platform" parameter because a partner has
  one platform per realm. Wire call: `POST /platforms/{realmId}/tenants`.
  `signupMode` defaults to `"closed"` server-side (ADR-045). **Honoured on
  create since 2026-08-02 / spec 0.20.0** — before that the issuer accepted the
  field and silently dropped it, so every org came out `closed` whatever the
  SDK sent. `"open"` is reserved for the base admin tenant and is **refused**
  here (`invalid_signup_mode`), never quietly downgraded. On a BYO-`id`
  **reconcile** it is idempotent-or-refused, never applied: the same value is a
  no-op, a different one is `409 signup_mode_immutable_on_reconcile` with
  nothing written — a re-run import must not clobber a policy changed in the
  console since. Change it with `updateConfig`.
  - `owner` (ADR-073 Amendment C.2) is **required when creating a new
    tenant** — an org is never ownerless (ADR-076; `owner_user_id` is
    `NOT NULL`). Shape: `{ user_id?, email?, phone?, display_name?,
    provider?, provider_uid? }`, at least one of `email`/`phone`. There is
    deliberately **no** `role`: the owner gets the dormant `member` role
    (ownership is the pointer, not the name). Server returns
    `owner_required` if omitted on a genuine create; `owner` may be omitted
    only on a pure **reconcile** of an already-owned tenant.
  - `id` (ADR-073 Amendment C.1) is an optional caller-supplied tenant
    UUID (bring-your-own, for verbatim migration). Absent ⇒ the server
    mints a UUIDv7. Present + already in this realm ⇒ the call **reconciles
    idempotently**; present + in another realm ⇒ `cross_realm_tenant_id`.
  - `createdAt` (ADR-073 Amendment C.4) is an optional RFC3339 creation
    timestamp; absent ⇒ server time. Ignored on reconcile.
  - **REMOVED (ADR-094 R3): `allowedDomains`.** `tenants.allowed_domains`
    was retired as a column; the domains that auto-provision are
    `tenant_domains` grants, claimed and proven through the domains API.
    A settable allowlist required no proof of control, so it could confer
    access nobody had demonstrated. A bulk-imported org therefore starts
    with its domains **inert** — there is no bulk-approve path, by design
    (ADR-094 §Consequences), so a migrating partner must claim per org.
- `update(id, { displayName? })` — top-level mutable fields.
- `updateConfig(id, patch)` — patches `tenants.config`. Honoured keys:
  `signupMode: "closed" | "allowlist" | "open"` (per-tenant signup
  policy, ADR-045 — `open` is reserved for the base admin tenant and
  rejected on partner tenants; `allowedDomains` was REMOVED by ADR-094 R3
  and now returns 400 `unknown_config_key`), `role_overrides` (per-org role
  remapping) and `default_invitation_role` (the role a bare invite
  gets) — the latter two are **typed** in ts (`TenantConfigPatch`);
  go/java accept them through the generic config map. Server enforces
  an allowlist of accepted keys; unknown keys →
  `RealmError(bad_request)`.
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
- `importUsers(tenantId, rows)` — **bulk user import** (ADR-073
  Release B), `POST /tenants/{id}/users/import`, owner/admin. Two-phase,
  **whole-file-atomic** import of pre-provisioned `status='active'`
  users with verified contacts, bound to their provider identity on
  first SSO (by `provider_uid` when supplied, else email/phone). Each
  row is `{ email? | phone?, provider?, providerUid?, role?, userId?,
  createdAt? }` (≥1 of email/phone). `createdAt` (ADR-073 Amendment C.4)
  is an optional RFC3339 "member since" timestamp preserved from the
  source system; absent ⇒ import-time, malformed ⇒ `invalid_created_at`.
  A row may bring its own `user_id` (becomes
  `users.id`; a `user_id` already in another tenant rejects the whole
  file); rows without one get a minted UUIDv7 **returned**, so the
  platform holds only UUIDs, never PII. Response is HTTP 200 +
  `ImportUsersResult { committed, results[] }` (ADR-069 uniform-200;
  `committed: false` → nothing was written). **Language coverage:** ts
  `realm.tenants.users.importUsers` (+ re-exported on
  `@realm-id/web-admin` for the UI CSV uploader), go
  `realm.Tenants.Users.ImportUsers`, and java
  `realm.tenants().users().importUsers(...)` — all at parity.

#### Roles (custom, platform-defined — shipped in server v0.11.x, ADR-040)

The role space is **no longer a fixed enum**. Roles are platform-authored
per realm and validated against a `realm_roles` catalog. Declare every
role your app gates on at bootstrap via `realm.roles.*`:

- `realm.roles.create({ name, displayName?, permissions?,
  requiredMfaMethods? })` — `POST /platforms/{id}/roles`
- `realm.roles.list({ includeSystem?, disabled? })` — `GET
  /platforms/{id}/roles`. `includeSystem` (→ `?include_system=true`)
  also returns system roles the server hides by default (e.g. the
  `platform_api` row).
- `realm.roles.update(roleId, { displayName?, permissions?,
  requiredMfaMethods? })` — `PATCH`
- `realm.roles.rename(roleId, newName)` — atomic rename
- `realm.roles.disable(roleId)` / `realm.roles.enable(roleId)` —
  `POST …/roles/{id}/disable|enable`. Soft-disable: the role stays
  assigned but is hidden from new assignment; the role object carries
  `disabled` (+ `disabled_at`, unix seconds).
- `realm.roles.delete(roleId, { migrateTo? })` — `DELETE`. Plain delete
  409s `role_in_use` when holders exist; passing `migrateTo` (→
  `?migrate_to=<name>`, ADR-074 phase 3) reassigns every holder to the
  target role and deletes the source in one server-side transaction.
  (go: variadic `RoleDeleteOpts{MigrateTo}`; java: `delete(id,
  migrateTo)` overload.)
- `realm.roles.listPermissions()` — `GET /platforms/{id}/permissions`
  (ADR-074). Returns the live, closed permission catalog as
  `Permission { key, resource, action, label }` rows. Served live —
  never a static SDK constant — so consumers can't drift from the
  server's catalog.

Assigning a role not present in the catalog returns `unknown_role`;
creating a duplicate returns `role_exists`. The `role` value in the
access token is sourced free-form from the catalog.

**Permissions are enforced (ADR-074).** `permissions[]` on a role is a
set of catalog `resource:action` strings. Since ADR-074 the issuer
**enforces** them at request time, resolved **from the DB per request**
(no JWT claim — a grant/revoke takes effect on the next request, and
the wire is unchanged). Write-time validation rejects strings outside
the catalog (`unknown_permission`); a new custom role defaults to
**empty** permissions (grants nothing until a permission is added).
Owner and platform/service tokens are implicit-all. Only the inlined
JWT *claim* remains deferred (§11).

**Per-role required MFA (ADR-075).** `required_mfa_methods` on a role
(subset of `{"totp","otp"}`; unknown values → 400 `unknown_mfa_method`)
forces every holder of the role to satisfy MFA with one of the listed
methods. Precedence with per-user/per-org MFA config is **union/floor
(monotonic)** — a role requirement can only add to what's required,
never weaken it. Surfaced as `RoleObject.required_mfa_methods` (always
an array) and writable via `RoleCreate`/`RolePatch.requiredMfaMethods`
(go: `RequiredMFAMethods []string` / `*[]string` on patch — nil = don't
touch, pointer-to-empty = clear).

These four ship as **system roles** by default, but you may add any others
(`accounts`, `salesman`, `dispatch`, …):

| Wire value | Meaning                                                                 |
|------------|-------------------------------------------------------------------------|
| `owner`    | Full tenant control. Can change roles, delete the tenant, transfer ownership. Each tenant has at least one owner. |
| `admin`    | Manage users + invitations + tenant config; cannot delete the tenant or change owners.                            |
| `member`   | Default role for invited users. Can use the application; no admin operations.                                     |
| `viewer`   | Read-only access. Useful for stakeholders / observers.                                                            |

> **`permissions[]` in the JWT** — the permission *sets* are enforced
> server-side at request time (ADR-074, DB-resolved; see above). The
> access token itself still carries only `role`, not a `permissions[]`
> claim; partners doing offline authz gate on role *name* until the
> claim lands (additive, non-breaking). See §11.

### 6.4 Domains — `realm.domains.*`

`claim({ hostname })`, `verify({ claimToken })`. `claim` is
**idempotent** — re-claiming a still-pending domain returns the same
TXT challenge instead of erroring, so onboarding is resumable.

> **Browser-admin only:** `@realm-id/web-admin` additionally ships
> `platforms.listPendingDomains()` (+ `PendingDomain` type), wrapping
> issuer `GET /domains/pending`, so an admin UI can list and resume
> in-progress domain verifications. Not on the go/ts/java partner SDKs.
> Since ADR-073 (Release A) a platform can also be created **without**
> a domain at all (hosted `<slug>.realmid.dev` login) — the domain
> claim/verify flow is optional onboarding, attachable later.

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
  `{ id, prefix, label, role, createdAt, lastUsedAt?, expiresAt?, revokedAt? }`.
  - `prefix` — non-secret key prefix, stable across logs.
  - `label` — the label supplied at create, and **the only handle on a
    key**: the plaintext is never echoed and `prefix` is derived from the
    stored hash, so an `rk_live_…` found in a log or a deployment config
    cannot be traced to its row by value (ADR-085 §7). Present on list
    rows since issuer v0.61.0; empty string when none was supplied.
  - `role` — the key's bound role (singular; **not** a `scopes` array).
  - `createdAt` / `lastUsedAt` / `revokedAt` — unix seconds;
    `lastUsedAt` and `revokedAt` are nullable. A non-null `revokedAt`
    means the key is revoked.
  - `expiresAt` — unix seconds of the scheduled cutoff, or `null` for a
    non-expiring key (ADR-085 §3). `null` is a VALUE, not an absence:
    "never expires" is a fact a caller must be able to read. An expired
    key behaves exactly like a revoked one and returns the same error
    envelope, so the two are indistinguishable to a key holder.
  - `create({ scope, label?, ttlSeconds?, nonExpiring? })` returns the row
    **plus** a one-time `value` (the secret) that is shown only on
    creation and never returned by `list`. Omitting both `ttlSeconds` and
    `nonExpiring` applies the issuer's built-in 90-day default;
    `ttlSeconds` has a 300s floor and is rejected below it rather than
    clamped. `revoke(id)` is a soft-delete (sets `revokedAt`).
  - **Server-side limits the caller must expect** (ADR-085 §2): a realm
    holds at most 2 ACTIVE platform keys — one steady state, one rotation
    slot — and at most 1 non-expiring. Over the cap, `create` raises
    `too_many_api_keys` (409); a second permanent key raises
    `non_expiring_not_allowed` (400). Revoked and expired keys free their
    slot, so mint-new → deploy → revoke-old always fits.
- `realm.config.update(patch)` — patch realm-level config (TTL
  overrides, default audience, `idle_ttl_seconds` (ADR-070),
  `otp_login_enabled`/`otp_mfa_enabled` (ADR-071), `mfa_policy`
  (ADR-075: `"disabled" | "enabled" | "enforced"` — the platform-wide
  MFA floor; `enforced` requires MFA for every org end-user and forces
  first-login enrollment, `enabled` is a UI hint only), etc., subject
  to the server's configurable-keys allowlist). There is no typed
  per-key SDK method — config keys ride this generic PATCH.
  > `mfa_policy` is also **readable**: the platform DTO returned by
  > `GET /platforms/mine` carries it, typed on `@realm-id/web-admin`'s
  > `Platform.mfa_policy` (0.8.5) so admin UIs can prime the control.
- `single_tenant_membership` (bool, default `false`, ADR-092 D4) rides
  the same generic PATCH. When on, a person may belong to at most ONE
  tenant in the realm. Counts **ACTIVE** memberships only — an invitation
  and a picker-suspended row are both deliberately excluded, so a user can
  still hold and decline their invites. Does not apply to the base realm
  or a realm's admin tenant (a platform's admin tenant lives in the base
  realm while its orgs live in the platform realm, ADR-015/ADR-067, so
  staff legitimately span both). Turning it ON is permitted with
  violations outstanding: the §6.15 picker drains them at each next login,
  and a conflicting membership is thereafter an ERROR (invite and
  ownership transfer refuse with `409 single_tenant_membership`), never an
  automatic move.
- `realm.config.get()` → `{ id, config, singleTenantPendingReconciliation? }`.
  The count is how many people still hold 2+ active memberships while the
  rule is on — a user who never logs in never resolves, so it is the only
  way an admin sees the tail. It sits **BESIDE `config`, not inside it**,
  because it is DERIVED, read-only state; putting it in the settings bag
  would imply it is settable, and PATCHing it answers
  `400 unknown_config_key`. The issuer reports it **only while the rule is
  on**, so absent (`undefined` / `nil` / `null`) ≠ `0`: the former means
  "not reported", the latter "on and fully drained".

### 6.6 End-user API keys — `realm.userApiKeys.*` (ADR-084)

Self-service keys an END USER mints for themselves, distinct from §6.5's
platform-bot keys in every respect: separate table, separate route segment
(`user-api-keys`), separate plaintext prefix (`uk_live_` vs `rk_live_`), and a
separate permission pair (`user_api_keys:read|manage`, so an org admin managing
members' keys does not thereby gain platform-key power).

- `create(tenantId, userId, { label, orgScope?, orgIds?, permissionsCap?, ttlSeconds? })`
  → the row **plus** a one-time `value`. Wire:
  `POST /tenants/{tid}/users/{uid}/user-api-keys`.
- `list(tenantId, userId, opts?)` → paginated rows. Label + non-secret `prefix`
  only; the plaintext is never returned again.
- `revoke(tenantId, userId, id)` — soft revoke.

`userId` MUST be the caller — keys are self-service, with no override: an admin
minting a credential that authenticates AS a member is impersonation by another
name, and ADR-039 is deliberately unbuilt.

**Changed in ADR-091**: the `user_api_keys.admin_mint_allowed` escape hatch is
REMOVED. It is no longer a config key at all — PATCHing it answers
`400 unknown_config_key` rather than being accepted and silently ignored.

Row DTO (code wins — the issuer response is authoritative):
`{ id, prefix, label?, orgScope, orgIds, permissionsCap, mintedMfaAt?, createdAt,
lastUsedAt?, expiresAt?, revokedAt? }`. All `*At` are unix seconds and nullable
except `createdAt`.

- `orgScope` ∈ `"selected" | "all"`. `selected` is a FROZEN allowlist — orgs the
  user joins later do **not** widen the key. `all` is **forward-inclusive** and
  gated on `user_api_keys.allow_all_orgs`.
- `orgIds` is the list **as stored**. An org named here may no longer be
  reachable: revocation on membership loss is an async sweep and live membership
  is re-intersected at every exchange, so a key can *list* an org it can no
  longer *mint into*.
- `mintedMfaAt` is load-bearing, not informational: key exchange is exempt from
  the realm MFA floor if and only if it is set.

#### 6.6.1 Exchange — `auth.userApiKeyLogin`

`auth.userApiKeyLogin(apiKey, { tenantId? })` → the standard login result. Wire:
`POST /auth/login {grant_type: "user_api_key"}`. No inbound bearer — the key IS
the bootstrap credential. `tenantId` is required when the key's live scope
resolves to more than one org; omitting it then returns
`403 org_not_in_key_scope` rather than the SDK picking a blast radius.

The minted access token carries `amr: ["api_key"]` with **no** `mfa` entry, so it
can never satisfy a step-up gate. Errors: `401 invalid_credentials` /
`401 revoked_api_key` (revoked and expired share this envelope on purpose — the
two states are equivalent to a key holder), `412 user_api_keys_disabled`,
`412 mfa_required`.

#### 6.6.2 `permissionsCap` — a CAP, never a grant

**Effective authority is `permissionsCap ∩ the principal's live permissions`,
re-resolved per request.** A cap can therefore only ever UNDER-grant: demote the
holder and every key they hold shrinks with them.

The **name is a control, not decoration**. `permissions: ["reports:read"]` in a
decoded token reads like an OAuth grant and invites
`if (tok.permissions.includes(p)) allow` — the stale-scope hole. `permissionsCap`
makes that line look wrong. It is free to choose now and effectively impossible
later, since it is a wire field partners parse.

Two audiences, two vocabularies:

| | `aud = realmid` | `aud = <partner>` |
|---|---|---|
| Vocabulary | RealmID's own ADR-074 catalog | the partner's, **opaque to RealmID** |
| Validated at mint | yes → `400 unknown_permission` | shape only (count / length) |
| Enforced by | the issuer's gates | **the partner's backend** |

RealmID never pattern-matches, expands or orders these strings: no wildcards, no
hierarchy, no implied `*`.

**`CapAllows(claims, permission, liveResolver)` — required in every language.**

```
capAllows(claims, "reports:read", resolveLivePermissions)  // ts
CapAllows(claims, "reports:read", resolveLivePermissions)  // go / java
```

The signature **forces** the live-permission resolver as a required third
operand. That is the whole point: the insecure one-operand form — "does the cap
list this permission?" — is not expressible in our own API, so a partner cannot
implement the semantics we rejected by accident. `liveResolver` returns the
permissions the principal holds *right now*, from the partner's own store.

Returns false when the cap omits the permission, when the live set omits it, or
when the resolver errors. Failing closed on a resolver error is deliberate: an
unavailable live operand means the intersection is unknown, and the only safe
reading of an unknown intersection is empty.

**Honesty requirement, and it belongs in the partner guide too**: a partner with
no live permission model has nothing to intersect, and the cap becomes their whole
authority — precisely the stale-grant hole. For them the real controls are the
ones RealmID enforces: revocation, expiry, org pinning and the revoke sweep. Say
that plainly rather than implying the cap is self-securing.

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

### 6.11 Service accounts — `realm.serviceAccounts.*` (ADR-071)

First-class machine identities inside a tenant: `users.kind =
"service"` rows that authenticate **only** via a `view_bff`-delivered
OTP login (mapping-1 — a human can never use that path; a service
account can use no other). Provisioned active-from-birth (no invite
expiry, so the invite reaper never touches them) with a unique
email-shaped handle and any non-`owner`/non-`platform_api` role.

Surface — symmetric across go/ts/java, over
`/tenants/{id}/service-accounts` (owner/admin gated):

- `create(tenantId, { handle, role, displayName? })` — mints the
  account. `handle_taken` (409) / `invalid_role` (400) on conflict.
- `list(tenantId, opts?)` / `get(tenantId, id)` —
  `service_account_not_found` (404); operating on a human user via this
  surface fails `not_service`.
- Lifecycle: `suspend` / `unsuspend` / `revoke` (kill sessions) /
  `resetHandle` / `deactivate`.

**Login flow:** an owner/admin issues an OTP with
`otp.issue({ ..., deliveryMode: "view_bff" })` (§X.1) — the plaintext
comes back to the caller (the BFF/console) instead of being delivered
to the subject — hands it to the workload, which calls
`auth.otpLogin(...)`. The minted session is `subject_type: "service"`
(`class="service"`, own refresh-TTL clamp) and carries
`initiated_by_user_id` — the owner/admin who minted the login OTP
(ADR-071 §8 attribution) — decoded on `Session` in all three SDKs.

### 6.12 App/source registry — `realm.sources.*` (ADR-072)

Platform-owned registry of the **apps/sources** allowed to log users
in, and with which methods (mapping-2: App↔Method; enforced by the
issuer at `aud`-resolution — a `client_id` is accepted only if its
source lists the method; a legacy empty-`app_id` row is unrestricted).
Single-kind invariant: a source is a *human* app or a *bot* app, never
both.

Surface — symmetric across go/ts/java, over `/sources`:

- `list()` / `create({ name, kind, allowedMethods, ... })` /
  `update(id, patch)` / `delete(id)`.
- `allowed_methods` must be compatible with the source's kind —
  violations fail `method_violates_kind` (400); missing rows
  `source_not_found` (404).
- A **human** app additionally registers its per-provider `client_id`s
  as `identity_providers` rows bound to the app (`app_id`, typed
  end-to-end incl. `@realm-id/web-admin`); once a provider has ≥1
  app-bound registration it flips to a **hard allow-list** (only those
  client_ids accepted). Firebase stays project-coarse (no per-app
  restriction, ADR-072 §4).

### 6.13 Signing keys — `realm.signingKeys.*`

Owner self-serve view + rotation of the realm's JWT signing keyring:

- `list()` — `GET /platforms/{id}/signing-keys`: the keyring
  newest-first (current key flagged) + the auto-rotation policy.
- `rotate()` — `POST …/rotate`: self-serve owner rotation; shares the
  server-side rate limiter with ops-initiated rotation.

Exposed as `realm.signingKeys` (go/ts/java) and `admin.keys`
(`@realm-id/web-admin`, reusing the ts client via
`@realm-id/sdk/internal`). **Distinct from** web-admin's pre-existing
`admin.signingKeys`, which is the base-realm **staff/ops** client over
`/admin/platforms/…` — `admin.keys` is the platform-owner surface.

### 6.14 Cross-realm integrations — `realm.integrations.*` (ADR-082/083)

A source platform publishes an **integration**; a target org **installs**
it, admitting a `kind=service` principal into the org that holds a chosen
service-typed role; the source platform then **mints** short-lived
target-realm access tokens against the installation. The model is
GitHub-App-shaped (register once → install per org). RI hosts no consent
screen — this surface **is** the consent surface, rendered by the
partner's own console (ADR-083 §5).

The client has two sides plus a mint. All three live on
`realm.integrations` (go/ts/java) and `admin.integrations`
(`@realm-id/web-admin`, reusing the ts client via `@realm-id/sdk/internal`).

**Source side** (the publishing platform, gated `integrations:read|manage`),
over `/platforms/{id}/integrations`. The platform is the SDK's own realm, so
these take no platform id (baked in, like `realm.roles.*`):

- `register({ slug, displayName, description?, homepageUrl?, listed? })`
  — `slug_taken` (409), `invalid_slug` / `display_name_required` (400).
- `list(opts?)` / `update(id, patch)`.
- `disable(id)` / `enable(id)` — reversible halt.
- `remove(id)` — permanent disable (NOT a cascade delete; target orgs'
  inbound history is preserved, ADR-083 §9). `integration_not_found` (404).

**Target side** (the installing org owner, gated `org_grants:read|manage`),
over `/tenants/{id}/integration-installations`:

- `install(tenantId, { integrationId, roleId })` — the `roleId` MUST name
  a role whose `assignable_to` is **exactly `["service"]`** (ADR-082 §7.1);
  anything else fails `role_not_service_typed` (400). Other 400s:
  `integration_disabled`, `role_not_installable` (owner/platform_api),
  `role_disabled`. `already_installed` (409), `integration_not_found` (404).
- `listInstallations(tenantId, opts?)` — the inbound-access list: who can
  act in my org, as what, last used, mint count. This is the sole way a new
  owner discovers foreign access inherited across an ownership transfer
  (ADR-082 §7.4), so consumers should surface a non-zero count at transfer.
- `uninstall(tenantId, installationId)` — revokes the edge; future mints
  fail. Live access tokens are NOT revoked (signature-verified) — the
  exposure is bounded by the fixed 600 s token TTL (ADR-083 §4.4).

**Mint** (the source platform's server, authenticated by its own
`platform_api` key — NOT a user/session token):

- `mintToken({ apiKey, installationId, sourceOrgId })` →
  `{ accessToken, expiresIn }`. Sends
  `POST /auth/login { grant_type: "integration_installation", api_key,
  installation_id, source_org_id }`. **Returns an access token only** — no
  refresh, fixed `expiresIn` of 600 s. This is deliberately NOT a
  token-manager credential: the token cannot refresh, so the caller
  re-mints (and may cache for < `expiresIn`). `source_org_id` is required
  and stamped into the token + target-org audit, but is caller-asserted /
  unverified (ADR-082 §7.6). Errors: `key_class_mismatch` (401, not a
  platform key), `installation_not_found` (404, incl. a key from the wrong
  realm — no cross-realm existence oracle), `installation_revoked` /
  `role_unavailable` (403).

### 6.15 Membership self-service — `realm.me.*` (ADR-092)

The caller acting on their OWN memberships: settle the single-tenant
picker, decline an invitation, leave an org. Purely additive — no
existing call changed.

**Who authorizes.** Every route here is authorized by the END USER, never
by the platform credential alone; there is no path parameter naming
someone else and no admin override. Two modes, matching the rest of the
SDK:

- **direct** — the user's access JWT is the wire bearer
  (`userBearer` / `MeAuth{UserBearer}` / `MeAuth.bearer(...)`).
- **BFF** — the realm's platform token stays the bearer and the user's
  **verified** access JWT rides as `X-User-Token`
  (`userToken` / `MeAuth{UserToken}` / `MeAuth.onBehalfOf(...)`; in Go,
  `WithUserToken(ctx, jwt)` also supplies it).

There is **no user-id mode**. A bare `X-On-Behalf-Of-User` is not an
identity — the issuer removed that in v0.66.0 and answers
`401 x_user_token_required`.

**`me.chooseTenant({ tenantId })`** → `{ tenantId, status: "chosen",
released }`, `POST /me/tenant-choice`. Answers the §4.1 picker:
`tenantId` is the membership to **KEEP**; the caller's other memberships
in that realm are given up. They are **suspended, not deleted** — a
login-time picker is a fast decision made under mild pressure and should
not be the most destructive operation in the product, so an admin can
restore one and `me.leave` remains the deliberate way out. Their sessions
ARE revoked, otherwise the person keeps working in an org they just gave
up until a token expires. Errors: `tenant_required` (400),
`owner_cannot_be_revoked` (409 — the caller owns another org;
`tenants.owner_user_id` is NOT NULL so releasing it would strand the org,
and ownership must be transferred (ADR-076) first; checked BEFORE
anything is mutated, so a refusal never leaves the caller partially
reconciled), `single_tenant_not_required` (409 — the realm does not
require single-tenant membership, so there is nothing to settle), 404.

**`me.acceptInvitation({ tenantId })`** → `{ tenantId, status:
"accepted" }`, `POST /me/invitations/{tenantId}/accept`. Accepts a
**pending** invitation: the lifecycle row is stamped `accepted` and the
membership becomes `active`.

The mirror of `me.rejectInvitation`, and the reason both exist: a realm on
`invitation_acceptance: "explicit"` (see §6.1's realm config) no longer
activates an invitation implicitly at login, so a decline path with no
matching accept path would leave an invitee able to say no and unable to
say yes. On a realm using the default `"auto"` mode this still works — it
settles a row the invitee's next sign-in would have settled anyway.

The lifecycle row is written BEFORE the membership is activated, which is
the concurrency control: `Respond` is the only operation that can lose a
race against a simultaneous reject or an inviter's revoke, so activating
the membership first would let a rejected invitation still grant access.
Errors: `not_invited` / `not_pending` (409),
`invitations_unavailable` (501), 404 (same non-oracle 404 as below).

**`me.rejectInvitation({ tenantId })`** → `{ tenantId, status:
"rejected" }`, `POST /me/invitations/{tenantId}/reject`. Declines a
**pending** invitation. Only an offer can be declined — an active member
wanting out uses `me.leave`, and the server keeps the two apart rather
than letting a stray reject silently end a live membership. The outcome
is recorded, not deleted, and the live-invite unique index is partial, so
the tenant MAY invite the same person again later. Errors: `not_invited`
/ `not_pending` (409), `invitations_unavailable` (501 — the issuer runs
without an invitation-lifecycle store), 404. The 404 deliberately does
not distinguish "no such tenant" from "not yours": that difference would
make the route an existence oracle for tenant ids.

**`me.leave({ tenantId })`** → `{ tenantId, status: "left" }`,
`POST /me/memberships/{tenantId}/leave`. Ends the caller's own
membership. This is the recovery path out of a picker-induced suspension,
which is why it is authorized by the caller's realm session and not by a
session in the tenant being left — requiring the latter would demand the
very access it recovers from. Sessions for that membership are revoked.
Errors: `owner_cannot_leave` (409 — same NOT NULL rule as
`owner_cannot_be_revoked`, transfer ownership first), `already_left`
(409), 404.

**Error-code taxonomy.** All seven codes above are registered in §3.1's
known set in every language, so they reach `error.code` instead of
collapsing into the generic 409 `conflict` — each carries a distinct
remedy and they are indistinguishable by status alone.

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
  calls, or the user's bearer JWT for user-context calls
  (e.g. `listSessions`). It is never a platform refresh token — ADR-089
  withdrew it, and `POST /auth/token` refuses such a session with
  `401 m2m_refresh_withdrawn`. The raw API key never travels in
  `Authorization`; on
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
  cookieDomain?: ".acme.com",                       // optional — see the migration warning below
  cookieDomainMigrateFrom?: [""],                   // scopes previously written; "" = host-only
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

#### Changing `cookieDomain` on a live deployment

**Setting or changing `cookieDomain` after you have live sessions leaves every
affected browser holding TWO cookies of the same name at different scopes.**
This is RFC 6265, not an SDK choice: a `Set-Cookie` carrying a `Domain`
attribute cannot overwrite a host-only cookie of the same name — they are
separate jar entries. Rotation then updates one and freezes the other.

The SDK handles this as follows.

- **Reading.** The middleware tries **every** candidate cookie of the
  configured name (in the order the browser sent them, deduplicated, capped at
  3) until one mints. An already-stranded browser recovers on its next refresh
  with no partner action. Logout revokes every candidate, not just the first.
- **Widening (host-only → `.example.com`) is handled for free.** Setting
  `cookieDomain` also emits a host-only deletion on every write and on logout,
  so the twin is evicted rather than left to shadow the live cookie forever.
- **Tightening or removing a domain needs `cookieDomainMigrateFrom`.** The
  wider cookie is invisible to a configuration that no longer writes it, so the
  SDK cannot discover the scope you are leaving — name it:

  ```jsonc
  // was ".example.com", now host-only
  { cookieDomainMigrateFrom: [".example.com"] }

  // was host-only, now ".example.com": nothing needed
  { cookieDomain: ".example.com" }
  ```

  Entries are emitted as deletions on every write and on logout, so it is safe
  to leave them configured permanently. Drop them once you are confident no
  live browser still holds the old scope. Naming the scope you are currently
  writing is a no-op — the SDK never deletes it, and `.example.com` and
  `example.com` are recognised as the same scope.

Prior to Go `v0.41.0` / Java `0.30.0` the middleware read only the first
matching cookie and cleared only the configured scope, so a single
`cookieDomain` change permanently logged out every live session with no
in-product recovery — not login, not logout, not waiting for expiry.

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
without an extra round trip.

**The issuer's `RequireMFA(pattern, opts)` registry is NOT a backstop
for non-SDK callers** (ADR-096 D3 — this paragraph previously said it
was). It cannot be: under ADR-096 D2 the route→policy map lives in the
ENFORCING backend, and RealmID stores no list of a partner's
operations, so it has nothing to back-stop with. What that registry
actually is, and the only thing that may ever be registered in it, is
the gate for **RealmID's own auth-surface operations** — the ones where
RI is the enforcing party (e.g. `/auth/mfa/recovery/regenerate`).

A non-SDK caller implements the gate itself; the HTTP-level contract it
needs — the `mfa_at` claim, the per-`(session, tenant)` rule (ADR-059),
and the challenge → verify → new-tokens sequence — is written out in
`issuer/docs/partner-integration-guide.md` §5.1.

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

Request: `{ subjectRef, purpose, deliveryMode? }` — `subjectRef` /
`purpose` are opaque tenant-scoped strings. `deliveryMode` (ADR-071):
`"view_bff"` returns the plaintext OTP to the **caller** (the
BFF/manager console) rather than delivering it to the subject — the
handoff used to log service accounts in (§6.11). Constants:
go `DeliveryModeViewBFF`, ts `DELIVERY_MODE_VIEW_BFF`, java
`OtpIssueRequest.DELIVERY_MODE_VIEW_BFF`.
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

## 11. Route authorization — `scope` (ADR-097)

A partner adding an endpoint to their own product must not have to come back and
update configuration inside RealmID. The division:

| Owner | Artefact |
|---|---|
| RealmID | identity, attestation, session lifecycle, the token |
| **your repo** | the route → scope map, and the map from YOUR roles to scopes |
| the SDK | the gate that evaluates one against the other |

RealmID stores **no** partner catalog. Your scope strings are opaque to it:
never parsed, never validated against a vocabulary, never stored.

> **"Your roles" are not RealmID roles.** A RealmID role's `permissions` (§6.3,
> ADR-074) is a closed catalog governing the **RealmID admin API** — what your
> admins may do inside RealmID. It has nothing to do with scopes, which govern
> what a user may do inside **your** product. Your role → scope map lives in
> your database next to your roles; RealmID never sees it.

Three things in this API look like "a list of permission strings". They are not
interchangeable:

| | role `permissions` (§6.3) | `permissionsCap` (§6.6.2) | `scope` (§11) |
|---|---|---|---|
| Answers | what may my admin do **inside RealmID**? | ceiling on this key | what may this user do **inside my product**? |
| Whose words | RealmID's, fixed catalog | **mine** — see below | **mine** |
| Validated by RealmID? | always | only for `realmid`-audience keys | never — shape only |
| Other operand | n/a | my DB, via `capAllows` | my route map |

**`permissionsCap` is the one that shifts.** Its audience is derived from the
realm the user lives in, never supplied. In **your** realm the strings are yours
and are shape-checked only (count, length) — RealmID cannot validate a
vocabulary it does not hold. In RealmID's own base realm they are the ADR-074
catalog and ARE validated (`unknown_permission`); that is RealmID being a
platform on itself, not a rule about you.

### 11.1 The claim

`scope` — a **space-delimited string**, RFC 9068 §2.2.3, which defines it by
reference to RFC 8693 §4.2 in RFC 6749 §3.3 format. **Not an array.** RFC 9068
§2.2.3.1's array-shaped `groups`/`roles`/`entitlements` express identity
*attributes* of the subject, not granted scope for the token.

> **Conformance, stated honestly:** adopting this claim aligns *this claim* with
> RFC 9068. It does not make the token conformant — RealmID emits neither
> `client_id` nor `typ: "at+jwt"`. Full conformance is a follow-up.

**Charset (RFC 6749 §3.3):** `%x21 / %x23-5B / %x5D-7E` — printable ASCII minus
SPACE, `"` and `\`. **Case-sensitive**, no normalization. A space inside a value
would split one scope into two, so a malformed entry is refused at mint
(`invalid_scope`) rather than silently reshaped.

**Bounded** by the realm's `user_api_keys.max_permission_strings` and
`max_permission_string_len` (defaults 32 / 128) — `too_many_scopes` /
`scope_too_long`. The same knobs, not a second limit vocabulary for the same
kind of string.

### 11.2 Getting a scoped token

Send `scope` on `POST /auth/token`. **From your BACKEND** — and that is
structural, not a request: the ADR-041 escort runs on that route for every
refresh class, so a browser cannot reach it directly and self-assert a scope.

Three properties worth knowing before you build against it:

- **Intersected server-side.** When the session came from a user API key, the
  minted claim is `scope ∩ permissions_cap` — exact match, no wildcards, no
  hierarchy. RealmID does this so a caller who bypasses the SDK still gets a
  narrowed token.
- **Re-resolved on every call.** The claim is never stored on the session. Send
  it each time; omitting it mints no `scope` at all.
- **Refused, not ignored, where it cannot apply.** A service-class refresh
  answers `scope_not_supported`, and a `scope` inside `custom_claims` answers
  `reserved_claim_key`.

### 11.3 Layer 1 — the predicate

```go
realmid.ScopeAllows(claims, "orders:read", "orders:write") // ALL of them
realmid.ScopeAllowsAny(claims, "r:a", "r:b")               // at least one
realmid.ScopesFrom(claims)                                 // []string
```

```ts
scopeAllows(claims, "orders:read", "orders:write");
scopeAllowsAny(claims, "r:a", "r:b");
scopesFrom(claims);
```

```java
Scopes.scopeAllows(claims, List.of("orders:read", "orders:write"));
Scopes.scopeAllowsAny(claims, List.of("r:a", "r:b"));
Scopes.scopesFrom(claims);
```

**All-of is the default**, because it is the safe reading of a list: passing two
scopes and getting any-of would grant you on half the evidence you asked for,
and nothing would tell you. Any-of has to be named.

**Fails closed**, including on an EMPTY requirement — `scopeAllows(claims)` with
no scopes is **false**, not true. "Requires nothing" is almost always a route
someone forgot to configure, and vacuous-true is how a gate silently stops
gating. A genuinely public route is declared (§11.4).

**No pattern matching.** `read` does not imply `read:orders`; `Read` is not
`read`; `*` is a scope named `*`. Same rule as `capAllows` (§6.6.2), same
reason: RealmID does not interpret your vocabulary, and neither does the SDK.

### 11.4 Layer 2 — the route map

```go
policy := realmid.ScopePolicy{Rules: []realmid.ScopeRule{
    {Path: "/health", Public: true},
    {Path: "/orders/**", Method: "GET", Scopes: []string{"orders:read"}},
    {Path: "/orders/**", Scopes: []string{"orders:write", "orders:read"}},
    {Path: "/reports/**", Scopes: []string{"r:a", "r:b"}, AnyOf: true},
}}
for _, err := range policy.Validate() { log.Fatal(err) }
compiled := policy.Compile()
```

**It denies by default.** A request matching no rule is refused — adding an
endpoint and forgetting to declare its scope must produce a locked door, not an
open one. `Public` exists so that "unauthenticated" is something you SAY, never
something you get by forgetting.

**First match wins**, so place a specific rule before the general one it
narrows. Order-dependence is stated rather than sorted-for: "most specific wins"
needs a specificity metric, and any metric would be a guess about your routing.

**`Validate()` returns every problem, not the first** — including a scope RealmID
would refuse to mint, which would otherwise present as a route no token can ever
satisfy. Run it at startup.

### 11.5 Layer 3 — framework adapters

| Language | Adapter |
|---|---|
| Go | `compiled.Middleware(...)` — `net/http` |
| TypeScript | `createScopeMiddleware(...)` — Express/Connect; `fastifyScopeHook(...)` |
| Java | `ScopeFilter` — a servlet `Filter` (works in Spring MVC / Boot unchanged) |

Mount them **inside** the auth middleware, which is what verifies the token and
puts the claims where the adapter reads them. Mounted outside, there are no
claims and every request is — correctly, and unhelpfully — denied.

They answer **403** with RFC 6750 §3.1's `insufficient_scope`, and deliberately
**do not name the missing scopes on the wire**: telling an unauthorized caller
which permissions they lack is a map of your authority model, handed out for
free. The names reach *your* server through the denial hook.

There is no Gin/Echo/Fiber adapter, and no Spring-native one. These SDKs take
zero external dependencies (Java's only web dependency is a `compileOnly`
servlet API), and importing a framework would put it in every partner's tree
including the ones who do not use it. Layer 2 is the adapter surface — three
lines in any framework:

```go
r.Use(func(c *gin.Context) {
    cl, _ := realmid.ClaimsFrom(c.Request.Context())
    if !compiled.Decide(cl, c.Request.Method, c.Request.URL.Path).Allowed {
        c.AbortWithStatus(http.StatusForbidden)
        return
    }
    c.Next()
})
```

### 11.6 Token scope vs `capAllows` — which to use, and when

Both are correct. They trade different things, and mixing them without deciding
gets you the worst of both.

| | token scope (§11) | `capAllows` (§6.6.2) |
|---|---|---|
| per-request I/O | none | one live read |
| revocation lag | the realm's `access_ttl_seconds` (1..86400) | **zero** |
| where the map lives | your repo | your repo |

**The rule: token scope by default; `capAllows` for operations where a stale
grant is unacceptable** — money movement, permission administration, data
export.

`capAllows` is **not deprecated**. Token-carried scope converts zero-lag
revocation from *impossible* to *bounded*; it does not replace it. Set
`access_ttl_seconds` to the lag you can accept.

### 11.7 Renaming a scope

`POST /platforms/{id}/scopes/rename` (realm owner) rewrites one of your scope
strings across every user API key cap in the realm, in one transaction:
idempotent, deduping on collision, `?dry_run=true` for the counts.

**Not reversible in general** — where a key held both `from` and `to`, the merge
destroys what a reversal would need. That is why the dry run and the audit
record exist.

Refused on a `realmid`-audience realm, whose vocabulary is RealmID's own
catalog. `realm_roles.permissions` is not renamed for the same reason: it is
validated against that catalog on every write, in every realm, so it cannot hold
your vocabulary.

### 11.8 Removing a scope

`POST /platforms/{id}/scopes/remove` (realm owner) deletes one of your scope
strings from every cap in the realm. Same gate, same transaction discipline,
same `realmid`-audience refusal.

**It is a separate endpoint, not a flag on the rename, because removal is not
reliably a narrowing operation.** An empty `permissions_cap` means **NO
RESTRICTION** (§6.6.2) — so a key holding this scope and nothing else does not
become powerless when you remove it, it becomes *unrestricted*: unconstrained at
RealmID's permission gates, and passing every scope it requests through
unfiltered.

So such a key is treated as a **precondition failure**:

| `on_empty` | behaviour |
|---|---|
| `refuse` (default) | Writes NOTHING — not even the keys that were not at risk — and answers `409 scope_removal_would_uncap`. |
| `revoke` | Removes the scope AND revokes those keys, in the same transaction. Destructive and irreversible, so it must be named; an unrecognised value is rejected (`400 invalid_on_empty`), never defaulted. |

**`?dry_run=true` always answers `200`, even when the write would answer 409**,
and carries an `emptied` array naming the affected keys. That asymmetry is
deliberate: the error envelope carries no structured payload, so the preview is
the only surface that can hand you the list. It still reports the true outcome
in `outcome` (`applied` · `would_apply` · `refused`), and a refusing preview
still reports the full `keys` count so you can judge whether `revoke` is
proportionate.

Revoked and expired keys are never counted as blockers — they cannot mint — but
their caps are still rewritten, so the vocabulary stays consistent everywhere it
is stored.

## 12. Roadmap (deferred)

Detailed proposals tracked in repo `TODO.md`. Headlines:

- **`permissions[]` JWT claim** — `realm_roles.permissions` is stored,
  editable, **and enforced server-side at request time** (ADR-074,
  DB-resolved — see §6.3); only inlining the claim into the access
  token remains deferred. The claim is explicitly *not* needed for
  enforcement — it would serve partner-side **offline** authorization
  only. When demand materializes it's added non-breakingly by sourcing
  from the catalog. No committed ETA.
- Webhooks (`realm.webhooks.verify(payload, signature)`)
- OpenID Connect discovery (`/.well-known/openid-configuration`)
- Impersonation (`auth.impersonate({ targetUserId, reason })`)
- WebAuthn / passkeys
- Custom domains for hosted UIs
- CSRF protection layer in the middleware (double-submit-cookie pattern)
- ~~BFF on-behalf-of parity for the TS SDK's current-user session/MFA
  methods (§4.5–4.10)~~ — **CLOSED 2026-08-21 by measurement, not code.**
  Against a live issuer a platform bearer plus a bare
  `X-On-Behalf-Of-User` answers `401 x_user_token_required`, and a
  platform bearer plus `X-User-Token` — with no id at all — answers
  `200`. `realm.withUserToken()` already sends that shape in all three
  SDKs, so TS was never missing the working mode; the mode it was
  "missing" is the one the issuer refuses. Go and Java now refuse a
  tokenless on-behalf-of call locally (see §4.7)
- Idempotency-key pass-through on mutations

## 13. Versioning

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
| Go       | `go/v0.44.0`        | slash form; resolved by `go get`. ADR-095 D5 `me.AcceptInvitation`. |
| TS       | `ts-v0.35.0`        | `@realm-id/sdk@0.35.0` on npm. Same ADR-095 surface. |
| Java     | `java-v0.34.0`      | `dev.realmid:sdk:0.34.0` on Maven Central. Same ADR-095 surface. |

> The three languages ship in lockstep per SPEC change (matching
> CHANGELOG entries); this matrix drifts between releases — `git tag`
> in this repo is the source of truth. Browser packages
> (`@realm-id/web@0.4.5`, `@realm-id/web-admin@0.8.5`, adapters) are
> versioned per-package under `web/`.
