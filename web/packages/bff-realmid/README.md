# `@realm-id/web-bff-realmid` — preset for the realmid.dev reference BFF

Drop-in adapter + gates + endpoints for `@realm-id/web` so it talks
correctly to [Realm-ID/api][bff-api] (the canonical reference BFF,
formerly `Realm-ID/bff-api`; implements [BFF-SPEC.md][spec], with
realmid-specific extensions).

[bff-api]: https://github.com/Realm-ID/api
[spec]: ../../BFF-SPEC.md

## Why this exists

The reference BFF deviates from [BFF-SPEC.md][spec] in six places —
ones likely to recur for any partner whose backend predates the SPEC:

1. **snake_case wire shape** (`session_token`, `expires_at`, …).
2. **`status: "ok" | "tenants_required"`** discriminator on `/login`.
3. **Tokenless `/token` rotation** — server-side rotation in Redis;
   `/token` returns only `{ expires_at }` and the SPA keeps the same
   opaque session-id bearer.
4. **Flat `/me`** shape (`{user_id, realm_id, tenant_id, role, email,
   display_name, expires_at}`).
5. **HTTP 412 MFA gate** with `code: mfa_required | mfa_registration_required`
   and an `mfa_challenge_token`.
6. **HTTP 412 session-limit gate** with `code: session_limit_reached`
   and a one-shot `revocation_token`.

The preset wires those into the SDK's adapter + gate machinery in one
import.

## Usage

```ts
import { createRealm } from "@realm-id/web";
import { realmidBffPreset } from "@realm-id/web-bff-realmid";

const realm = createRealm({
  baseUrl: "https://api.realmid.dev",
  ...realmidBffPreset(),
});

await realm.ready();

try {
  await realm.login({ method: "google", providerToken: idToken });
} catch (e) {
  if (e instanceof RealmError) {
    if (e.code === "tenants_required") {
      // realm.getState().pendingTenants is populated; show picker, then
      // realm.switchTenant(...)  → preset has switchTenant: null, so
      // the SDK calls /login again with tenantId.
    }
    if (e.code === "mfa_required") {
      // body.challengeToken / body.method
    }
    if (e.code === "session_limit_reached") {
      // body.revocationToken / body.sessions
    }
  }
}
```

## What the preset configures

| Field | Value |
|---|---|
| `adapters.login` | `{status, session_token, expires_at, user{id,email,display_name}, tenants[{id,role,display_name}]}` → canonical |
| `adapters.me` | flat snake_case → `{user, tenants:[{id:tenant_id, role}], currentTenantId, expiresAt}` |
| `adapters.token` | `{expires_at}` → tokenless rotation |
| `adapters.providers` | snake_case provider list → camelCase |
| `gates` | 412 `mfa_required`, `mfa_registration_required`, `session_limit_reached` |
| `endpoints.providers` | `/identity-providers` |
| `endpoints.switchTenant` | `null` (falls back to `/login` with `tenantId`) |
| `endpoints.mfaVerify` | `/auth/mfa/verify` |
| `refresh` | `{ tokenless: true, sendBearer: true }` |
| `clientTypeQueryParam` | `platform` (so `realm.providers({clientType:"web"})` → `?platform=web`) |

Any of these can be overridden by passing your own field after the spread:

```ts
createRealm({
  baseUrl: ...,
  ...realmidBffPreset(),
  endpoints: { ...realmidBffPreset().endpoints, mfaVerify: "/v2/mfa/verify" },
});
```

Or use the lower-level exports — `realmidBffAdapters`, `realmidBffGates`,
`realmidBffEndpoints` — if you want to mix and match.
