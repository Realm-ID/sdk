# `sdk/web/` — RealmID browser SDK

Per [ADR-052][adr-052]: a framework-agnostic TypeScript SDK that runs in
the browser, talks **only** to the partner's BFF, and handles login-config
discovery, token management, refresh dedupe, tenant switching, MFA, and
multi-tab sync.

[adr-052]: ../../issuer/docs/adr/052-browser-sdk.md

## Packages

| Package                       | Purpose                                                              | Status   |
|-------------------------------|----------------------------------------------------------------------|----------|
| `@realmid/web`                | Core: transport, token mgmt, storage adapters, observable, multi-tab, MFA, `realm.fetch`, adapters, gates | v0.4.0 |
| `@realmid/web-admin`          | Admin-UI SDK companion: tenants, roles, api keys, domains, platforms, notes, signing keys, BFF aggregates | v0.1.1 |
| `@realmid/web-react`          | React provider + hooks (`useRealm`, `useUser`, `useTenant`)          | v0.4.0   |
| `@realmid/web-firebase`       | Firebase Auth kickoff adapter (Google popup/redirect, email/password) | v0.4.0   |
| `@realmid/web-google`         | Google Identity Services kickoff adapter (FedCM-aware, no Firebase)  | v0.4.0   |
| `@realmid/web-bff-realmid`    | Adapters + gates for the realmid.dev reference BFF (`Realm-ID/api`) | v0.3.0 |

## Quick start (vanilla JS)

```ts
import { createRealm, localStorageAdapter } from "@realmid/web";
import { realmidBffPreset } from "@realmid/web-bff-realmid";

const realm = createRealm({
  baseUrl: "https://api.partner.com",
  storage: localStorageAdapter(),  // optional; default is memoryStorage()
  ...realmidBffPreset(),
});
await realm.ready();

// 1. Load login configuration to render your sign-in UI.
const { providers, signupMode } = await realm.providers();

// 2. Run the provider flow yourself (or via @realmid/web-google /
//    @realmid/web-firebase) and post the resulting token.
const idToken = /* signInWithGoogle(...) */ "";
await realm.login({ method: "google", providerToken: idToken });

// 3. All subsequent API calls go through realm.fetch — auto auth +
//    refresh + 401-replay.
const res = await realm.fetch("/api/orders");
```

## Quick start (React)

```tsx
import { createRealm } from "@realmid/web";
import { RealmProvider, useRealm, useUser } from "@realmid/web-react";

const realm = createRealm({ baseUrl: import.meta.env.VITE_BFF_URL });

function App() {
  return (
    <RealmProvider realm={realm}>
      <Routes />
    </RealmProvider>
  );
}

function ProfileBadge() {
  const { state, logout } = useRealm();
  const user = useUser();
  if (state.status === "loading") return null;
  if (state.status === "anonymous") return <a href="/login">Sign in</a>;
  return (
    <div>
      {user!.displayName} · <button onClick={logout}>Logout</button>
    </div>
  );
}
```

## Provider adapters

### `@realmid/web-google` (Google Identity Services, no Firebase)

```ts
import { createGoogleProvider } from "@realmid/web-google";

const google = createGoogleProvider({ clientId: "…apps.googleusercontent.com" });

async function onClickSignInWithGoogle() {
  await google.loginWith(realm); // signs in + calls realm.login("google")
}
```

### `@realmid/web-firebase` (Firebase Auth)

```ts
import { createFirebaseProvider } from "@realmid/web-firebase";

const fb = createFirebaseProvider({
  firebaseConfig: { apiKey, authDomain, projectId, appId },
  mode: "popup", // or "redirect" for in-app webviews
});

async function onClickSignInWithGoogle() {
  await fb.loginWithGoogle(realm);
}
```

For redirect mode, call `fb.completeRedirect(realm)` once on app boot.

## Auto-restore: cookie vs storage

Both refresh transports are first-class.

- **HttpOnly cookie**: if the BFF sets a refresh cookie on `/login`, the
  SDK's `autoRestore` (default on) calls `/me` with
  `credentials: "include"` on construction. The cookie travels; the SDK
  rehydrates from the response.
- **Storage adapter**: if you opt into a `StorageAdapter`
  (`localStorageAdapter()`, `sessionStorageAdapter()`, or a custom one),
  the SDK persists `{ accessToken, expiresAt, tenantId? }` on every
  successful `login`/`adopt`/`switchTenant`. On boot it adopts the
  stored session synchronously (paints `authenticated` without a network
  hop), then `/me` revalidates in the background. A 401 there drops back
  to anonymous and clears the entry.

