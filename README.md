# Realm ID — SDKs

Official SDKs for verifying tokens minted by [Realm ID](https://realmid.dev).

This repository is a monorepo. Each subdirectory is an independent,
language-idiomatic SDK that targets the same API surface
(`https://auth.realmid.dev`).

| Path | Status | Package | Runtime |
|------|--------|---------|---------|
| [`ts/`](./ts) | Released | `@realmid/sdk` (npm) | Node ≥ 20, Deno, Bun, Cloudflare Workers, modern browsers |
| `go/` | Planned | `github.com/Realm-ID/sdk/go` | Go ≥ 1.22 |
| `components/` | Planned | `@realmid/components` | React |

## Why one repo

Pre-1.0, the API surface still moves: a new claim, a new error code, or a
new endpoint typically needs a coordinated change across every SDK. One
repo is one PR. Once each SDK has its own contributor flow and release
cadence, individual SDKs may move out to their own repos.

## Versioning

Each SDK ships independently. Tags are prefixed by language:

- `ts-v0.1.0`, `ts-v0.2.0`, …
- `go-v0.1.0`, …

CI picks the right subdirectory from the tag prefix.

## Documentation

- Integration guide: [realmid.dev/docs](https://realmid.dev/docs)
- Security model: [realmid.dev/security](https://realmid.dev/security)
- API reference (OpenAPI): [auth.realmid.dev/swagger.yaml](https://auth.realmid.dev/swagger.yaml)

## License

MIT — see [LICENSE](./LICENSE).
