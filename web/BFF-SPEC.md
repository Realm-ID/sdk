# BFF-SPEC.md — Contract between `@realmid/web` and a partner BFF

> **Status**: Draft, v0.1
> **Owners**: Realm-ID core
> **Related**: ADR-052 (browser SDK), ADR-050 (api.realmid.dev BFF reference impl)

The browser SDK (`@realmid/web`) talks **only** to the partner's BFF. The
BFF holds the API key and brokers calls to `auth.realmid.dev` via the Node
SDK (`@realmid/sdk`). This document pins the HTTP contract between the SDK
and any partner BFF.

Partners may override individual route paths via the SDK's `endpoints`
config (ADR-052 §2). Wire shapes (request/response bodies) are fixed.

## Conventions

- All requests/responses are `application/json` unless noted.
- Refresh credential lives in an httpOnly cookie set by the BFF on the
  partner's domain. The SDK never reads or sets it.
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

## Reference implementation

Realm-ID's own BFF lives at <https://github.com/Realm-ID/bff-api>. It
implements this contract (with minor route-name differences absorbed by
the SDK's `endpoints` override) and runs on Cloud Run. Partners are free
to fork it or implement the contract from scratch in any language.

## Versioning

This contract follows the same lockstep version as `@realmid/web`. A
breaking change bumps the SDK major and ships an ADR. Backwards-
compatible additions (new optional fields, new endpoints) are minor
bumps.
