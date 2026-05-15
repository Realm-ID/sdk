# @realmid/web

Browser SDK for RealmID. Talks only to the partner's BFF (per ADR-052),
holds the access bearer in memory, dedupes refresh-on-401, and exposes a
framework-agnostic `Realm` facade.

```ts
import { createRealm } from "@realmid/web";

const realm = createRealm({ baseUrl: "https://api.partner.com" });
await realm.ready();
await realm.login({ method: "google", providerToken });
const res = await realm.fetch("/api/orders");
```

## Persistence

`@realmid/web` survives a page reload out of the box for cookie-based
BFFs — the HttpOnly cookie travels on `/me` during `autoRestore`. For
BFFs that hand the SPA an opaque `session_token` in JSON instead, opt
into a `StorageAdapter` so the SDK can replay the bearer after reload.
Three built-ins are shipped: `memoryStorage()` (default; no
cross-reload), `localStorageAdapter(key?)`, and
`sessionStorageAdapter(key?)`. All browser adapters are SSR-safe and
swallow quota / parse errors so a corrupt entry can't brick the boot
path.

```ts
import { createRealm, localStorageAdapter } from "@realmid/web";

const realm = createRealm({
  baseUrl: "https://api.partner.com",
  storage: localStorageAdapter(),  // default key "@realmid/web:session"
});
```

The SDK writes on every successful `adopt`/`login`/`applyMe`/
`switchTenant` and clears on `logout` / session-lost. On construction
with `autoRestore: true`, a non-expired entry paints `authenticated`
synchronously, then `/me` revalidates in the background — a 401 there
drops back to anonymous and clears the entry.

## Admin companion

For admin-UI surfaces (tenants, roles, api keys, platforms, notes,
signing keys, BFF aggregates) use
[`@realmid/web-admin`](../admin/README.md). It wraps `realm.fetch` so
admin calls inherit Authorization-attach, refresh-on-401, and multi-tab
logout sync from this package.
