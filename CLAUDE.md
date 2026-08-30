# sdk/ — RealmID SDK monorepo

One locked spec, multiple language-idiomatic implementations.

| Path | Status | Package |
|---|---|---|
| `ts/` | Released | `@realm-id/sdk` (npm) |
| `go/` | Released | `github.com/Realm-ID/sdk/go` |
| `java/` | Released | `dev.realmid:sdk` |
| `web/packages/core/` | Released | `@realm-id/web@0.4.5` (tenant-app browser SDK) |
| `web/packages/admin/` | Released | `@realm-id/web-admin@0.8.5` (admin-UI browser SDK) |
| `web/packages/react/` | Released | `@realm-id/web-react@0.4.0` |
| `web/packages/firebase/` | Released | `@realm-id/web-firebase@0.4.0` |
| `web/packages/google/` | Released | `@realm-id/web-google@0.4.0` |
| `web/packages/bff-realmid/` | Released | `@realm-id/web-bff-realmid@0.3.6` |
| `components/` | Planned | `@realm-id/components` (React) |

> Version pins above drift; the per-package `package.json` + git tags +
> `CHANGELOG.md` are the source of truth for the current release.

## Authoritative docs

- **`SPEC.md`** — locked behavioral spec. All language SDKs must match.
- **`docs/dual-token.md`** — API key → platform JWT exchange model.
- **`docs/quickstart.md`, `integration-guide.md`,
  `partner-integration-guide.md`, `middleware.md`, `operations.md`,
  `error-reference.md`** — partner-facing.
- **`docs/partner-integration-guide.md` moved here from the PRIVATE
  `Realm-ID/issuer` repo on 2026-08-28.** This repo is public and that one is
  not, so the page answering partners' most common question (where the `scope`
  claim comes from, §4.2) was unreachable to every partner until an integrator
  said so. `issuer/docs/` keeps a pointer stub — **never restore a second copy
  there.** It overlaps `integration-guide.md` and the two are not yet
  reconciled; `SPEC.md` wins where they disagree.

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
- **Cutting a release tag — `git tag -a`, always. Enforced for all three.**
  `ts-v*` and `java-v*` are checked BEFORE their publisher runs, so a
  lightweight tag there is still fixable: delete it and re-cut it annotated,
  because npm/Maven have not seen the artifact yet. `go/v*` is different and the
  gate says so — see below.
- **`go/v*` specifically — never re-point, and bump before you merge.**
  `go/vX.Y.Z` is not a label on the Go release, it *is* the release: the module
  proxy serves the tag directly. So a tag is immutable the moment anything
  fetches it, and `.github/workflows/verify-go-release.yml` now fails a
  lightweight tag and a re-pointed one (`scripts/tag-hygiene.sh`). **Both fire
  after the tag exists and neither has a remedy** — the only recovery is the
  next patch version, so the procedure is what prevents them:
  `git tag -a go/v0.45.0 -m "go sdk 0.45.0" && git push origin go/v0.45.0`.
  22 of the first 41 `go/v*` tags were lightweight, the three most recent
  included, which is what the rule was worth while only a comment carried it.
  CI also refuses a `go/` change once its declared `const Version` is already
  tagged (`tag-hygiene.sh unreleased-go`, in the CI Go job): after a release,
  the first PR touching `go/` must bump the const. That is the one check that
  PREVENTS — the tag-time ones can only report, because by then the tag is
  immutable.
- **Two-SDK browser split** — `@realm-id/web` is the tenant-app SDK
  (auth, storage, multi-tab, operation step-up, membership self-service);
  `@realm-id/web-admin` is the admin-UI SDK (tenants, users, roles, platforms,
  SSO domains, federation bindings, signing keys, BFF aggregates). `web-admin`
  declares `@realm-id/web` as a peer dependency and bundles `@realm-id/sdk`
  (via `bundledDependencies`) so its resource classes are pinned to the version
  it was packed against.
- **`@realm-id/web` takes ZERO runtime dependencies.** Policy, like `sdk/go`'s.
  Where it must share a contract `@realm-id/sdk` owns (the GoFr envelope, the
  ADR-092 membership codes) it carries an identical implementation held in place
  by a PARITY TEST — `@realm-id/sdk` is a devDependency for exactly that. Never
  add a plain copy; either dogfood the sdk or add the parity test.
- **`@realm-id/web-admin/internal` is the staff-only subpath.** A surface gated
  on base-realm staff (`/admin/…`) can only ever `403` for the partners this
  package is published for, so it does not belong on the root entry point. Put
  it behind `internal.ts` / `createOpsAdmin` and give it no stability promise.
  The ADR-048 aggregates are the deliberate exception — SPEC §7.5 names them —
  and the partner docs must say staff-only.
- **Repack gotcha (`web-admin`)** — workspace-root `npm install`
  hoists `@realm-id/sdk` out of
  `sdk/web/packages/admin/node_modules/@realm-id/sdk/`. Before
  `npm pack` in that package, manually copy `sdk/ts/` (with a fresh
  `dist/`) into `packages/admin/node_modules/@realm-id/sdk/` so the
  tarball actually carries the bundled dep. This bites every
  release.

## v0.4.0 (deployed 2026-04-27)

Auto-attaches platform JWT; ships optional revocation cache. New partner
realms default to `require_bff_login=true`. See ADR-041.

## Recent surface fixes (partner handoff session)

`Tenants.Create`, `UpdateUserRole` were patched same session as a
partner handoff package. Treat those as freshly-stable.
