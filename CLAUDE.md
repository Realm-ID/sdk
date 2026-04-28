# sdk/ — RealmID SDK monorepo

One locked spec, multiple language-idiomatic implementations.

| Path | Status | Package |
|---|---|---|
| `ts/` | Released | `@realmid/sdk` (npm) |
| `go/` | Released | `github.com/Realm-ID/sdk/go` |
| `java/` | Released | `dev.realmid:sdk` |
| `components/` | Planned | `@realmid/components` (React) |

## Authoritative docs

- **`SPEC.md`** — locked behavioral spec. All language SDKs must match.
- **`docs/dual-token.md`** — API key → platform JWT exchange model.
- **`docs/quickstart.md`, `integration-guide.md`, `middleware.md`,
  `operations.md`, `error-reference.md`** — partner-facing.

## Conventions

- **Spec is law** — if a language SDK and `SPEC.md` disagree, fix the
  SDK. If the spec needs to change, update `SPEC.md` first, then fan out.
- **Defense in depth** — API keys never travel on login traffic. SDKs
  exchange the key once for a short-lived platform JWT and send the JWT
  on every subsequent call. v0.4.0 SDK auto-attaches this.
- **Go SDK + GoFr hook quirk** — `check-gofr.sh` misfires on plain
  `context.Context` in SDK code. Workaround: import as
  `ctxpkg "context"` for new exported funcs.
- **Version bumping** — SPEC change → bump all language SDKs in lockstep
  with matching CHANGELOG entries.

## v0.4.0 (deployed 2026-04-27)

Auto-attaches platform JWT; ships optional revocation cache. New partner
realms default to `require_bff_login=true`. See ADR-041.

## Recent surface fixes (a partner handoff session)

`Tenants.Create`, `UpdateUserRole` were patched same session as the
handoff package. Treat those as freshly-stable.
