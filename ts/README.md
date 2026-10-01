# @realm-id/sdk

Partner SDK for [Realm ID](https://realmid.dev) — covers **login,
refresh, MFA, verify, and management** (tenants, users, invitations,
domains, API keys). Stdlib-only: uses `globalThis.fetch` and Web Crypto,
runs in Node ≥ 20, Deno, Bun, Cloudflare Workers, and modern browsers.

Sibling SDKs at [`../go/`](../go) and [`../java/`](../java) follow the same spec.

```bash
npm install @realm-id/sdk
```

## Quick start

```ts
import { createRealm, createMemorySessionStore } from "@realm-id/sdk";

const realm = createRealm({
  realmId: "01HXYZREALM...",
  apiKey: "rk_live_...", // required — used by every operation, including login
  sessionStore: createMemorySessionStore(), // required since 0.63.0 — see below
});

// Verify an access token issued by auth.realmid.dev.
const claims = await realm.verify(accessToken);

// Exchange a Firebase ID token for a realm session.
// Internally: SDK mints a short-lived platform token, then calls /auth/login
// with that — your raw API key never crosses login traffic (SPEC §4.0).
const session = await realm.auth.login({
  method: "firebase",
  providerToken: idToken,
});

// Iterate tenants — each list call is a paginated AsyncIterable.
for await (const tenant of realm.tenants.list()) {
  console.log(tenant.id);
}
```

## Upgrading to 0.63.0 — breaking changes

- **`sessionStore` is REQUIRED** (SPEC §6.7.5). `createRealm` throws
  `RealmError` code `invalid_config` without one. Pass
  `createMemorySessionStore()` for a single replica; with several replicas pass
  a shared store (Redis, a database) implementing `SessionStateStore`, because
  per-replica memory serializes nothing. `sessionStoreConformance(factory)` runs
  your store through the same atomicity/lifetime cases the in-memory one passes.
- **`TokensClient` is async.** `markRevoked`, `isRevoked`, `gateRequest`,
  `revokeOnLogout` and `evict` now return Promises (the store may be remote);
  `await` them. They are keyed on the session (`sid`, falling back to `jti`), so
  a revoke covers every access token of the session. New: `revokeSession(key)`,
  `recordRefresh(token)`. `size()` is gone.
- **`/x/**` matches the bare `/x`** in `exemptPaths`, `mfaProtectedPaths` and
  `ScopeRule` paths. An `exemptPaths` entry `/x/**` now also exempts `/x`.
  `{name}` (one non-empty segment) works in `mfaProtectedPaths` and scope
  rules; `exemptPaths` keeps braces literal.
- **`ScopeDecision.missing`** is the rule's full scope list on an `anyOf`
  denial (it was empty). New optional `writeDenied` hook shapes the scope 403;
  unset, the 403 is byte-identical.
- **`verify()` is stricter:** blank/absent `sub`, a header `typ` outside
  `JWT`/`at+jwt`/`application/at+jwt`, and any `events` claim are `malformed`.
- **The middleware** now refuses revoked/superseded tokens itself (401 +
  `revoked: true`), serializes refreshes per refresh token, revokes the session
  named by the issuer on logout, and adds `org_session_mode` to the login,
  refresh and MFA-verify bodies. `Config.revocation` is keyed on the session.
- Upgrade `@realm-id/web` first, then this SDK (SPEC front matter, "Upgrade order").

## Express middleware

The SDK ships a Connect-style middleware that handles `/login`,
`/logout`, `/token` (refresh), and `/mfa/verify` end-to-end, and
verifies bearer tokens on every other route. Mount it once and forget.

```ts
import express from "express";
import { createRealm } from "@realm-id/sdk";

const realm = createRealm({
  realmId: process.env.REALM_ID!,
  apiKey: process.env.REALM_API_KEY!,
  logger: console, // satisfies the Logger interface; pino/bunyan also work
});
const app = express();

app.use(express.json());
app.use(realm.middleware({
  exemptPaths: ["/health", "/public/*"],
  mfaProtectedPaths: ["/admin/*"],
  tokenDelivery: "cookie", // or "body" for native / mobile clients
}));
// In "cookie" mode (default) the middleware sets the refresh token as
// HttpOnly; Secure; SameSite=Lax — browser JS never sees it, so XSS
// can't exfiltrate the refresh credential. Use "body" only when a
// cookie isn't viable (native apps, CLIs, truly cross-origin SPAs);
// see SPEC §10.2 for the full decision table.

app.get("/me", (req, res) => {
  res.json({ claims: (req as any).realmid });
});

app.listen(3000);
```

A full runnable example lives under
[`examples/express-app/`](./examples/express-app).

## Errors

Every SDK failure throws a single `RealmError` carrying a stable
`code` (e.g. `"mfa_required"`, `"unauthorized"`, `"wrong_audience"`).
When the server returns a 412 envelope with siblings (such as
`mfa_challenge_token`), they appear on `error.details`:

```ts
import { RealmError } from "@realm-id/sdk";

try {
  await realm.auth.login({ method: "firebase", providerToken });
} catch (err) {
  if (err instanceof RealmError && err.code === "mfa_required") {
    const challenge = err.details?.mfa_challenge_token;
    // ...prompt for TOTP, then realm.auth.mfaVerify({ challengeToken: challenge, code })
  }
}
```

## Surface (cross-language spec)

The full contract is in [`../SPEC.md`](../SPEC.md). Summary:

- `realm.verify(token, opts?)` — verify a Realm-issued JWT.
- `realm.auth.{login, token, mfaVerify, selfEnrollMfa, disableMfa, logout, listSessions, revokeSession, revokeAllSessions, mintMfaChallenge}`
- `realm.tenants.{list, get, create, update, updateConfig, delete, transferOwner, updateUserRole}`
- `realm.tenants.invitations.{list, create, delete}`
- `realm.tenants.users.{list, get, updateStatus, enrollMfa, confirmMfa, resetMfa}`
- `realm.domains.{claim, verify}`
- `realm.info()` — cached realm metadata (audience, etc.).
- `realm.apiKeys.{create, list, revoke}` — manage realm API keys.
- `realm.config.update(patch)` — patch realm-level config.
- `realm.middleware(cfg?)` — Connect/Express-compatible auth middleware.

A low-level `createVerifier()` is also exported for callers that only
need JWT verification with no management API.

## Tests

```bash
npm install
npm run build
npm test
```

To run them in a container instead, use the repo script — **not** a bare
`docker run -v "$(pwd)":/w`:

```bash
../scripts/npm-in-docker.sh ts test
```

An unshadowed bind mount lets the container's `npm ci` install **linux**
binaries over your host `node_modules`, after which a host `npm test` dies on
"You installed esbuild for another platform". The script shadows
`node_modules` with a per-package named volume so the two trees stay separate.
See `DECISIONS.md`, 2026-08-25.

## License

MIT — see the [LICENSE](../LICENSE) at the repo root.
