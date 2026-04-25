# @realmid/sdk

Partner SDK for [Realm ID](https://realmid.dev) — covers **login,
refresh, MFA, verify, and management** (tenants, users, invitations,
domains, platform admin, API keys). Stdlib-only: uses `globalThis.fetch`
and Web Crypto, runs in Node ≥ 20, Deno, Bun, Cloudflare Workers, and
modern browsers.

Sibling SDKs at [`../go/`](../go) and [`../java/`](../java) (planned) follow the same spec.

```bash
npm install @realmid/sdk
```

## Quick start

```ts
import { createRealm } from "@realmid/sdk";

const realm = createRealm({
  realmId: "01HXYZREALM...",
  apiKey: "rk_live_...", // optional; required for management calls
});

// Verify an access token issued by auth.realmid.dev.
const claims = await realm.verify(accessToken);

// Exchange a Firebase ID token for a realm session.
const session = await realm.auth.login({
  method: "firebase",
  providerToken: idToken,
});

// Iterate tenants — each list call is a paginated AsyncIterable.
for await (const tenant of realm.tenants.list()) {
  console.log(tenant.id);
}
```

## Express middleware

The SDK ships a Connect-style middleware that handles `/login`,
`/logout`, `/token` (refresh), and `/mfa/verify` end-to-end, and
verifies bearer tokens on every other route. Mount it once and forget.

```ts
import express from "express";
import { createRealm } from "@realmid/sdk";

const realm = createRealm({ realmId: process.env.REALM_ID! });
const app = express();

app.use(express.json());
app.use(realm.middleware({
  exemptPaths: ["/health", "/public/*"],
}));

app.get("/me", (req, res) => {
  // Verified claims attached by the SDK.
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
import { RealmError } from "@realmid/sdk";

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
- `realm.auth.{login, token, mfaVerify, logout, listSessions, revokeSession}`
- `realm.tenants.{list, get, create, update, updateConfig, delete, transferOwner}`
- `realm.tenants.invitations.{list, create, delete}`
- `realm.tenants.users.{list, get, updateStatus, enrollMfa, confirmMfa, resetMfa}`
- `realm.domains.{claim, verify}`
- `realm.platforms.{list, mine, create, tenants.{list, create}, tenants.invitations.create}`
- `realm.realm.{info, apiKeys.{create, list, revoke}}`
- `realm.middleware(cfg?)` — Connect/Express-compatible auth middleware.

A low-level `createVerifier()` is also exported for callers that only
need JWT verification with no management API.

## Tests

```bash
npm install
npm run build
npm test
```

## License

MIT — see the [LICENSE](../LICENSE) at the repo root.
