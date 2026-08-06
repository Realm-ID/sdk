# TODO — sdk/ (go · ts · java · web)

Open work only; shipped items live in `CHANGELOG.md` + `DECISIONS.md`.
`SPEC.md` is law — if a language SDK and the SPEC disagree, fix the SDK.

> **Reorg note (2026-07-21):** purged ~20 completed entries and regrouped by
> theme. See root `DECISIONS.md` 2026-07-21.

> **Validation sweep (2026-08-03):** every item re-checked against the tree.
> One is **done and removed** (the swagger `TransferOwnerRequest` schema — it now
> carries `owner_user_id`, `outgoing_owner_role`, `leave_entirely`,
> `new_owner_email` and `suspend_outgoing_owner`, plus the ADR-087 two-caller
> note, `issuer/docs/swagger.yaml:2253`). Everything else was confirmed still
> open by grep, evidence inlined. **One item got worse and is called out below:
> the Go `Version` const has drifted a third time and the drift is LIVE.**

> **Validation sweep (2026-07-28):** every item below was checked against the
> tree. Two were **done and are removed** — `admin.platforms.updateConfig`
> (a typed `RealmConfigPatch` surface has existed since web-admin 0.8.8,
> `web/packages/admin/src/platforms.ts:155`, with `getConfig` at `:142`), and
> "type the two ADR-078 provider-MFA keys" (`accept_provider_mfa` is in
> `web/packages/admin/src/types.ts`). The rest were confirmed still open by
> grep — the per-item evidence is inlined.

---

- [ ] **`StarterRole` union duplicates the issuer's `realmrole.StarterRoles`.**
  `@realm-id/web-admin` types starter roles as `"admin" | "viewer"` because the
  menu is closed server-side and an unknown name is a hard 400. But the issuer
  exposes no endpoint advertising the menu, so adding a template means editing
  the SDK union (and `ui/web/src/OnboardCreate.tsx`'s `STARTER_ROLE_OPTIONS`) in
  lockstep. If the menu ever grows beyond these two, add
  `GET /platforms/starter-roles` and drive both from it.
  *(Confirmed 2026-08-03: the issuer has `POST /platforms/{id}/starter-roles`
  (seed) and no GET advertising the menu — `internal/httpapi/routes.go:123`.)*

> **DONE 2026-08-05 — "Release script should assert the Go `Version` const
> matches the tag."** The third drift was live (`0.38.0` declared against tag
> `go/v0.44.0`). Fixed as this item specified — **the check, not the bump**:
> `.github/workflows/verify-go-release.yml` asserts the const equals the pushed
> `go/v*` tag (and is dispatchable against the newest existing tag at any time),
> the const now reads `0.44.0`, and the 31-line accreted doc comment was cut to
> the rule plus a pointer at the check — the prose was half the mechanism, since
> a declaration wearing that much narrative reads as maintained. Mutation-verified
> (fed `0.38.0` against tag `0.44.0`, it fails). **Stated tradeoff:** the check
> fires at TAG time, so it makes a bad publish loud rather than preventing it;
> because tags are immutable once the proxy has cached them, the remedy on red is
> the next patch version. Rationale in `DECISIONS.md` 2026-08-05.

- [ ] **`DECISIONS.md` needs an index and an archive split.** It is 1670+ lines
  with no per-entry index, so `head -50` cannot answer "what decisions exist?"
  and anything consulting it pays for the whole file. Per the `decision-log`
  skill: add a one-line-per-entry index under the H1, then move the oldest
  entries to `DECISIONS-ARCHIVE.md`, keeping them listed in the index. Archive,
  never delete — an archived file is still greppable in the working tree, a
  deleted one is not. *(Filed 2026-08-05 while adding the Go-version entry;
  `issuer/DECISIONS.md` is worth the same check.)*
- [ ] **Re-pack `@realm-id/web-admin` with the ADR-081 role fields + re-vendor
  into `ui/`.** `assignable_to` / `can_invite_roles` are typed in `@realm-id/sdk`
  as of ts 0.26.0, and web-admin re-exports `RoleObject` from it, so a repack
  carries them. Then `ui/web/src/roleAssignability.ts` can drop its local
  `AssignableRoleLike` and narrow to the SDK type. Bundle the same repack as the
  outstanding `device_name` re-vendor below — both are blocked on one release.
  **Confirmed open 2026-07-28:** `assignable_to` has 0 matches anywhere in
  `web/packages/admin/src`, so the re-export has not carried it.

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
  `X-Device-Name`, `:580` parses `device_name`). **Re-verified 2026-07-28: `ts/`
  now has it too** (`ts/src/auth.ts`) — so this narrows to **java + the
  re-vendor**. Still owed: (1) **java** — add `device_name` to the login request
  + session-list type (0 matches in `java/src/main`); (2) **re-vendor
  `@realm-id/web-admin`** — the source type has `device_name?`
  (`web/packages/admin/src/types.ts:110`) but the committed tarball in `ui/web`
  doesn't, so `ui/web/src/Settings/Sessions.tsx:12` augments it locally; repack
  per `sdk/CLAUDE.md` and drop the augmentation; (3) optional — show the device
  name on the `/device` approve page (needs a by-`user_code` lookup).
  ⚠️ **Still true at the vendored `0.8.18`** (re-verified 2026-08-03):
  `ui/web/src/Settings/Sessions.tsx:12` still carries
  `type SessionRow = ActiveSession & { device_name?: string }`, and its comment
  still points at this item. **Eight repacks** have now shipped since this was
  filed without picking the field up — the `sdk/CLAUDE.md` hoisting gotcha is the
  likely cause, so verify the field inside the TARBALL, not just in `types.ts`.
  (`0.8.18` proved the tarball check works: it was verified with `npm pack
  @realm-id/web-admin@0.8.18` before being called done.)

## ADR-056 deferred follow-ups

- [ ] **SDK distributed `WithLock` (Q2).** `go/token_manager.go:32` uses an
  in-process `sync.Mutex`; the BFF's `Store.AcquireRefreshLock`
  (`api/internal/session/store.go:286`, Redis SETNX) stays the authority. Make the
  SDK lock pluggable / BFF-backed.
*(Q4 encrypt-at-rest is done — ADR-060's AES-256-GCM seal in the BFF store. Q5
`X-User-Token` typed-path parity shipped 2026-08-02, ts `0.33.0` + java `0.32.0`
— purged 2026-08-03; the rationale, and the lesson about the wrong grep result
that stood in this file for a week, are in root `DECISIONS.md` and the root
`TODO.md` entry that owns the partner-comms half.)*

## HTTP surface not yet wrapped

- [ ] **`GET /platforms/{id}` — the by-id platform read (issuer `v0.87.0`, spec
  `0.24.0`).** Shipped 2026-08-06 and wrapped nowhere. It is the singular
  counterpart to `platforms.mine()` and returns the same row shape, so the wrapper
  is small; it is the read the CLI's `platforms describe` needs (ADR-085 §7 names
  that command as the destination for the key-hygiene aggregates).
  **Authorization is inherited from `/platforms/mine`**, including the
  `scope="platform"` branch — so an M2M platform key works, which is the whole
  point. A platform the caller cannot see returns `404`, never `403`: wrappers
  must not translate that into a "forbidden"-flavoured error, because the
  indistinguishability is deliberate (issuer `DECISIONS.md` 2026-08-06).
  The staff-side `GET /admin/platforms/{id}` stays OUT of the partner SDK, per
  the `/admin/*` rule below; it belongs in `@realm-id/web-admin`.
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

*(Empty. The `TransferOwnerRequest` schema backfill was verified done
2026-08-03 and removed.)*