Default storage key: `"@realmid/web:session"`. Default storage:
`memoryStorage()` (no cross-reload persistence). Browser adapters are
SSR-safe and swallow quota / parse errors.

## Admin SDK

[`@realmid/web-admin`](./packages/admin/README.md) is the companion
admin-UI SDK. It wraps `realm.fetch` with the resource clients from
`@realmid/sdk` plus browser-only clients for routes the partner SDK
doesn't expose (`platforms`, `notes`, `signingKeys`, `bff`, `sessions`,
`me`).

```ts
import { createAdmin } from "@realmid/web-admin";

const admin = createAdmin(realm, {
  baseUrl: "https://api.partner.com",
  realmId: "01HXYZ...",
});

const tenants = await admin.tenants.list();
const home = await admin.bff.home({ mode: "ops" });
```

### Why a separate admin package

Long-term plan: partners build customer-facing apps on `@realmid/web`
and admin consoles on `@realmid/web-admin`. Keeping them split means a
tenant-app bundle doesn't pull in the admin resource graph (and its
`@realmid/sdk` dependency) just to log a user in.

## Configuration

```ts
createRealm({
  baseUrl: "https://api.partner.com",       // required
  endpoints: { login: "/api/v2/sign-in" },  // per-route overrides (optional)
  refreshSkewMs: 60_000,                    // proactive refresh window
  autoRestore: true,                        // call /me on construction
  channelName: "myapp:auth",                // multi-tab channel
  fetch: globalThis.fetch,                  // override transport (tests/SSR)
});
```

## How tokens flow

1. Browser SPA calls `POST /login` on the partner's BFF with a provider
   token.
2. BFF calls `auth.realmid.dev` via the Node SDK, mints the user JWT and
   refresh token.
3. BFF sets the refresh token in an **httpOnly cookie** on the partner's
   domain, returns the access JWT in the JSON response.
4. SDK holds the access JWT in memory only. Never `localStorage`.
5. ~60s before expiry, SDK calls `POST /token` on the BFF — the cookie
   travels automatically; BFF rotates and returns a new access JWT.
6. On 401 from any `realm.fetch` call, SDK refreshes once and replays
   the request. Concurrent calls share one refresh.

## Multi-tab

When tab A logs in, logs out, or switches tenants, tab B sees an
`onAuthChange` event in <50 ms via `BroadcastChannel` (or the
`storage`-event fallback for older Safari).

## Out of scope (v1)

- Native mobile (Swift / Kotlin / React Native) — separate product.
- Vue / Svelte / Solid framework adapters.
- Axios / TanStack Query first-party adapters (wrap `realm.fetch` in 5
  lines).
- Microsoft / Apple / Facebook provider adapters.
- Login-screen UI components (your visual layer; SDK gives you the data).

## Tests

```bash
cd packages/core && npm test     # 9 tests, ~150ms
```

## Adapters and gates (v0.2)

If your BFF doesn't ship the canonical wire shape pinned in
[`BFF-SPEC.md`](./BFF-SPEC.md) — different casing, status discriminators,
tokenless rotation, 412 gates, etc. — plug in `adapters` and `gates`
instead of forking the SDK or rewriting your backend:

```ts
createRealm({
  baseUrl: ...,
  adapters: { login, me, token, providers },          // raw → canonical
  gates: [{ status: 412, code: "mfa_required", gate: "mfa_required", extract }],
  refresh: { tokenless: true, sendBearer: true },     // tokenless rotation
  csrf: { headerName: "X-CSRF-Token", cookieName: "csrf_token" },
  endpoints: { switchTenant: null /* fall back to /login with tenantId */ },
});
```

Full reference: [BFF-SPEC.md → Response adapters](./BFF-SPEC.md#response-adapters).

## Reference BFF

[`Realm-ID/api`](https://github.com/Realm-ID/api) is the canonical
implementation of [`BFF-SPEC.md`](./BFF-SPEC.md). Fork it, or implement
the contract directly in your existing backend.

If you target the realmid.dev BFF directly, use the
[`@realmid/web-bff-realmid`](./packages/bff-realmid/README.md) preset:

```ts
import { createRealm } from "@realmid/web";
import { realmidBffPreset } from "@realmid/web-bff-realmid";

const realm = createRealm({
  baseUrl: "https://api.realmid.dev",
  ...realmidBffPreset(),
});
```
