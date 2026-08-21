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

- [ ] **`platform_not_found` is not in the `ErrorCode` taxonomy (all three
  languages).** The issuer returns it on `GET /platforms/{id}`,
  `GET /admin/platforms/{id}`, `PATCH /platforms/{id}` and others, but it is
  absent from `ts/src/errors.ts`'s `KNOWN_CODES`, from `go/errors.go`, and from
  the Java taxonomy — so `mapErrorResponse` falls back to `statusToCode(404)` and
  every caller sees the generic `not_found`. Consistent across the three SDKs, so
  no language is the outlier; that is why it reads as intentional and may be.
  **Decide, don't drift:** either add it in lockstep (a SPEC change + three bumps)
  or document that platform-scoped 404s normalize deliberately. **The upgrade
  hazard if it is added:** any consumer today catching `not_found` on a platform
  route silently stops matching, so it is behaviour-breaking despite being purely
  additive to a union. Filed 2026-08-06 while wrapping the by-id reads, where the
  first draft of the test asserted the specific code and failed.
  *(Whatever is decided, the 404 must stay indistinguishable between "not yours"
  and "never existed" — that is a security property, not a taxonomy question.)*
- [ ] **`java/CHANGELOG.md` has no `java-v0.34.0` entry** (noticed 2026-08-21
  while adding `0.35.0`: `build.gradle.kts` was on `0.34.0` and the file jumped
  from `0.33.0` to it). Same class as the item below — backfill from the
  version-bump commit.
