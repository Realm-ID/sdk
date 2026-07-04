# `sdk/web/` — RealmID browser SDK

A framework-agnostic TypeScript SDK that runs in the browser, talks
**only** to the partner's BFF, and handles login-config discovery, token
management, refresh dedupe, tenant switching, MFA, and multi-tab sync.

## Packages

| Package                       | Purpose                                                              | Version in repo |
|-------------------------------|----------------------------------------------------------------------|-----------------|
| `@realm-id/web`                | Core: transport, token mgmt, storage adapters, observable, multi-tab, MFA, `realm.fetch`, adapters, gates | 0.4.0 |
| `@realm-id/web-admin`          | Admin-UI SDK companion: tenants, roles, api keys, domains, platforms, notes, signing keys, BFF aggregates | 0.4.0 |
| `@realm-id/web-react`          | React provider + hooks (`useRealm`, `useUser`, `useTenant`)          | 0.4.0   |
| `@realm-id/web-firebase`       | Firebase Auth kickoff adapter (Google popup/redirect, email/password) | 0.4.0   |
| `@realm-id/web-google`         | Google Identity Services kickoff adapter (FedCM-aware, no Firebase)  | 0.4.0   |
| `@realm-id/web-bff-realmid`    | Adapters + gates for the realmid.dev reference BFF (`api.realmid.dev`) | 0.3.0 |

> **Release status (2026-06-03).** The `0.4.0` packages above are
> **UNRELEASED** — they are the versions in this monorepo, not what is on
> npm. The latest cut tag is **`web-v0.3.0`** (and `web-bff-realmid-v0.2.0`
> for the BFF preset), so npm currently serves the `0.3.x` line. Shipping
> `0.4.0` is a two-step human action that is **not** done here: (1) cut the
> matching git tags (`web-v0.4.0`, and `web-bff-realmid-v0.3.0` if that
> package is rolled forward), then (2) `npm publish` each package. Until
> both happen, treat `0.4.0` as `main`-only. The tag-cut + publish is
> tracked in `sdk/TODO.md`.

### BFF-fronted SPA combo

A partner SPA that authenticates **through its own BFF** (the canonical
browser topology — the browser never holds an API key and never calls
`auth.realmid.dev` directly) installs `@realm-id/web` plus exactly one
provider-kickoff adapter, and optionally the React bindings:

- **`@realm-id/web`** — required. Transport, token lifecycle, `realm.fetch`.
- **`@realm-id/web-firebase`** *(or `@realm-id/web-google`)** — the
  provider kickoff. Use `-firebase` when you already run Firebase Auth
  (Google popup/redirect + email/password); use `-google` for raw Google
  Identity Services (FedCM-aware, no Firebase dep). Pick one.
- **`@realm-id/web-react`** — optional. `RealmProvider` + hooks for React
  apps. Vanilla-JS apps skip it.
- **`@realm-id/web-bff-realmid`** — optional preset, only if the SPA points
  at the realmid.dev reference BFF (`api.realmid.dev`) (wires the canonical
  wire-shape adapters/gates so you don't hand-configure them).

`@realm-id/web-admin` is **not** part of the customer-facing SPA combo — it
is the separate admin-console SDK (see "Admin SDK" below).

## Quick start (vanilla JS)

```ts
import { createRealm, localStorageAdapter } from "@realm-id/web";
import { realmidBffPreset } from "@realm-id/web-bff-realmid";

const realm = createRealm({
  baseUrl: "https://api.partner.com",
  storage: localStorageAdapter(),  // optional; default is memoryStorage()
  ...realmidBffPreset(),
});
await realm.ready();

// 1. Load login configuration to render your sign-in UI.
const { providers, signupMode } = await realm.providers();

// 2. Run the provider flow yourself (or via @realm-id/web-google /
//    @realm-id/web-firebase) and post the resulting token.
const idToken = /* signInWithGoogle(...) */ "";
await realm.login({ method: "google", providerToken: idToken });

// 3. All subsequent API calls go through realm.fetch — auto auth +
//    refresh + 401-replay.
const res = await realm.fetch("/api/orders");
```

## Quick start (React)

```tsx
import { createRealm } from "@realm-id/web";
import { RealmProvider, useRealm, useUser } from "@realm-id/web-react";

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

### `@realm-id/web-google` (Google Identity Services, no Firebase)

```ts
import { createGoogleProvider } from "@realm-id/web-google";

const google = createGoogleProvider({ clientId: "…apps.googleusercontent.com" });

async function onClickSignInWithGoogle() {
  await google.loginWith(realm); // signs in + calls realm.login("google")
}
```

### `@realm-id/web-firebase` (Firebase Auth)

```ts
import { createFirebaseProvider } from "@realm-id/web-firebase";

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

Default storage key: `"@realm-id/web:session"`. Default storage:
`memoryStorage()` (no cross-reload persistence). Browser adapters are
SSR-safe and swallow quota / parse errors.

## Admin SDK

[`@realm-id/web-admin`](./packages/admin/README.md) is the companion
admin-UI SDK. It wraps `realm.fetch` with the resource clients from
`@realm-id/sdk` plus browser-only clients for routes the partner SDK
doesn't expose (`platforms`, `notes`, `signingKeys`, `bff`, `sessions`,
`me`).

```ts
import { createAdmin } from "@realm-id/web-admin";

const admin = createAdmin(realm, {
  baseUrl: "https://api.partner.com",
  realmId: "01HXYZ...",
});

const tenants = await admin.tenants.list();
const home = await admin.bff.home({ mode: "ops" });
```

### Why a separate admin package

Long-term plan: partners build customer-facing apps on `@realm-id/web`
and admin consoles on `@realm-id/web-admin`. Keeping them split means a
tenant-app bundle doesn't pull in the admin resource graph (and its
`@realm-id/sdk` dependency) just to log a user in.

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

[`BFF-SPEC.md`](./BFF-SPEC.md) is the canonical contract your BFF must
implement. realmid.dev runs a reference BFF at `api.realmid.dev`;
implement the contract directly in your existing backend.

If you target the realmid.dev BFF directly, use the
[`@realm-id/web-bff-realmid`](./packages/bff-realmid/README.md) preset:

```ts
import { createRealm } from "@realm-id/web";
import { realmidBffPreset } from "@realm-id/web-bff-realmid";

const realm = createRealm({
  baseUrl: "https://api.realmid.dev",
  ...realmidBffPreset(),
});
```
