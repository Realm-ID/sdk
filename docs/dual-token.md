# Dual-token login (defense in depth)

> Your API key never travels over login traffic.

This is a small but real security property. It is also the reason the
SDK requires `apiKey` at construction time even though "logging a user
in" feels like a public-facing operation.

## How it works

A naïve identity-provider SDK would attach the API key directly to
every call, including `/auth/login`. Login traffic is hot — every
unauthenticated user who touches the app produces a request to it. A
captured login trace (TLS terminator log, reverse proxy access log,
SIEM debug, intermediary logging in a partner's stack) carrying a raw
API key is a serious leak: the key is long-lived, scoped to the entire
realm, and grants every management operation.

The Realm ID SDK avoids that exposure by **never** sending the API
key with login traffic.

```
┌─────────┐                  ┌──────────────────────┐
│ Partner │  apiKey          │ POST /auth/login     │
│ SDK     ├─────────────────▶│ grant_type:          │
│         │ (sent ONCE per   │  platform_api_key    │
│         │  TTL, default    │ → platform JWT, 5m   │
│         │  5 min)          │   exp, token_class:  │
│         │                  │   platform           │
│         │                  └──────────────────────┘
│         │
│         │  platform JWT     ┌──────────────────────┐
│         ├─────────────────▶│ POST /auth/login     │
│         │  + provider token │ (user grant_type)    │
│         │  (Firebase / etc.)│ → user session       │
│         │                  └──────────────────────┘
│         │
│         │  platform JWT     ┌──────────────────────┐
│         ├─────────────────▶│ POST /tenants        │
│         │                   │ DELETE /users/...    │
│         │                   │ ... every other call │
│         └──────────────────────────────────────────┘
```

The platform JWT is:

- Signed with the **realm's signing key** — same key that signs user
  access tokens, so the same JWKS verifies both.
- Classed: the `token_class: "platform"` claim distinguishes it from
  user access tokens; the server's auth middleware enforces this on
  every management endpoint. (This marker rode the `scope` claim until
  ADR-097 gave that name to partner-supplied granted authority — read
  `token_class`, never `scope`, to classify a token.)
- Short-lived: default 5 minutes, configurable via
  `realms.config.platform_token_ttl_seconds` (max 15 min).
- Cached in-process by the SDK and re-minted automatically 30 s
  before its `exp`.

## What this buys you

| Threat                                            | Mitigation                                                                      |
|---------------------------------------------------|---------------------------------------------------------------------------------|
| Login-route trace captured by an attacker         | Captured platform JWT expires in ≤ 5 min; raw key is not present.               |
| API key leaks via partner-side request logging    | Logs of `/auth/login`, `/auth/token`, `/tenants/*` etc. show only platform JWT. |
| Partner mid-tier observability tool ingests bodies| Same — the high-traffic surface never sees the long-lived secret.               |
| Stolen platform JWT replayed                      | Replay window is bounded by TTL. The thief still needs a valid user provider token to mint a session, and cannot mint another platform JWT without the API key. |

This is **not** a substitute for revoking a leaked API key. If you
suspect compromise, revoke the key in the RealmID console; the SDK
will surface `unauthorized` from the next platform-token mint call
(`grant_type: "platform_api_key"` on `/auth/login`) onward.

## What you write

```ts
const realm = createRealm({
  realmId: "01HXYZREALM",
  apiKey: "rk_live_...",
});

// Behind the scenes the SDK mints a platform token, then logs the
// user in. Both legs happen within a single SDK call.
const session = await realm.auth.login({
  method: "firebase",
  providerToken: idToken,
});
```

The mint step is idempotent and cached. Calling `auth.login` 1000
times in 5 minutes results in **one** platform-token mint call, not
1000 — same for any management operation.

## Operational notes

- **Process lifetime caching only.** The platform token cache lives
  in memory inside the SDK handle. It is not written to disk. Restart
  your service and the next call mints a fresh one.
- **Per-handle.** If you hold multiple `Realm` handles (you usually
  shouldn't), each maintains its own cache. They do not share.
- **Clock skew.** The SDK refreshes 30 s before the server's stated
  expiry, so up to 30 s of clock skew is tolerated. Larger drift will
  cause sporadic 401s; sync your host clock.
- **No retry on platform-token mint failure.** A 5xx or network error
  on the mint call (`grant_type: "platform_api_key"` on `/auth/login`)
  surfaces as a `RealmError` immediately so
  callers can distinguish transient infra failure from auth failure.
- **Logged events** (when a `Logger` is configured): `info`-level
  "platform-token minted". Tokens themselves are redacted to a 6-char
  prefix. There is no "refreshed" event — ADR-089 removed the platform
  refresh token, so every acquisition is a fresh mint from the
  credential.
