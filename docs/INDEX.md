# SDK Documentation Index

Read this before changing SDK docs or behavior. `../SPEC.md` is the
cross-language contract; these docs explain how to use and operate it.

## Start Here If...

| You need to... | Read |
|---|---|
| Learn the SDK contract | `../SPEC.md` |
| Build a first integration | `quickstart.md` |
| Understand dual-token auth | `dual-token.md` |
| Use middleware | `middleware.md` |
| Handle errors | `error-reference.md` |
| Understand management operations | `operations.md` |
| Plan a partner integration | `integration-guide.md` (SDK-shaped) |
| Understand the platform model, claims, RBAC, `scope` | `partner-integration-guide.md` (platform-shaped) |

## Canonical Sources

| Topic | Canonical source | Notes |
|---|---|---|
| SDK behavior | `../SPEC.md` | Language SDKs must conform. |
| HTTP paths and DTOs | `../../issuer/docs/swagger.yaml` | Server owns wire shape. |
| Error taxonomy | `error-reference.md`, `../SPEC.md` | Keep in sync. |
| Auth/BFF model | `dual-token.md`, ADR-041, ADR-050 | See API ADRs for server decisions. |

## Code Entrypoints

| Language | Entrypoint |
|---|---|
| TypeScript | `../ts/` |
| Go | `../go/` |
| Java | `../java/` |
| Contract | `../SPEC.md` |
| Changelog | `../CHANGELOG.md` |

## Doc Groups

| Group | Docs |
|---|---|
| Getting started | `quickstart.md`, `integration-guide.md`, `partner-integration-guide.md` |
| Auth and middleware | `dual-token.md`, `middleware.md` |
| Operations | `operations.md` |
| Errors | `error-reference.md` |

## Two integration guides, and which is which

`integration-guide.md` walks the SDK surface (bootstrap → backend → frontend →
operations). `partner-integration-guide.md` — moved here from the PRIVATE
`Realm-ID/issuer` repo on 2026-08-28, because partners could not read it there —
covers the platform model: JWT claims, your own RBAC, `permissions_cap` vs
`scope` (§4.1/§4.2), migration. **They overlap and are not yet reconciled**;
where they disagree, `../SPEC.md` wins. Tracked in `../TODO.md`.

## Historical Notes

If a language README and `../SPEC.md` disagree, update the README or
implementation. Do not use examples as contract when Swagger or SPEC has
newer behavior.
