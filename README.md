# Realm ID — SDKs

Official SDKs for [Realm ID](https://realmid.dev) — covering **login,
refresh, MFA, verify, and management** (tenants, users, invitations,
domains, API keys). A partner application using a Realm ID SDK does not
need to call `auth.realmid.dev` directly for any of those.

This repository is a monorepo. Each subdirectory is an independent,
language-idiomatic SDK that implements the same locked specification
(see [`SPEC.md`](./SPEC.md)).

| Path | Status | Package | Runtime |
|------|--------|---------|---------|
| [`ts/`](./ts) | Released | `@realmid/sdk` (npm) | Node ≥ 20, Deno, Bun, Cloudflare Workers, modern browsers |
| [`go/`](./go) | Released | `github.com/Realm-ID/sdk/go` | Go ≥ 1.23 |
| [`java/`](./java) | Released | `dev.realmid:sdk` (Maven Central, planned) | Java ≥ 17 |
| `components/` | Planned | `@realmid/components` | React |

## Quick taste

```ts
import { createRealm } from "@realmid/sdk";

const realm = createRealm({
  realmId: process.env.REALM_ID!,
  apiKey:  process.env.REALMID_API_KEY!,
});

// One line. Mounts /login, /logout, /token, /mfa/verify and verifies
// the bearer access token on every other route.
app.use(realm.middleware({ exemptPaths: ["/health", "/public/*"] }));
```

> **Defense in depth:** your API key never travels over login traffic.
> The SDK exchanges it once for a short-lived platform JWT, then sends
> the JWT (not the key) on every subsequent call. See
> [`docs/dual-token.md`](./docs/dual-token.md).

## Documentation

- [`SPEC.md`](./SPEC.md) — the cross-language contract (authoritative)
- [`docs/quickstart.md`](./docs/quickstart.md) — runnable example in TS, Go, Java
- [`docs/dual-token.md`](./docs/dual-token.md) — how login keeps the API key out of high-traffic surfaces
- [`docs/error-reference.md`](./docs/error-reference.md) — every error code, when it fires, what to do
- [`docs/middleware.md`](./docs/middleware.md) — middleware behavior across all three languages
- [`CHANGELOG.md`](./CHANGELOG.md) — release history
- Marketing site: [realmid.dev/docs](https://realmid.dev/docs)
- Security model: [realmid.dev/security](https://realmid.dev/security)
- API reference (OpenAPI): [auth.realmid.dev/swagger.yaml](https://auth.realmid.dev/swagger.yaml)

## Why one repo

Pre-1.0, the API surface still moves: a new claim, a new error code, or
a new endpoint typically needs a coordinated change across every SDK.
One repo is one PR. Once each SDK has its own contributor flow and
release cadence, individual SDKs may move out to their own repos.

## Versioning

Each SDK ships independently. Tags are prefixed by language:

- `ts-v0.1.0`, `ts-v0.2.0`, …
- `go-v0.1.0`, …
- `java-v0.1.0`, …

CI picks the right subdirectory from the tag prefix.

## License

MIT — see [LICENSE](./LICENSE).