- [ ] **`ts/CHANGELOG.md` is missing `0.29.0`–`0.35.0`** — seven released
  versions with no entries; the file jumps `0.28.0` → `0.36.0`. Backfill from the
  version-bump commits, as the `web-admin` `0.8.13`–`0.8.17` gap was on
  2026-08-03. **Same failure mode, second package**, which makes it a process
  gap rather than an oversight: nothing fails when a release skips its changelog,
  so it only surfaces when someone happens to read the file. Worth a check in the
  publish workflow — assert the version being published has a matching `## `
  heading, the same shape as the Go `Version`-const check added 2026-08-05.
  *(Filed 2026-08-06 while adding the `0.36.0` entry; a gap notice now sits at the
  top of that file so a reader isn't misled in the meantime.)*
- [ ] **`DECISIONS.md` needs an index and an archive split.** It is 1670+ lines
  with no per-entry index, so `head -50` cannot answer "what decisions exist?"
  and anything consulting it pays for the whole file. Per the `decision-log`
  skill: add a one-line-per-entry index under the H1, then move the oldest
  entries to `DECISIONS-ARCHIVE.md`, keeping them listed in the index. Archive,
  never delete — an archived file is still greppable in the working tree, a
  deleted one is not. *(Filed 2026-08-05 while adding the Go-version entry;
  `issuer/DECISIONS.md` is worth the same check.)*
> **DONE 2026-08-06 — the ADR-081 role fields were NEVER actually missing, and
> the diagnosis in this item was wrong.** `assignable_to` / `can_invite_roles`
> ship on `RoleObject` in the tarball's bundled `@realm-id/sdk` and have for
> some time; the vendored `0.8.18` was verified to carry them. The "0 matches in
> `web/packages/admin/src`" evidence recorded on 2026-07-28 was **a correct grep
> supporting a false conclusion**: web-admin re-exports `RoleObject` from
> `@realm-id/sdk/internal`, so the fields were never expected to appear in
> web-admin's own source, and their absence there proved nothing. No repack was
> needed at any point.
>
> The real remaining work was UI-side and is now done: `RealmRoles.tsx` carried
> five `r as AssignableRoleLike` casts over values already typed `RoleObject`.
> Those are deleted. **The casts, not the missing fields, were the defect** — a
> structural `as` over an SDK type silences exactly the drift the type exists to
> report, so they would have gone on passing had the fields genuinely never
> arrived. `AssignableRoleLike` survives as the pure predicate's deliberately
> tolerant input contract in `roleAssignability.ts` (it must still accept an
> older issuer's response omitting `assignable_to`), but no caller casts to it.
>
> **The lesson is the verification method, not the fields:** this item sat open
> across eight repacks because it was re-checked by grepping SOURCE. Check the
> packed tarball — `npm pack <pkg>@<version>` — which is what finally settled it.

## Cross-language parity gaps

> **An SDK↔issuer E2E suite now exists: `tests/sdk-e2e/` in the umbrella repo**
> (2026-08-21). TS + Java halves, run in-network against the seeded stack under
> compose profile `sdk-e2e`. **Its first run found two defects no unit suite
> could see**, both the same shape — the fixture agreed with the client while
> both disagreed with the server:
> - ts `listSessions` returned `[]` against every real issuer (decoded
>   `{sessions}`, the wire is `{items,next_cursor,total}`). FIXED in ts `0.37.0`.
> - a device label with a control character never reached the server in ANY SDK;
>   the transport refuses such a header value. FIXED in go `0.45.0` / ts
>   `0.37.0` / java `0.35.0`.
>
> **Add any new parity check to the E2E suite too, not only to the unit suites.**
> A parity claim verified only against a fake server is a claim about the SDK's
> own beliefs.

- [x] ~~**TS `listSessions` returns the FIRST PAGE only.**~~ **DONE 2026-08-21,
  ts `0.37.0` — BREAKING.** Now returns `Paginated<SessionInfo>` and follows
  `next_cursor`. All three languages page as of go `0.45.0` / ts `0.37.0` /
  java `0.35.0`; SPEC §4.6 updated, since it documented the divergence as a
  standing carve-out.
  **The deciding argument was internal consistency, not cross-language
  tidiness**: `Paginated<T>` is already exported TS public API and already what
  `federationBindings.list()` returns, so the bare array was the odd one out
  *inside the TS SDK itself*. Two non-breaking options were weighed and
  rejected — looping internally behind the array signature (unbounded, no early
  stop, keeps the SPEC §7 carve-out) and adding a second paged method (leaves
  the truncating call as the default one everybody reaches for). A compile
  error with an obvious fix beats the same call quietly returning a different
  row count.
  **Verified against a REAL issuer**, not only a fixture: the new e2e case
  drives the issuer's own `pagedSlice` with `limit: 1` so two sessions force a
  second page, and asserts as a PRECONDITION that the server emits
  `next_cursor` at all. Mutation-verified three ways. Also fixed on the same
  lines: `docs/integration-guide.md` §4.5 showed the old array call AND read
  `s.createdAt`/`s.lastUsedAt`, fields TS has never returned.
  Rationale: `DECISIONS.md` 2026-08-21 (latest).
- [x] ~~**`gofmt -l` reports FOUR files**~~ — **DONE 2026-08-21, formatted AND
  gated.** The diff is whitespace-only bar one import reorder in
  `middleware_test.go`; `go test ./...` green.
  **The gate is the real change, and finding out why it had never been built is
  the finding.** This entry deferred to "the issuer has a matching open item for
  a CI `gofmt` gate", and that issuer item had been re-noticed three times
  (2026-07-28, 2026-08-05, and implicitly here) as "ten minutes of work". It was
  not ten minutes, because **`Realm-ID/sdk` had no push/PR CI at all** — only
  two tag-triggered publishers and `verify-go-release.yml`. There was no
  workflow to add a step to. An item naming a step inside a workflow that does
  not exist reads as trivial and is not.
  New `.github/workflows/ci.yml` runs go (gofmt + build + vet + test), ts (tsc +
  node --test) and java (gradle test) on push and PR, jobs independent so a
  broken toolchain in one cannot hide a red suite in another. The issuer's unit
  job gained the same gofmt step. Both gates mutation-verified; all three job
  command sets verified locally in containers, since Actions is down and cannot
  run them. Original entry:

- [ ] **`gofmt -l` reports FOUR files** — `go/claims.go`,
  `go/middleware_test.go`, `go/roles_test.go`, `go/tenants.go` (re-run
  2026-08-21 in a `golang:1.23-alpine` container). Pre-existing, unrelated to
  any current change; the issuer has a matching open item for a CI `gofmt` gate.
  ⚠️ **This entry named only two of them** and was cited as "the cheapest item"
  on that count. Same class as every other stale figure in these files: a number
  measured once and quoted later as a finding. Re-measure before quoting.
- [x] ~~**TS: BFF on-behalf-of parity**~~ — **CLOSED 2026-08-21 BY MEASUREMENT.
  Do not re-open as a build task.** The item asked for a `userId` +
  `X-On-Behalf-Of-User` path in TS "because Go and Java have it". Checked
  against a live issuer (`tests/sdk-e2e`) before writing any code:
  - platform bearer + bare `X-On-Behalf-Of-User` → **401
    `x_user_token_required`**. Issuer v0.66.0 removed that mode: the id was an
    unauthenticated user id any platform-key holder could use to act as any
    user in the realm.
  - platform bearer + `X-User-Token`, **no id at all** → **200**.

  So TS was never missing the working mode — `realm.withUserToken(jwt)` has sent
  exactly that since ts `0.33.0`. **Building the item as written would have
  shipped a mode the issuer refuses**, the "documented, wired, does nothing"
  shape this workspace keeps paying for.
  **What was wrong on the Go/Java side is the real finding:** their `UserID`
  path sends the id with NO user token, so it 401s against any current issuer
  unless the caller separately threads one. Both now refuse locally, naming the
  remedy. **Scoped carefully** — the id is an IDENTITY pivot on sessions/MFA-self
  (`derivePlatformActsOnUser`) but a DOMAIN PARAMETER on the OTP routes
  (`internal/httpapi/otp.go`: "NOT an authz pivot"), so Go's `resolveOnBehalfOf`
  takes an `idAssertsIdentity` flag and OTP passes false; a blanket refusal broke
  three OTP tests, which is how the distinction was found.
  **Nine tests (7 Go, 2 Java) were PINNING the dead mode** — asserting a bare
  on-behalf-of id against a fake server that accepts anything. Updated to thread
  a user token. Same shape as every other "the guard tested the half that was
  not broken" finding here.
- [x] **Java: implement the ADR-041 client-side realm pin.** **DONE 2026-08-21,
  java `0.35.0`.** `PlatformTokenManager` decodes the freshly-minted platform
  token and raises `REALM_MISMATCH` when its `iss` does not end in the
  configured realm; `Realm.builder()` wires the realm id in, so the pin is on
  for every partner-built client.
  **The finding is the WIRING, not the check.** Four manager-level tests pass
  with `Realm` passing `null` for the realm id — i.e. with the pin dead for
  every real consumer — which is this workspace's recurring "correct one layer
  below where it must fire" shape. `RealmPinWiringTest` builds through
  `Realm.builder()` and is the only test that dies under that mutation.
  **The skip branch is load-bearing and was nearly missed**: treating an
  undecodable token as a mismatch (the obvious "stricter" reading) turns every
  opaque access token into an auth failure — mutating it red 130+ tests across
  the suite, because every fixture mints an opaque `pt-…`. A pin is a
  provenance question, not a token validator.
- [x] **Device-name (ADR-062) lockstep** — **DONE 2026-08-21** (java `0.35.0`,
  ts `0.37.0`).
  ⚠️ **This entry said "JAVA ONLY now" and that was WRONG.** TS had only the
  READ half (`SessionInfo.device_name`); `LoginRequest` had no `deviceName` and
  nothing in `ts/src` ever sent `X-Device-Name`, so the send half was **Go-only**
  and a TS consumer could display a label it had no way to set. The claim
  survived because the read half is the visible one — the same "check the
  artifact, not the shim" lesson this item already carried, one layer over.
  Both SDKs now send the header on the **user grant only** (never the platform
  bootstrap, an M2M mint the issuer records no device for) and Java's `Session`
  gains `deviceName()`. Java's session-list fixture had been serving
  `device_name` all along while `@JsonIgnoreProperties(ignoreUnknown = true)`
  swallowed it — a test can serve a field for months and assert nothing about it.
  Still open, unchanged: (2) optional — show the device name on the `/device`
  approve page (needs a by-`user_code` lookup).
  ✅ **The re-vendor half was CLOSED 2026-08-06, and the alarm in this item was
  false.** The prior note claimed the committed tarball lacked `device_name` and
  that "eight repacks shipped without picking the field up". Checked inside the
  vendored artifact — `tar -xzOf vendor/realm-id-web-admin-0.8.18.tgz
  package/dist/types.d.ts` — and `device_name?` is declared on `ActiveSession`.
  It was already there. `ui/web/src/Settings/Sessions.tsx`'s local
  `& { device_name?: string }` augmentation is deleted; the component reads the
  field at two sites, so `tsc` passing after the deletion is a real check that
  the SDK type carries it, not a vacuous one.
  **Why this stayed open so long is the reusable part:** the item was re-verified
  three times by checking whether the SHIM still existed in `ui/`, which it did —
  but a shim outliving its need looks identical to a shim still needed. The
  question "is the field in the tarball?" was never asked until now.

> **NOT RELEASED — both bumps are committed locally only.** GitHub Actions is
> down on the `Realm-ID` org (billing), so `java-v0.35.0` and `ts-v0.37.0` are
> unpublished; Maven Central still serves `0.34.0` and npm `0.36.0`. Tag and
> publish when CI returns.

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

> **CLOSED 2026-08-06 — `GET /platforms/{id}` in the PARTNER SDKs is NOT
> NEEDED. Do not re-open without a named caller.**
> ✅ The two browser wrappers shipped: `platforms.get(id)` (web-admin `0.8.19`)
> and the staff-side `admin.getPlatform(id)` (`@realm-id/sdk` `0.36.0`).
>
> **The item's premise was false.** It justified partner-SDK work with "it is
> the read the CLI's `platforms describe` needs". **The CLI does not use the Go
> SDK at all** — `cli/go.mod` requires only `gopkg.in/yaml.v3`, and requests go
> through its own `newRequest` helper. Its commands are DERIVED from an embedded
> copy of the issuer swagger at runtime (`buildCommands`), and `deriveCommand`
> already maps a trailing `{param}` + GET to the verb `describe`. Re-vendoring
> the spec (`0.20.0` → `0.24.0`) delivered `platforms describe` AND
> `admin platforms describe` with no code change — verified by building the CLI
> against both specs and diffing the command tree. Shipped in `cli` 2026-08-06.
>
> **So the cost estimate was wrong in BOTH directions**, which is why it stalled:
> "the wrapper is small" understated it (there is no `platforms` resource in
> `go/`, `ts/` or `java/` at all — `/platforms/mine` appears only inside the
> `realm.Info()` discovery path, and `SPEC.md` has no Platforms section, so it
> would be a new surface + a SPEC change + three releases), while the CLI half
> was overstated (a file copy). Neither number was checked against the consumer.
>
> **What would re-open it:** a partner asking to read a platform from a server
> SDK. Until then there is no caller — building it would add a `SPEC.md`
> section and three implementations for nobody. If it does re-open, settle
> first whether `mine()` moves onto the same resource so `realm.Info()` consumes
> it rather than reimplementing it.
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

