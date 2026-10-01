# BFF-SPEC.md — Contract between `@realm-id/web` and a partner BFF

> **Status**: Draft, v0.2
> **Owners**: Realm-ID core
> **Related**: ADR-052 (browser SDK), ADR-050 (api.realmid.dev BFF reference impl)

The browser SDK (`@realm-id/web`) talks **only** to the partner's BFF. The
BFF holds the API key and brokers calls to `auth.realmid.dev` via the Node
SDK (`@realm-id/sdk`). This document pins the HTTP contract between the SDK
and any partner BFF. The companion admin-UI SDK
[`@realm-id/web-admin`](./packages/admin/README.md) consumes the same
contract via `realm.fetch`; routes added to that package are noted
inline below where they overlap.

The shapes below describe the **canonical wire contract**. The SDK defaults
to consuming them as-is. Partners whose existing backend ships a different
shape can plug in [response adapters](#response-adapters) and
[error gates](#error-gates) (added in SDK v0.2) so the SDK normalises the
partner's wire shape into the canonical types — no fork required.

Partners may override individual route paths via the SDK's `endpoints`
config (ADR-052 §2).

## Conventions

- All requests/responses are `application/json` unless noted.
- Refresh credential lives in an httpOnly cookie set by the BFF on the
  partner's domain, **or** is replayed via a SDK-side `StorageAdapter`
  (see [Session restore](#session-restore)). The SDK never reads or
  sets cookies directly; it only forwards them via
  `credentials: "include"`.
- Access JWT is returned in JSON bodies and held in memory by the SDK.
- Success bodies MAY be wrapped as `{ "data": <body> }` — the SDK
  unwraps once if the only top-level key is `data`.
- Error bodies SHOULD follow `{ "error": { "message": "..." } }`. The
  SDK also tolerates `{ "message": "..." }`.

### Relaying an upstream error: preserve BOTH envelope levels

**Normative, and easy to miss.** When your BFF relays a refusal that came from
`auth.realmid.dev`, the gate payload the browser SDK needs is not always where
you would put it. GoFr merges every key the issuer's `Response()` map adds into
ONE object and renders it **under `error`**, so an issuer `412` arrives as:

```json
{ "error": { "code": "mfa_required", "mfa_challenge_token": "…", "tenant_id": "…" } }
```

whereas a BFF emitting its own gate naturally writes the payload **beside**
`error` (this is what the reference BFF's `writeStepUpChallenge` does):

```json
{ "error": { "code": "mfa_required" }, "mfa_challenge_token": "…" }
```

Both shapes are legal on this contract. A BFF MUST NOT flatten the upstream
envelope to `{code, message}` when relaying: dropping `mfa_challenge_token`,
`revocation_token` or `active_sessions` leaves the SPA's step-up prompt and
session-limit modal with nothing to act on, and the failure is **silent** — the
call fails, the modal never opens, the user sees a dead button.

Readers on both sides already handle both levels, with the **nested** level
winning a name collision: `parseErrorEnvelope` in `@realm-id/web` and
`@realm-id/sdk`, and `ParseErrorEnvelope` / `ProxyStatus` in the Go SDK
(`ProxyStatus` returns the collected `details` for you to relay verbatim). A
`gates[].extract` on the SDK side receives the parsed body, so it can read
either level too. Use them rather than re-deriving; a hand-rolled reader that
looks at one level only is the recurring defect this note exists to prevent.

Note also the **code-less** rejection: GoFr's own middleware refusing a bad
`Authorization` bearer answers `{"error": "Unauthenticated"}` with no `code` at
all. A relay or a retry guard keyed on `code` never fires on it — branch on the
status.

## Routes

### `GET /providers` — identity-provider discovery

Lists enabled providers for the realm/tenant scope.

**Query**

| Name        | Type   | Required | Notes                                      |
|-------------|--------|----------|--------------------------------------------|
| `tenant_id` | uuid   | no       | Scope to a tenant; default = realm-level   |
| `client_type` | enum | no       | `web` (default), `ios`, `android`, …       |

**Response 200**

```json
{
  "providers": [
    { "id": "uuid", "provider": "google", "clientType": "web", "clientId": "…", "allowedOrigins": ["https://app.partner.com"], "enabled": true, "nickname": "Acme SSO" }
  ],
  "tenantId": "uuid",
  "signupMode": "open",
  "allowedSignupDomains": ["partner.com"]
}
```

**Two OPTIONAL fields the SDK reads and this spec did not name.** Both were
typed in `@realm-id/web` and absent here, so a BFF author implementing from this
document alone would have shipped neither.

| Field | Where | Required | Meaning when ABSENT |
|---|---|---|---|
| `tenantId` | response root | no | The server did not resolve a tenant — **not** "no tenant". A realm-root origin (`app.realmid.dev`, a partner admin console) legitimately has none, and the subsequent `login` is made WITHOUT a `tenantId`, which the issuer resolves realm-wide. Never substitute a default. |
| `nickname` | each provider row | no | No operator label is configured; render the raw `provider` name. Where present it is the label to show INSTEAD (ADR-047) — an operator who renamed "microsoft" to "Staff sign-in" expects to see that on the button. |

`tenantId` exists because discovery is anonymous and origin-bound: a login page
has no session to ask, so the tenant it must carry into `login` can only come
from this call.

### `POST /login` — exchange provider credential for session

**Request**

```json
{ "method": "google", "providerToken": "<id-token>", "tenantId": "optional" }
```

`method` ∈ `firebase | google | password | otp`. `email`/`password`/`otpCode`
fields are accepted for password and OTP flows.

**Response 200** (success)

```json
{
  "accessToken": "eyJ…",
  "expiresIn": 3600,
  "expiresAt": "2026-05-08T12:00:00Z",
  "user": { "id": "uuid", "email": "u@x", "displayName": "User" },
  "tenants": [{ "id": "uuid", "role": "owner", "displayName": "Acme" }],
  "defaultTenantId": "uuid"
}
```

**Response 200** (MFA gate)

```json
{
  "accessToken": "",
  "expiresIn": 0,
  "user": { "id": "uuid" },
  "tenants": [],
  "mfa": { "challengeId": "uuid", "method": "totp" }
}
```

The BFF MUST set the refresh cookie on success (httpOnly, Secure,
SameSite=Lax or Strict).

### `POST /token` — refresh access JWT

Cookie-bound. The SDK calls this on proactive refresh (~60 s before
expiry) and on 401-replay. Concurrent calls in the SDK are deduped.

**Request**

```json
{ "tenantId": "uuid" }
```

**Response 200**

```json
{ "accessToken": "eyJ…", "expiresIn": 3600 }
```

**Errors**

- `401 unauthorized | session_expired | session_replaced` → SDK clears
  state and emits a `logout` event with the matching reason.

### `POST /switch-tenant` — mint access JWT for a different tenant

**Request** `{ "tenantId": "uuid" }`

**Response 200** `{ "accessToken": "eyJ…", "expiresIn": 3600 }`

The SDK validates that `tenantId` is in the current session's tenants
list before calling, so 404 here is a server-side error.

### `POST /mfa/challenge` — mint a challenge

**Request** `{ "method": "totp" | "sms" | "email", "destination": "+1…" }`

**Response 200** `{ "challengeId": "uuid" }`

### `POST /mfa/verify` — consume a challenge

**Request** `{ "challengeId": "uuid", "code": "123456" }`

**Response 200** — same shape as `POST /login` (200 success branch).

### `POST /logout` — revoke session

**Request** `{}`

**Response** 204 or 200. The SDK treats 401/404 as "already logged out"
and proceeds with local cleanup.

The BFF MUST clear the refresh cookie.

### `GET /me` — session echo

Used on SDK init to restore session state.

**Response 200**

```json
{
  "user": { "id": "uuid", "email": "u@x" },
  "tenants": [{ "id": "uuid", "role": "owner" }],
  "currentTenantId": "uuid",
  "expiresAt": "2026-05-08T12:00:00Z"
}
```

**Response 401** — anonymous; SDK sets `status = "anonymous"`.

## Session restore

The SDK's `autoRestore` (default `true`) supports two transports
side-by-side:

- **HttpOnly cookie** — the BFF MAY set a refresh cookie on `POST
  /login`. On boot, the SDK calls `GET /me` with
  `credentials: "include"` and rehydrates from the response. Nothing
  client-side persists.
- **StorageAdapter** — partners that prefer (or can only support) a
  JSON-only transport configure
  `createRealm({ storage: localStorageAdapter() })` (or
  `sessionStorageAdapter`, or a custom `StorageAdapter`). The SDK
  writes `{ accessToken, expiresAt, tenantId? }` on every successful
  `login`/`adopt`/`switchTenant`, paints `authenticated` synchronously
  on the next boot from the stored entry, then revalidates with `/me`
  in the background.

The BFF doesn't need to know which transport the SDK chose. If both are
present, the cookie wins on the `/me` round-trip (the storage entry is
overwritten with the freshest server view). Both modes are first-class
and the canonical contract is unchanged.

## Response adapters

Each canonical response shape (`LoginResponse`, `MeResponse`,
`TokenResponse`, `ProvidersResponse`) has a matching adapter slot on
`createRealm({ adapters })`. The adapter takes the raw parsed body plus
an `AdapterContext` (`{status, headers, currentAccessToken}`) and returns
the canonical shape:

```ts
createRealm({
  baseUrl: "https://api.partner.com",
  adapters: {
    login: (raw) => {
      const b = raw as Record<string, unknown>;
      return {
        accessToken: b.session_token as string,
        expiresAt: b.expires_at as number,
        user: {
          id: (b.user as any).id,
          email: (b.user as any).email,
          displayName: (b.user as any).display_name,
        },
        tenants: ((b.tenants as any[]) ?? []).map((t) => ({
          id: t.id, role: t.role, displayName: t.display_name,
        })),
        defaultTenantId: (b.tenants as any[])?.[0]?.id,
      };
    },
  },
});
```

If the body uses an envelope (`{ data: { ... } }`), the SDK strips it
once before invoking the adapter (single-key `data` only).

The adapter MAY return additional gate flags:

- `{ tenantsRequired: true, tenants: [...] }` — caller must pick a tenant
  and re-login. Surfaces as `RealmError("tenants_required")` and populates
  `realm.getState().pendingTenants`.
- `{ mfa: { challengeId?, challengeToken?, method? } }` — success-body MFA
  gate (no tokens issued). Surfaces as `RealmError("mfa_required")` with
  the MFA payload on `error.body`.

## Error gates

Some BFFs use HTTP status codes (typically 412) plus a body-level `code`
field instead of in-body discriminators. The SDK's `gates` config maps
those into the same canonical errors:

```ts
gates: [
  {
    status: 412,
    code: "mfa_required",
    gate: "mfa_required",
    extract: (b) => ({
      challengeToken: (b as any).mfa_challenge_token,
      method: (b as any).method,
    }),
  },
  {
    status: 412,
    code: "session_limit_reached",
    gate: "session_limit_reached",
    extract: (b) => ({ revocationToken: (b as any).revocation_token }),
  },
];
```

Gates are checked before generic 4xx classification. The matched rule
emits a `RealmError` whose `code` equals `gate` and whose `body` contains
whatever `extract` returns plus `{ raw }` for debugging. Built-in gate
codes: `mfa_required`, `mfa_registration_required`, `session_limit_reached`,
`tenants_required`.

## Refresh-token rotation inside the BFF

RealmID refresh tokens are **one-time-use, and reuse revokes the whole session
chain** (ADR-031); the issuer keeps no grace window (owner ruling 2026-10-01).
Two parallel `/token` calls carrying one refresh token, or a reload that aborts
an in-flight one, sign the user out.

**MANDATORY (v0.63.0, UNRELEASED — until then this section read "does not
mandate a mechanism"):** a BFF **serializes refresh per session**, and a
concurrent caller that loses the race **receives the winner's outcome** — the
same tokens, or the same error — never a second mint with the same refresh
token. Concretely, for every BFF:

1. A per-session lock around the mint, shared across replicas, with a crash TTL.
2. A loser waits for the winner's outcome; it does not mint.
3. A short window (≤ 5 s) in which a repeat of the just-consumed refresh token
   gets the stored outcome — this is what makes a reload survive.
4. Mint and persist on a context the client's disconnect cannot cancel.
5. A tenant switch takes the same lock and mints against the ROTATED token.
6. **MFA verify takes the same lock** when the request carries the session's
   refresh token: the issuer's MFA verify ROTATES that session's refresh token,
   so an ADR-096 step-up racing a refresh spends one token twice.

The SDK middleware does all six (SPEC §10.1 step 4a). Its lock is only as
shared as the store the partner passes: from v0.63.0 the SDK refuses to
construct without an explicit `SessionStateStore` (SPEC §6.7.5), so a
multi-replica BFF must pass a shared one — the in-memory store satisfies
point 1 only for a single replica. A loser whose request differs from the
winner's (another tenant) gets `503 { error: { code: "server_error" }, retry:
true }` carrying the winner's rotated refresh token (cookie or body), and the
client retries (SPEC §10.1 step 4a). A hand-rolled BFF
follows [`sdk/docs/partner-integration-guide.md` §6.7](../docs/partner-integration-guide.md).
After a successful rotation a BFF that verifies access tokens itself calls
`tokens.recordRefresh(newAccessToken)` (SPEC §6.7.2).

### The browser side: one refresh across tabs (`@realm-id/web`, v0.63.0, UNRELEASED)

Today `token-manager.ts` single-flights per **tenant** within one tab
(`web/packages/core/src/token-manager.ts:114-120`) and `multi-tab.ts` carries
events only (`token_refreshed` has no payload). But the refresh cookie belongs
to the session, not the tenant or the tab, so the browser SDK:

- **Takes a Web Lock** around every `/token` call:
  `navigator.locks.request("realmid-refresh:" + channelName, { mode:
  "exclusive" }, …)`, where `channelName` is the tab bus's (one per BFF base
  URL). One lock per BFF, **not per tenant**: two tenants in one tab share the
  cookie too.
- **Inside the lock, first adopts a fresh sibling result:** if a
  `token_refreshed` for the same `tenantId` arrived within the last 5 s and its
  expiry is later than the held token's, it uses that token and does not call
  `/token`. Otherwise it calls `/token`.
- **Shares the result over BroadcastChannel:** `{ type: "token_refreshed",
  tenantId, accessToken, expiresAt }`. A receiving tab adopts it for that
  tenant when its expiry is later than what it holds. Tokenless mode
  (`refresh.tokenless`) sends no `accessToken`; the receiver advances only the
  expiry of the bearer it already has.
- **Never writes a token to `localStorage`.** When BroadcastChannel is absent
  the bus falls back to `storage` events (`multi-tab.ts`); on that path the
  message carries `{ type: "token_refreshed", tenantId }` only, and a tab still
  refreshes for itself — serialized by the lock.
- **On `503` with `retry: true` from `/token`**, the token manager adopts the
  refresh token the response carries (body mode; cookie mode needs nothing)
  and retries `/token` ONCE, inside the same lock. A second `503` is a failed
  refresh, not a lost session.
- **Why this ships BEFORE the backend SDK (owner ruling 2026-10-01).** A v0.63
  backend refuses an access token older than the session's last rotating
  refresh in that org (SPEC §10.1 step 4b). An older `@realm-id/web` keeps one
  token per tab, so two tabs in one org take turns invalidating each other —
  each tab switch costs a `401` + `revoked: true`, a refresh and a retry, and
  nobody is logged out. Upgrade `@realm-id/web` to v0.63 first; it works
  unchanged against a v0.62 backend. There is no setting to turn 4b off. A
  browser without BroadcastChannel (the `storage` fallback below carries no
  token) has the same churn even on v0.63.
- **When `navigator.locks` is absent**, the SDK keeps today's per-tab
  single-flight, widened from per-tenant to per-BFF, and relies on the BFF's
  mandatory serialization above as the backstop. No lock is emulated over
  `localStorage`: such a lease is racy, and the server side is already correct.

### Org-session mode in the browser (v0.63.0, UNRELEASED)

`/token`, `/login` and MFA-verify success bodies carry `org_session_mode`
(SPEC §6.7.3, §10.1 step 4b). Absent → `concurrent` (an older BFF).

- **`concurrent`** — today's model: one held token per tenant, each refreshed
  on its own. A refresh for Globex refuses only older Globex tokens.
- **`exclusive`** — one org at a time. After a successful `/token` for tenant
  Y the token manager **drops every held token for any other tenant** (they
  are already refused server-side) and broadcasts `{ type: "tenant_switched",
  tenantId: Y }` (an existing message type, `multi-tab.ts:11`) in addition to
  `token_refreshed`. A receiving tab drops its other-tenant tokens and follows
  the existing `tenant_switched` path rather than refreshing its old tenant —
  refreshing it would end tenant Y in the first tab, and the two tabs would
  take turns ending each other's org on every request.
- A tab that still receives `401` + `revoked: true` for a tenant it was using
  (no broadcast reached it: no BroadcastChannel, closed laptop) refreshes once,
  as today. In `exclusive` mode that is the user re-choosing that org.

### Logout (v0.63.0, UNRELEASED)

A BFF revokes the session named by the ISSUER's logout response (`sid`, from
Issuer A), which it gets by presenting the refresh token — so logout works for
a client that sends no bearer at all (SPEC §10.1 step 3a). `POST /logout` also
sends the current access token as `Authorization: Bearer` when the SDK holds
one (today it sends none, `web/packages/core/src/realm.ts:453-458`): against
an issuer older than Issuer A the BFF falls back to it, and only if it verifies
AND has not expired. An expired or missing bearer revokes nothing locally; the
issuer-side logout happens either way. A BFF that ignores the bearer is
unaffected.

## Tokenless `/token` rotation

Some BFFs rotate the underlying user JWT server-side (e.g. inside Redis)
and use a stable opaque session-id as the bearer. In that mode `/token`
returns only `{ expiresAt }` (no `accessToken`). Set
`refresh: { tokenless: true }` and the SDK keeps using the previous
bearer, only advancing its expiry. Combine with `refresh: { sendBearer:
true }` if `/token` itself needs the current session bearer for auth.

## Reference implementation

realmid.dev runs a reference BFF at `api.realmid.dev`. It
deviates from the canonical wire shape in 6 places (snake_case, status
discriminator on /login, tokenless /token, flat /me, 412-gated MFA + 412
session-limit) — the published `@realm-id/web-bff-realmid` preset bundles
the adapters/gates/refresh flags needed to wire the SDK to it in one
import. Partners can fork the preset, or implement the
canonical contract from scratch.

**This is a known boundary defect, not a design.** RealmID's own BFF not
following RealmID's own BFF-SPEC means the code path a *spec-following* partner
BFF exercises in `@realm-id/web` is the one RealmID itself never runs — so the
canonical path is the LESS exercised of the two, and a regression in it would be
found by a partner rather than by us. The adapters quarantine the symptom; they
do not remove it.

Converging the two (either the reference BFF moves onto the canonical shape, or
the SPEC is amended to bless a shape it already describes as a deviation) is
**ADR-worthy and deliberately out of scope** of the 2026-08-30 SDK dogfooding
work. Filed in `sdk/TODO.md` § Known contract debt. Until it is closed, treat
the canonical path as the one needing explicit test coverage — do not infer it
is exercised because `api.realmid.dev` is healthy.

**A partner BFF should implement the canonical contract**, not imitate the
reference one. `@realm-id/web-bff-realmid` exists for talking to
`api.realmid.dev`; it is not a template.

## Versioning

This contract follows the same lockstep version as `@realm-id/web`. A
breaking change bumps the SDK major and ships an ADR. Backwards-
compatible additions (new optional fields, new endpoints) are minor
bumps. v0.2 added adapter and gate config; the canonical wire shape did
not change.
