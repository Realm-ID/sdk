# `sdk/web/` — RealmID browser SDK

Per [ADR-052][adr-052]: a framework-agnostic TypeScript SDK that runs in
the browser, talks **only** to the partner's BFF, and handles login-config
discovery, token management, refresh dedupe, tenant switching, MFA, and
multi-tab sync.

[adr-052]: ../../api/docs/adr/052-browser-sdk.md

## Packages

| Package                       | Purpose                                                              | Status   |
|-------------------------------|----------------------------------------------------------------------|----------|
| `@realmid/web`                | Core: transport, token mgmt, observable, multi-tab, MFA, `realm.fetch`, adapters, gates | v0.2.0 |
| `@realmid/web-react`          | React provider + hooks (`useRealm`, `useUser`, `useTenant`)          | v0.2.0   |
| `@realmid/web-firebase`       | Firebase Auth kickoff adapter (Google popup/redirect, email/password) | v0.2.0   |
| `@realmid/web-google`         | Google Identity Services kickoff adapter (FedCM-aware, no Firebase)  | v0.2.0   |
| `@realmid/web-bff-realmid`    | Adapters + gates for the realmid.dev reference BFF (`Realm-ID/bff-api`) | v0.1.0 |

## Quick start (vanilla JS)

```ts
import { createRealm } from "@realmid/web";

const realm = createRealm({ baseUrl: "https://api.partner.com" });
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

[`Realm-ID/bff-api`](https://github.com/Realm-ID/bff-api) is the canonical
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
