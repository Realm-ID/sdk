# RealmID SDK Index

Official TypeScript, Go, and Java SDKs for RealmID. The SDKs implement
one cross-language contract: `SPEC.md`.

## Start Here If...

| You need to... | Start with |
|---|---|
| Understand SDK behavior | `SPEC.md` |
| Use the SDK quickly | `docs/quickstart.md` |
| Understand platform-token/BFF auth | `docs/dual-token.md` |
| Add or compare language behavior | `ts/`, `go/`, `java/` plus `SPEC.md` |
| Debug errors | `docs/error-reference.md` |
| Work on middleware | `docs/middleware.md` |

## Canonical Sources

| Topic | Canonical source | Notes |
|---|---|---|
| Cross-language contract | `SPEC.md` | Highest authority inside this repo. |
| HTTP wire contract | `../issuer/docs/swagger.yaml` | Server contract owns paths and DTOs. |
| TypeScript implementation | `ts/README.md`, `ts/` | Canonical reference style for SDK behavior. |
| Go implementation | `go/README.md`, `go/` | Idiomatic Go mirror. |
| Java implementation | `java/README.md`, `java/` | Idiomatic Java mirror. |
| SDK docs index | `docs/INDEX.md` | Guide to supporting docs. |

## Code Entrypoints

| Area | Entrypoint |
|---|---|
| TypeScript package | `ts/` |
| Go package | `go/` |
| Java package | `java/` |
| Cross-language tests/docs | `SPEC.md`, `docs/` |
| Release history | `CHANGELOG.md` |

## Packages

| Path | Status | Package | Runtime |
|---|---|---|---|
| `ts/` | Released | `@realm-id/sdk` | Node 20+, Deno, Bun, Workers, modern browsers |
| `go/` | Released | `github.com/Realm-ID/sdk/go` | Go 1.23+ |
| `java/` | Released | `dev.realmid:sdk` | Java 17+ |
| `components/` | Planned | `@realm-id/components` | React |

## Quick Taste

```ts
import { createRealm } from "@realm-id/sdk";

const realm = createRealm({
  realmId: process.env.REALM_ID!,
  apiKey: process.env.REALMID_API_KEY!,
});

app.use(realm.middleware({ exemptPaths: ["/health", "/public/*"] }));
```

## Historical And Proposal Docs

The SDK contract follows `SPEC.md` and the server Swagger. Older README
examples or proposal docs must be updated when they disagree with those
two sources.
