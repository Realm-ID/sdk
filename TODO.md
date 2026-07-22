# TODO — sdk/ (go · ts · java · web)

Open work only; shipped items live in `CHANGELOG.md` + `DECISIONS.md`.
`SPEC.md` is law — if a language SDK and the SPEC disagree, fix the SDK.

> **Reorg note (2026-07-21):** purged ~20 completed entries and regrouped by
> theme. See root `DECISIONS.md` 2026-07-21.

---

- [ ] **`StarterRole` union duplicates the issuer's `realmrole.StarterRoles`.**
  `@realm-id/web-admin` types starter roles as `"admin" | "viewer"` because the
  menu is closed server-side and an unknown name is a hard 400. But the issuer
  exposes no endpoint advertising the menu, so adding a template means editing
  the SDK union (and `ui/web/src/OnboardCreate.tsx`'s `STARTER_ROLE_OPTIONS`) in
  lockstep. If the menu ever grows beyond these two, add
  `GET /platforms/starter-roles` and drive both from it.

## Cross-language parity gaps

- [ ] **TS: BFF on-behalf-of parity** (`ts/src/auth.ts`). The TS current-user
  session/MFA methods (`revokeSession`, `listSessions`, `revokeAllSessions`,
  `enrollMfa`, `confirmMfa`, `disableMfa` — SPEC §4.5–4.10) accept only a direct
  `userBearer`; Go and Java also support BFF mode (`userId` + platform token +
  `X-On-Behalf-Of-User`). Add the on-behalf-of header path to the TS `HttpClient`
  and these methods.
- [ ] **Java: implement the ADR-041 client-side realm pin.** Go
  (`sessionManager.checkIssuer`) and TS (`platform-token-manager.checkIssuer`)
  decode the freshly-minted platform access token and raise `realm_mismatch` when
  its `iss` doesn't reference the configured realm. Java has the
  `ErrorCode.REALM_MISMATCH` constant (added for taxonomy parity) but performs no
  such pin in `PlatformTokenManager`.
- [ ] **Device-name (ADR-062) lockstep.** Go has it (`go/auth.go:248` sends
  `X-Device-Name`, `:580` parses `device_name`). Still owed: (1) **ts + java** —
  add `device_name` to the login request + session-list type (grep confirms 0
  matches in `ts/src`, `java/src/main`); (2) **re-vendor
  `@realm-id/web-admin`** — the source type has `device_name?`
  (`web/packages/admin/src/types.ts:110`) but the committed tarball in `ui/web`
  doesn't, so `ui/web/src/Settings/Sessions.tsx:12` augments it locally; repack
  per `sdk/CLAUDE.md` and drop the augmentation; (3) optional — show the device
  name on the `/device` approve page (needs a by-`user_code` lookup).

## ADR-056 deferred follow-ups

- [ ] **SDK distributed `WithLock` (Q2).** `go/token_manager.go:32` uses an
  in-process `sync.Mutex`; the BFF's `Store.AcquireRefreshLock`
  (`api/internal/session/store.go:286`, Redis SETNX) stays the authority. Make the
  SDK lock pluggable / BFF-backed.
- [ ] **TS/Java `X-User-Token` parity (Q5)** — absent in `ts/`, `java/`.
  *(Q4 encrypt-at-rest is done — ADR-060's AES-256-GCM seal in the BFF store.)*

## HTTP surface not yet wrapped

- [ ] Remaining partner-facing gaps (lower priority): `GET /me` caller identity;
  tenant domain delete (`DELETE /platforms/{pid}/tenants/{tid}/domains/{domain}`);
  realm origin bind/detach (`POST` / `DELETE /platforms/{id}/origins[/{id}]`).
  Operator/base-realm surfaces (platform create/rename, `/admin/*`
  suspend/rotate/notes) are intentionally out of the partner SDK.
- [ ] **`@realm-id/web` `completeSignIn` should recognize an OIDC *error* return**
  (`?error=&state=`, no `code`) — clean the URL and throw a typed `RealmError`
  instead of returning `null`. Today `ui/web/src/AuthGate.tsx` detects `?error=`
  itself (`humanizeOidcError`) because `readCallback` requires `code`; folding it
  into the SDK removes the app-side special case. Needs a version bump + a
  vendored-tarball re-pin in `ui/web`.

## `@realm-id/web-admin` gaps (the UI carries shims until these land)

Consolidated from `ui/TODO.md` — the UI-side shim locations are tracked there;
this is the SDK-side work.

- [ ] **Email-based ownership transfer.** `admin.tenants.transferOwner` accepts
  only a resolved `ownerUserId`; `OwnershipTransferDialog` needs an email variant
  the BFF resolves server-side. *Cross-check before building:* the ADR-076 handler
  already accepts a `new_owner_email` fallback — this may be a pure type/method
  addition rather than new behavior.
- [ ] **`admin.platforms.updateConfig`** (typed `RealmConfigPatch`) — no typed
  surface for the allowlisted realm-config keys; the UI keeps a hand-rolled
  `patchRealmConfig` shim. Pairs with the missing `GET /platforms/{id}/config`
  (root `TODO.md`).
- [ ] **`federationBindings` resource** — no client for the ADR-057 WIF CRUD
  (`GET/POST/DELETE /platforms/{id}/federation-bindings`); the UI carries
  `list/create/revokeFederationBinding` shims. Mirror `ApiKeysClient`. The `scope`
  field is currently free-text — tighten if a scope catalog is ever defined.
- [ ] **`RolesClient` is realmId-bound at construction.** A per-call `realmId`
  override would help cross-realm ops UIs. Not blocking today — the UI works
  around it with `useAdminForRealm(realmId)`, which returns a realm-scoped cached
  `Admin`.
- [ ] **`bff.home()` / `bff.tenantFull()` return loose `{ [k: string]: unknown }`.**
  Rich types live in `@realm-id/sdk/internal`; the aggregates package types need a
  refresh before the admin SDK can re-export them.
- [ ] **Type the two ADR-078 provider-MFA keys** (`accept_provider_mfa`,
  `provider_mfa_ttl_seconds`) into the vendored `web-admin` SDK — the UI currently
  types them via a local read-back extension.

## Web-package test infra

- [ ] **`web/packages/firebase/` + `web/packages/react/` are untested**
  (`google/` was backfilled 2026-06-03 with 12 tests). `firebase` statically
  imports `firebase/app` + `firebase/auth` at module top level, which
  `node --test` can't mock without a module-mock framework; `react` bindings are
  hooks needing jsdom + react-dom, neither configured in this monorepo. Needs a
  test-infra decision — add `vitest`/jsdom, or refactor firebase to inject its
  `signInWith*` seams — before either can be cleanly unit-tested.

## `ui/sdk-ts` — structural decision needed

- [ ] `ui/sdk-ts/` is described in `ui/CLAUDE.md` as a mirror of `sdk/ts/`, but is
  in practice a **minimal JWT-verifier shim** (`verifier.ts` + `admin.ts` types +
  `index.ts`) whose `verifier.ts` predates the `errors.ts` taxonomy. `ui/web` does
  **not** consume it at build time. Decide: either make it a full `sdk/ts` mirror
  (drag in errors/auth/http/realm/token-manager/api-keys — a structural rebuild,
  not a file copy) or narrow `ui/CLAUDE.md`'s "mirror / do not let them drift"
  wording to "verifier + admin types only." Also: its verifier tests are mildly
  flaky (1/8 intermittent, timing/JWKS-mock related).

## Docs

- [ ] `issuer/docs/swagger.yaml` — the `TransferOwnerRequest` schema is stale: it
  shows only `new_owner_email`, but the ADR-076 handler reads
  `{owner_user_id, outgoing_owner_role?, leave_entirely?}`
  (`issuer/internal/httpapi/tenants.go:924`). Backfill the schema.
