# BFF-SPEC.md — Contract between `@realmid/web` and a partner BFF

> **Status**: Draft, v0.2
> **Owners**: Realm-ID core
> **Related**: ADR-052 (browser SDK), ADR-050 (api.realmid.dev BFF reference impl)

The browser SDK (`@realmid/web`) talks **only** to the partner's BFF. The
BFF holds the API key and brokers calls to `auth.realmid.dev` via the Node
SDK (`@realmid/sdk`). This document pins the HTTP contract between the SDK
and any partner BFF. The companion admin-UI SDK
[`@realmid/web-admin`](./packages/admin/README.md) consumes the same
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
    { "id": "uuid", "provider": "google", "clientType": "web", "clientId": "…", "allowedOrigins": ["https://app.partner.com"], "enabled": true }
  ],
  "signupMode": "open",
  "allowedSignupDomains": ["partner.com"]
}
```

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

## Tokenless `/token` rotation

Some BFFs rotate the underlying user JWT server-side (e.g. inside Redis)
and use a stable opaque session-id as the bearer. In that mode `/token`
returns only `{ expiresAt }` (no `accessToken`). Set
`refresh: { tokenless: true }` and the SDK keeps using the previous
bearer, only advancing its expiry. Combine with `refresh: { sendBearer:
true }` if `/token` itself needs the current session bearer for auth.

## Reference implementation

Realm-ID's own BFF lives at <https://github.com/Realm-ID/bff-api>. It
deviates from the canonical wire shape in 6 places (snake_case, status
discriminator on /login, tokenless /token, flat /me, 412-gated MFA + 412
session-limit) — the published `@realmid/web-bff-realmid` preset bundles
the adapters/gates/refresh flags needed to wire the SDK to it in one
import. Partners can fork the BFF, fork the preset, or implement the
canonical contract from scratch.

## Versioning

This contract follows the same lockstep version as `@realmid/web`. A
breaking change bumps the SDK major and ships an ADR. Backwards-
compatible additions (new optional fields, new endpoints) are minor
bumps. v0.2 added adapter and gate config; the canonical wire shape did
not change.
