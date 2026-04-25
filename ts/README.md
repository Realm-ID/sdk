# @realmid/sdk

TypeScript SDK for verifying RealmID-issued JWTs. Sibling Go SDK lives at [`../go/`](../go) (planned).

Install:

```bash
npm install @realmid/sdk
```

## Usage

```ts
import { createVerifier } from "@realmid/sdk";

const verifier = createVerifier({
  baseUrl: "https://auth.realmid.dev",
  audience: "example.com",
});

try {
  const claims = await verifier.verify(accessToken);
  // claims.sub, claims.tenant_id, claims.role, ...
} catch (err) {
  // VerifyError with .code in {malformed, wrong_algorithm, bad_signature,
  // wrong_issuer, wrong_audience, expired, not_yet_valid, unknown_kid,
  // jwks_fetch_failed}
}
```

Uses the Web Crypto API (`globalThis.crypto.subtle`), so it runs in Node ≥ 20, Deno, Bun, Cloudflare Workers, and modern browsers.

## What's in scope

Just `verify()`. The planned Go SDK will cover the same ground for partner APIs written in Go. Other partner-facing methods (`authenticateUser`, `logout`, etc.) are not yet implemented — call the API directly with `fetch()` for those.

## Tests

```bash
npm install
npm test
npm run typecheck
```

## License

MIT — see the [LICENSE](../LICENSE) at the repo root.
