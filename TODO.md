# TODO — sdk/ (go · ts · java · web)

> 🔴 **THIRD instance of the same defect class, found 2026-09-01 — the refresh
> lane drops `role_permissions` too, and per ADR-100 D18 that SILENTLY WIDENS a
> token.**
>
> Found while reviewing a partner's ADR against issuer source. The derived-claims
> fix (go `0.54.0` / ts `0.47.0` / java `0.44.0`) covers `product_roles` and
> `scope`. It does **not** cover `role_permissions`, and that one is worse
> because the failure direction is WIDER rather than absent.
>
> **Issuer source, `authsvc/service.go:1415-1422` (ADR-100 D18), verbatim:**
> *"the narrowing operand is supplied on REFRESH too, and it has to be. A
> user-API-key session IS refreshable (`recheckUserKeyForMint` re-reads the row
> on every mint), so a refresh that skipped the narrowing would hand back a token
> WIDER than the one it replaced — silently, and on a schedule."*
>
> The SDK middleware's refresh passes no `RolePermissions`, so `narrow()` takes
> the `RolePermissions == nil` branch and returns the STORED cap unnarrowed. The
> token cannot exceed the stored cap (`A ∩ B ⊆ A`), but it DOES widen back to the
> full stored cap from whatever the per-org list had narrowed it to at login.
>
> ⚠️ **A user-API-key session IS refreshable, and our own source says otherwise
> in one place.** `user_api_key_login.go:273` says *"This lane is ADR-089
> access-token-only"* — but `:223` mints a refresh token, `:231` stores its hash,
> `:289` returns it, and `:156`/`:237` both describe the session refreshing
> through `MintForTenant`. **The comment is wrong; the code is right.** I relayed
> that comment to a partner as fact before checking the surrounding code, and had
> to correct it. Fix the comment as part of this.
>
> **Needs a design pass, not an inline fix** — a `RolePermissions` resolver is a
> third handler, and unlike the other two its absence is a silent WIDENING rather
> than a missing claim, so "no handler configured" cannot mean "do nothing".
> Not started.


> 🔴 **LIVE DEFECT + BLOCKER, filed 2026-09-01 — derived claims are resolved on
> LOGIN LANES ONLY, so a BFF session loses them at its first refresh.**
>
> ⚠️ **WIDENED the same day, and the widening is the important part.** This was
> filed as "`scope` has no every-mint seam" (a future blocker). Tracing the fix
> showed **`product_roles` has the IDENTICAL hole and it is LIVE** — Traide
> shipped ADR-102 adoption in their `api v0.37.0` on 2026-09-01 and their humans
> lose the claim one access-TTL into every session.
> `mintProductRoles` has exactly THREE call sites — `auth.go:557` `Login`,
> `:618` `CompleteLogin`, `:924` `PasswordLogin` — **all login lanes**, verified
> byte-identical to the published `go/v0.53.1`. `middleware.go:568` refreshes
> with `{RefreshToken, TenantID, CustomClaims}` and `Token` forwards only what it
> is given. **Our own `product_roles.go:30-32` promises the opposite in
> writing** — *"runs on EVERY mint, refresh included, and nothing caches"* — so
> the contract is right and the refresh lane does not honour it.
> Traide's report cited `:924` as being inside `Token`; it is inside
> `PasswordLogin`, and correcting that citation is what exposed this.
> **They have NOT been told** — their session ended before the follow-up could
> be delivered. Outstanding partner notification.
> Design: `.scratch/scope-hook/SPEC.md`. Fix BOTH claims with ONE mechanism.
>
> ~~`scope` has no every-mint seam, so ADR-097 cannot be adopted by a BFF
> partner.~~ (still true; now the second half of the above)
> Found by Traide's engineering while designing their ADR-097 cutover; the
> mechanism is VERIFIED in issuer source at `3954a4c` (live `v0.116.0`), not
> taken on their word.
>
> **The issuer does not carry `scope` across a refresh, by design.**
> `sessionstore.Session` has no scope field and `authsvc/service.go:1613-1616`
> states why: *"`scope` is never stored on a session, precisely so it cannot go
> stale."* `MintForTenant` reads `req.Scope` only (`:1328`), and
> `tokens.Claims.Scope` is `omitempty`, so a `/auth/token` without `scope`
> mints **no scope claim at all**. `sdk/go/scope.go:50-53` then reads that as
> "no granted authority" — fail-closed, correctly.
>
> **The gap is OURS, and it is the same class as the §4.1 guide defect.**
> `Config` has exactly one handler, `ProductRoles`. There is no scope analogue,
> so nothing derives scopes from the roles a partner's own handler just
> resolved. On the LOGIN flow a partner can re-mint via `OnAuthSuccess` (the
> event carries a live `*Session` and fires before the response is written).
> **On the REFRESH flow `ev.Session` is nil**, and the middleware's own refresh
> mints with no `Scope` and no `RolePermissions` — so a BFF-fronted human
> session loses its authority at the FIRST refresh, and a `ScopePolicy` gate
> denies everything roughly one access-TTL into every session.
>
> **Consequence:** for a BFF partner, token scope is stale for the LIFE of the
> session, not for one TTL. Traide are correctly refusing to ship the cutover
> until this exists.
>
> **Shape:** a `Config.Scopes` handler applied at EVERY mint, exactly as
> `mintProductRoles` already does for ADR-102 (`auth.go:557`/`:618`/`:924`).
> Needs NO issuer change — the issuer's contract is "requested per mint, never
> remembered", and a client-side closure satisfies it. Do the same in ts + java,
> not just go; the ADR-102 seam is the template for all three.
>
> ⚠️ **Check the partner-integration guide in the same pass.** §4.1 already had
> to be corrected once for pointing BFF partners at a per-call field instead of
> the realm-level handler that actually reaches humans. Anything the guide says
> about `scope` is likely to carry the identical error.
>
> Not started. Needs a design pass + the user's go-ahead (`discuss features
> first`) — it is a new SDK surface across three languages, not a fix.


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

- [ ] **All three SDKs' `integrations.install()` send the retired `role_id`
  body — a current issuer refuses it.** ADR-101 D7 (issuer `v0.113.0`) replaced
  the role-based install with a stated `permissions: []string` grant; the
  issuer's `installReq` has no `role_id` field and an absent/empty
  `permissions` is `400 permissions_required`. `ts/src/integrations.ts:229`
  (`body: { integration_id, role_id }`), `go/integrations.go:76`
  (`InstallRequest.RoleID`), and java's equivalent all still speak the old
  contract, and the error unions still carry `role_not_service_typed` /
  `role_not_installable` / `role_unavailable`, which no current issuer emits.
  Fix in all three + SPEC, with a drift test against the issuer swagger.
  *(Found 2026-08-31 during the docs audit; the docs now describe the issuer
  contract and warn about this lag — `docs/integration-guide.md` §9.2/§9.3,
  `docs/error-reference.md`.)*

- [ ] **CI runs no job for `web/packages/*` at all.** `.github/workflows/ci.yml`
  has `go`, `ts` and `java` jobs and nothing for the browser packages, so
  `@realm-id/web-admin`'s `npm run typecheck` and `npm test` never run on a
  push — including the tsconfig.test.json pass added on 2026-08-28, which is
  therefore only as good as someone running it locally. These packages are what
  the admin console actually vendors. *(Found 2026-08-28 while pinning
  `MeMembership.realm_id`; the pin was mutation-verified locally.)*
  `.github/workflows/ci.yml`, `web/packages/*/package.json`.

- [ ] **`@realm-id/web-admin` `0.9.1` is committed but NOT published or
  vendored.** It adds `MeMembership.realm_id` (issuer spec `0.34.0`). Until it
  is published and re-vendored into `ui/web/vendor/`, the console cannot read
  the field — and it would see nothing anyway until the BFF (`Realm-ID/api`)
  declares it, since that BFF re-encodes `/me` through its own struct and drops
  what it does not declare. Order: `api/` → publish `0.9.1` → re-vendor →
  `ui/`. Verify the packed tarball's bundled dep, not the version string
  (`tar xzOf vendor/realm-id-web-admin-0.9.1.tgz package/node_modules/@realm-id/sdk/package.json`).

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

> **BOTH TAG-HYGIENE RESIDUALS DECIDED 2026-08-23 (user call) and shipped.**
> **ts/java annotation — ENFORCED**, in both publishers, as the FIRST step so it
> runs before anything is released. That ordering turns out to matter more than
> the decision did: unlike `go/v*`, nothing has been published when the check
> fires, so the remedy is to delete the tag and re-cut it annotated. The script
> has a separate `annotated-prepublish` mode purely to print that remedy instead
> of Go's "ship the next patch version", which would burn a version for nothing.
> **Pre-tag check — ADOPTED.** `tag-hygiene.sh unreleased-go` runs in the CI Go
> job on main and every PR and fails when `go/` differs from the tag matching its
> declared `const Version`. The accepted cost is a policy: after a release, the
> first PR touching `go/` must bump the const. Mutation-verified against the real
> tree (declaring the released `0.44.0` reports 12 changed files and fails).
> Rationale: `DECISIONS.md` 2026-08-23.

> **DONE 2026-08-24 — `platform_not_found` is registered in all three
> languages** (ts `0.38.0` / go `0.46.0` / java `0.36.0`), and so are the seven
> other codes the sweep found out of sync. **Both halves of this item's premise
> were false**: the three taxonomies were EIGHT codes apart, and "all three
> agree" was never evidence of intent in the first place — the lists are
> hand-maintained from one SPEC, so one omission propagates to all three and
> agreement is what a shared oversight looks like.
> `scripts/taxonomy-parity.py` now measures it every CI run.
> Shipped BREAKING with the migration named (match both codes). See
> `DECISIONS.md` 2026-08-24 (later). Original entry, kept for its history:
> ~~**`platform_not_found` is not in the `ErrorCode` taxonomy (all three
> languages).**~~ The issuer returns it on `GET /platforms/{id}`,
> `GET /admin/platforms/{id}`, `PATCH /platforms/{id}` and others, but it is
> absent from `ts/src/errors.ts`'s `KNOWN_CODES`, from `go/errors.go`, and from
> the Java taxonomy — so `mapErrorResponse` falls back to `statusToCode(404)` and
> every caller sees the generic `not_found`. Consistent across the three SDKs, so
> no language is the outlier; that is why it reads as intentional and may be.
> **Decide, don't drift:** either add it in lockstep (a SPEC change + three bumps)
> or document that platform-scoped 404s normalize deliberately. **The upgrade
> hazard if it is added:** any consumer today catching `not_found` on a platform
> route silently stops matching, so it is behaviour-breaking despite being purely
> additive to a union. Filed 2026-08-06 while wrapping the by-id reads, where the
> first draft of the test asserted the specific code and failed.
> *(Whatever is decided, the 404 must stay indistinguishable between "not yours"
> and "never existed" — that is a security property, not a taxonomy question.)*
> ~~**`java/CHANGELOG.md` has no `java-v0.34.0` entry.**~~ **BACKFILLED
> 2026-08-25** from release commit `1b5e1c0` (the same commit that cut
> `go 0.44.0` / `ts 0.35.0` / `java 0.34.0`), cross-checked against the
> matching entry in `../CHANGELOG.md`. Entry now sits between `java-v0.35.0`
> and `java-v0.33.0`. The mechanism that let this happen was already closed
> 2026-08-24 (`scripts/changelog-hygiene.sh`).
> >
> ~~**`ts/CHANGELOG.md` is missing `0.29.0`–`0.35.0`.**~~ **BACKFILLED
> 2026-08-25**, all seven versions, from their release commits (`ffa935c`,
> `a512679`, `b6c9ad0`, `52f4eb1`, `398c3ef`, `5f44408`, `1b5e1c0`) —
> cross-checked against each version's matching entry in `../CHANGELOG.md`,
> which already carried the full cross-language writeup for every one of
> these releases (nothing here was invented). The stale "Gap notice"
> blockquote at the top of the file is removed along with it. Verified via
> `scripts/changelog-hygiene.sh npm` (passes — it only gates the current
> version at publish time, so this is a spot-check of the seven headings by
> `grep`, not the gate itself).

> ~~**`changelog-hygiene.sh` gates PRESENCE, never ORDER — and `ts/CHANGELOG.md`
> had a six-release inversion nobody could have caught.**~~ **BUILT + CLOSED
> 2026-08-25 — `changelog-hygiene.sh order`, wired into `ci.yml`** (not into the
> publishers: order is a property of the file at all times, and a publish-time
> check would order-verify `java/CHANGELOG.md` only on a Maven release).
> Subjects derived from `ts/` + `java/` + `web/packages/*`; refuses to inspect
> zero files AND zero headings; refuses to swallow a heading it cannot parse.
> Mutation-verified against the original defect (it names `0.36.0` at its exact
> line). **The root `CHANGELOG.md` is excluded on measured grounds** — multi-
> language headings, and 15 of its 64 carry no date, so no total order exists to
> assert. **It found a second defect immediately**: `## Unreleased` at the BOTTOM
> of `ts/CHANGELOG.md`, recovered as `0.13.0` from three agreeing pieces of
> evidence, with the one piece that does NOT agree (SPEC v0.7.0 vs v0.8.0) left
> standing in the entry rather than smoothed over. Full reasoning in
> `DECISIONS.md`.
> >
> The ORIGINAL text of this item, kept because it separates what was fixed by
> hand from what the gate now prevents:
> > Found 2026-08-25 while verifying the backfill above: `0.36.0`
> > (2026-08-06) sat between `0.29.0` and `0.28.0`. A reader scanning a
> > descending changelog stops at the first heading below what they want, so
> > `0.36.0` was invisible in exactly the way the seven missing entries were —
> > a version that is present and unreachable reads the same as one that is
> > absent.
> > **Moved into place 2026-08-25** (pure move: 35 insertions / 35 deletions,
> > no wording touched), so the file is now correct. **What is NOT fixed is
> > the mechanism**: the script checks that the version being published has a
> > heading, which says nothing about the ones beneath it, and the backfill
> > itself was only spot-checked by `grep` for the same reason. Add a
> > descending-order assertion over every `## ` heading in all three changelogs
> > (plus `web/packages/admin/CHANGELOG.md`), so it fails the next inversion
> > rather than the next reader. Not verified for the other three files — the
> > check is the point, not another hand sweep.
> >
> **The "not verified for the other three files" caveat is now discharged**: the
> gate reads all six per-package changelogs (63 headings) and reports the count,
> so "checked nothing" cannot read as "all clean".

- [ ] **`ui/DECISIONS.md` (3,147) and the root `DECISIONS.md` (3,167) are both
      unsplit, and both now exceed `issuer/DECISIONS.md`'s post-split main file
      (3,485 main / 8,598 archive).** Measured 2026-08-25. The item that produced
      the sdk + issuer split named `sdk/DECISIONS.md` — the smallest of the five
      — because that is the file someone happened to be looking at; the same
      mis-file is still live for these two, which no item anywhere names. Same
      `decision-log` treatment: index under the H1 + a `DECISIONS-ARCHIVE.md`
      split, text MOVED not rewritten, every `## ` heading verified present in
      exactly one of the two files afterwards. (Filed in `sdk/TODO.md` only
      because that is where the split item lives; the work is in `ui/` and the
      umbrella repo.)
> >
> ~~**`DECISIONS.md` needs an index and an archive split.**~~ **The filed file
> was not the problem file — corrected and closed 2026-08-25.**
> `sdk/DECISIONS.md` was **2,480 lines** / 61 entries when re-measured
> 2026-08-25 (up from the 2,261 the item said), but `issuer/DECISIONS.md` was
> **11,565 lines** / 198 entries the same day — 4.6× larger, and named in NO
> item anywhere. Both now carry the `decision-log`-skill treatment: a
> one-line-per-entry index under the H1 (linking into the archive where an
> entry moved) plus a `DECISIONS-ARCHIVE.md` split. `sdk/DECISIONS.md` →
> 1,285 lines main / 1,274 archive (22 recent entries kept, 39 moved,
> split at 2026-07-27). `issuer/DECISIONS.md` → 3,183 lines main / 8,598
> archive (46 recent entries kept, 152 moved, split at 2026-08-07). Every
> original `## ` heading verified present in exactly one of the two files
> post-split (diff of sorted heading lists, both repos) and every entry BODY
> verified byte-identical to the pre-split original (no rewording) — text was
> moved, not rewritten. No entry lost.
> **DONE 2026-08-06 — the ADR-081 role fields were NEVER actually missing, and
> the diagnosis in this item was wrong.** `assignable_to` / `can_invite_roles`
> ship on `RoleObject` in the tarball's bundled `@realm-id/sdk` and have for
> some time; the vendored `0.8.18` was verified to carry them. The "0 matches in
> `web/packages/admin/src`" evidence recorded on 2026-07-28 was **a correct grep
> supporting a false conclusion**: web-admin re-exports `RoleObject` from
> `@realm-id/sdk/internal`, so the fields were never expected to appear in
> web-admin's own source, and their absence there proved nothing. No repack was
> needed at any point.
> >
> The real remaining work was UI-side and is now done: `RealmRoles.tsx` carried
> five `r as AssignableRoleLike` casts over values already typed `RoleObject`.
> Those are deleted. **The casts, not the missing fields, were the defect** — a
> structural `as` over an SDK type silences exactly the drift the type exists to
> report, so they would have gone on passing had the fields genuinely never
> arrived. `AssignableRoleLike` survives as the pure predicate's deliberately
> tolerant input contract in `roleAssignability.ts` (it must still accept an
> older issuer's response omitting `assignable_to`), but no caller casts to it.
> >
> **The lesson is the verification method, not the fields:** this item sat open
> across eight repacks because it was re-checked by grepping SOURCE. Check the
> packed tarball — `npm pack <pkg>@<version>` — which is what finally settled it.
## Scope removal (ADR-097 §G) — partial language coverage

- [ ] **`scopes.remove` exists in `ts` ONLY.** Written and tested at
      `sdk/ts/src/scopes.ts` (`0.40.0`, unpublished — CI down). `go` and `java`
      have no `ScopesClient` at all, so this is not "add a method" but "add the
      resource" in both — the same shape as the rename, which is also ts-only.
      Decide deliberately whether `scopes` is a ts-only surface (the console is
      its only consumer today) or a lockstep one; SPEC §13 says surface changes
      that break wire compatibility need all three, and an ADDITIVE resource does
      not, so this is a product call rather than a spec violation.
> ~~**`web-admin` needs `scopes.remove`** to match `scopes.rename`~~
> **FALSE, checked 2026-08-25 — it already had it.** `web-admin` does not
> implement `ScopesClient`; it re-exports the ts one
> (`@realm-id/sdk` is a SYMLINK to `../../../ts`), so `remove` arrived with ts
> `0.40.0` the moment it was written. The item was filed from the shape of the
> `rename` release rather than from the package. What was genuinely missing is
> a TEST: **no test in this package went through `createAdmin` at all**, so the
> wiring `0.8.20`'s changelog claims was unverified in both directions. Five
> now do (`src/scopes.test.ts`), each mutation-verified. `0.8.20`'s changelog
> entry amended in place — it is unpublished, so no version bump.
> The ui console screen stays blocked on PUBLISHING `0.8.20`, which is CI.
> ~~**`sdk/ts` `npm test` fails on the macOS host**~~ **FIXED 2026-08-25.**
> Host tree reinstalled (`npm test` 221/0 on macOS), and
> `scripts/npm-in-docker.sh <pkg> [npm args...]` now shadows `node_modules` with
> a per-package named volume so a container run cannot reach the host tree.
> **The entry's own diagnosis was wrong in both halves and that is the finding:**
> the prescribed fix — shadow `node_modules` in compose — was ALREADY shipped
> (`tests/docker-compose.test.yml`'s `sdk-e2e-ts`, since `dbeeb75`, with a
> comment naming this hazard), and the cause was the unshadowed `docker run -v
> "$(pwd)":/w` recipe **this entry published as the workaround**. Reproduced in
> both directions before and after. RCA: `DECISIONS.md` 2026-08-25.


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

> ~~**TS `listSessions` returns the FIRST PAGE only.**~~ **DONE 2026-08-21,
> ts `0.37.0` — BREAKING.** Now returns `Paginated<SessionInfo>` and follows
> `next_cursor`. All three languages page as of go `0.45.0` / ts `0.37.0` /
> java `0.35.0`; SPEC §4.6 updated, since it documented the divergence as a
> standing carve-out.
> **The deciding argument was internal consistency, not cross-language
> tidiness**: `Paginated<T>` is already exported TS public API and already what
> `federationBindings.list()` returns, so the bare array was the odd one out
> *inside the TS SDK itself*. Two non-breaking options were weighed and
> rejected — looping internally behind the array signature (unbounded, no early
> stop, keeps the SPEC §7 carve-out) and adding a second paged method (leaves
> the truncating call as the default one everybody reaches for). A compile
> error with an obvious fix beats the same call quietly returning a different
> row count.
> **Verified against a REAL issuer**, not only a fixture: the new e2e case
> drives the issuer's own `pagedSlice` with `limit: 1` so two sessions force a
> second page, and asserts as a PRECONDITION that the server emits
> `next_cursor` at all. Mutation-verified three ways. Also fixed on the same
> lines: `docs/integration-guide.md` §4.5 showed the old array call AND read
> `s.createdAt`/`s.lastUsedAt`, fields TS has never returned.
> Rationale: `DECISIONS.md` 2026-08-21 (latest).
> ~~**`gofmt -l` reports FOUR files**~~ — **DONE 2026-08-21, formatted AND
> gated.** The diff is whitespace-only bar one import reorder in
> `middleware_test.go`; `go test ./...` green.
> **The gate is the real change, and finding out why it had never been built is
> the finding.** This entry deferred to "the issuer has a matching open item for
> a CI `gofmt` gate", and that issuer item had been re-noticed three times
> (2026-07-28, 2026-08-05, and implicitly here) as "ten minutes of work". It was
> not ten minutes, because **`Realm-ID/sdk` had no push/PR CI at all** — only
> two tag-triggered publishers and `verify-go-release.yml`. There was no
> workflow to add a step to. An item naming a step inside a workflow that does
> not exist reads as trivial and is not.
> New `.github/workflows/ci.yml` runs go (gofmt + build + vet + test), ts (tsc +
> node --test) and java (gradle test) on push and PR, jobs independent so a
> broken toolchain in one cannot hide a red suite in another. The issuer's unit
> job gained the same gofmt step. Both gates mutation-verified; all three job
> command sets verified locally in containers, since Actions is down and cannot
> run them. Original entry:
> ~~**TS: BFF on-behalf-of parity**~~ — **CLOSED 2026-08-21 BY MEASUREMENT.
> Do not re-open as a build task.** The item asked for a `userId` +
> `X-On-Behalf-Of-User` path in TS "because Go and Java have it". Checked
> against a live issuer (`tests/sdk-e2e`) before writing any code:
> - platform bearer + bare `X-On-Behalf-Of-User` → **401
> `x_user_token_required`**. Issuer v0.66.0 removed that mode: the id was an
> unauthenticated user id any platform-key holder could use to act as any
> user in the realm.
> - platform bearer + `X-User-Token`, **no id at all** → **200**.
>
> So TS was never missing the working mode — `realm.withUserToken(jwt)` has sent
> exactly that since ts `0.33.0`. **Building the item as written would have
> shipped a mode the issuer refuses**, the "documented, wired, does nothing"
> shape this workspace keeps paying for.
> **What was wrong on the Go/Java side is the real finding:** their `UserID`
> path sends the id with NO user token, so it 401s against any current issuer
> unless the caller separately threads one. Both now refuse locally, naming the
> remedy. **Scoped carefully** — the id is an IDENTITY pivot on sessions/MFA-self
> (`derivePlatformActsOnUser`) but a DOMAIN PARAMETER on the OTP routes
> (`internal/httpapi/otp.go`: "NOT an authz pivot"), so Go's `resolveOnBehalfOf`
> takes an `idAssertsIdentity` flag and OTP passes false; a blanket refusal broke
> three OTP tests, which is how the distinction was found.
> **Nine tests (7 Go, 2 Java) were PINNING the dead mode** — asserting a bare
> on-behalf-of id against a fake server that accepts anything. Updated to thread
> a user token. Same shape as every other "the guard tested the half that was
> not broken" finding here.
> **Java: implement the ADR-041 client-side realm pin.** **DONE 2026-08-21,
> java `0.35.0`.** `PlatformTokenManager` decodes the freshly-minted platform
> token and raises `REALM_MISMATCH` when its `iss` does not end in the
> configured realm; `Realm.builder()` wires the realm id in, so the pin is on
> for every partner-built client.
> **The finding is the WIRING, not the check.** Four manager-level tests pass
> with `Realm` passing `null` for the realm id — i.e. with the pin dead for
> every real consumer — which is this workspace's recurring "correct one layer
> below where it must fire" shape. `RealmPinWiringTest` builds through
> `Realm.builder()` and is the only test that dies under that mutation.
> **The skip branch is load-bearing and was nearly missed**: treating an
> undecodable token as a mismatch (the obvious "stricter" reading) turns every
> opaque access token into an auth failure — mutating it red 130+ tests across
> the suite, because every fixture mints an opaque `pt-…`. A pin is a
> provenance question, not a token validator.
> **Device-name (ADR-062) lockstep** — **DONE 2026-08-21** (java `0.35.0`,
> ts `0.37.0`).
> ⚠️ **This entry said "JAVA ONLY now" and that was WRONG.** TS had only the
> READ half (`SessionInfo.device_name`); `LoginRequest` had no `deviceName` and
> nothing in `ts/src` ever sent `X-Device-Name`, so the send half was **Go-only**
> and a TS consumer could display a label it had no way to set. The claim
> survived because the read half is the visible one — the same "check the
> artifact, not the shim" lesson this item already carried, one layer over.
> Both SDKs now send the header on the **user grant only** (never the platform
> bootstrap, an M2M mint the issuer records no device for) and Java's `Session`
> gains `deviceName()`. Java's session-list fixture had been serving
> `device_name` all along while `@JsonIgnoreProperties(ignoreUnknown = true)`
> swallowed it — a test can serve a field for months and assert nothing about it.
> Still open, unchanged: (2) optional — show the device name on the `/device`
> approve page (needs a by-`user_code` lookup).
> ✅ **The re-vendor half was CLOSED 2026-08-06, and the alarm in this item was
> false.** The prior note claimed the committed tarball lacked `device_name` and
> that "eight repacks shipped without picking the field up". Checked inside the
> vendored artifact — `tar -xzOf vendor/realm-id-web-admin-0.8.18.tgz
> package/dist/types.d.ts` — and `device_name?` is declared on `ActiveSession`.
> It was already there. `ui/web/src/Settings/Sessions.tsx`'s local
> `& { device_name?: string }` augmentation is deleted; the component reads the
> field at two sites, so `tsc` passing after the deletion is a real check that
> the SDK type carries it, not a vacuous one.
> **Why this stayed open so long is the reusable part:** the item was re-verified
> three times by checking whether the SHIM still existed in `ui/`, which it did —
> but a shim outliving its need looks identical to a shim still needed. The
> question "is the field in the tarball?" was never asked until now.
>
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
- [ ] **`federationBindings` resource in `@realm-id/web-admin`** — the UI still
  carries `list/create/revokeFederationBinding` shims (`ui/web/src/api.ts:449`,
  and the comment at `:19` says why). The `scope` field is free-text — tighten
  if a scope catalog is ever defined.
  ⚠️ **CORRECTED 2026-08-24 — this is a PORT, not a build, and the entry said
  "Mirror `ApiKeysClient`" as if from scratch.** `sdk/ts` ALREADY has the
  resource: `ts/src/federation-bindings.ts` with `federation-bindings.test.ts`,
  wired into `realm.ts`. The gap is web-admin only. Copying a tested
  implementation is a materially different cost from mirroring a sibling.
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

## Integration-guide improvements from the Traide exchange (2026-08-31)

Derived from a live partner incident and the two-round exchange that followed,
NOT from a review pass. Each item is something a partner actually got wrong, or
that we got wrong answering them. Ordered by what would have prevented the most.

1. **State that the `role` claim is a partner-visible CONTRACT.** The claim
   carries `users.role` verbatim (`issuer/internal/tokens/tokens.go:52`), and
   partners key their own authorization off that string — Traide's GoFr RBAC
   reads `jwtClaimPath: "role"` against their own catalog. The guide never says
   this, so a partner cannot know a role rename is a breaking change for them.
   **Say it, and say the corollary**: do NOT key product authorization off the
   RealmID role name; that is what ADR-097 `scope` is for. ADR-040 recorded this
   coupling years ago and the guide never carried it forward.

2. **Document the scoped-token CUTOVER, not just the mint.** §4.2 says how to
   ask for a scope; nothing says how to adopt one on a running system. Needs:
   the mint must sit immediately after login and not only on the refresh path
   (because `/auth/login` can NEVER mint a scope, so a login-only population
   never converges); mint with the gate OFF, wait one refresh cycle — NOT
   `access_ttl_seconds` — then observe mode, then enforce; and if an overlap
   shim is needed, it must distinguish ABSENT scope (legacy) from
   PRESENT-but-insufficient, invert `scopeAllows`'s fail-closed default only
   inside the partner's own wrapper, and carry a date plus a removal ticket in
   the same commit.

3. **Warn that a partner's own test doubles can hide contract drift.** Traide's
   `stubissuer` echoes any role name back as `active` with no catalog check, so
   their suite passes for a role RealmID would refuse; their Vitest suite mocks
   the SDK, so it stays green against a failed install. The guide's §9
   ("Testing your integration") should say what a stub must validate to be
   worth anything, and that a typecheck is stronger evidence than a mocked
   suite.

4. **Document that service-account provisioning VALIDATES the role name.**
   `service_accounts.go:281` → `validateRoleForTenantKind` → `400 unknown_role`.
   Undocumented, and it is the difference between "re-provision onto the right
   role" being a recovery path and being a dead end.

5. **Pinning guidance, both ecosystems.** A caret does not cross a 0.x minor —
   `^0.4.3` never installs `0.5.0` and `npm update` is silent about it. And go
   `0.51.0` reports `const Version = "0.50.0"`; pin `0.51.1` if you read
   `realmid.Version`.

6. **A "what changes when RealmID changes" section.** The guide explains the
   surface but never tells a partner which of our changes can reach their
   runtime. Role vocabulary, claim shape and error codes all can; our
   `permissions` arrays cannot. That framing is what a partner needs to know
   which of our release notes to actually read.

Related: the incident write-up is in the umbrella repo
(`PARTNER-HANDOFF-TRAIDE-SDK-UPGRADE-2026-08-31.md`, private), and the method
for handling this class of question is the `partner-integration-support` skill
in the same repo.

## Docs

*(Empty. The `TransferOwnerRequest` schema backfill was verified done
2026-08-03 and removed.)*


- [ ] **`web-admin`'s browser transport keeps a SEPARATE, much smaller error
      taxonomy** — `web/packages/admin/src/transport.ts` holds **33** codes
      against `ts/src/errors.ts`'s **60** (measured 2026-08-24). So the admin
      console normalizes `platform_not_found` and 26 others to their HTTP-status
      fallback, no matter what the typed SDKs do. It is mitigated, not harmless:
      the transport stashes the raw code in `details.server_code`, so the
      information survives where a caller thinks to look for it.
      **Deliberately NOT folded into the 2026-08-24 taxonomy release** — it is a
      separate, older drift with its own release path (a `web-admin` repack plus
      a re-vendor into `ui/`), and fixing it inside a release about something
      else would have hidden it. `scripts/taxonomy-parity.py` does NOT cover
      this file yet; extending it there is the cheap half, and it should be
      done first so the gap is measured rather than re-discovered.
- [ ] **`not_service` is declared by ts + Java and emitted by NOTHING.** A repo
      sweep of the issuer finds no handler returning it; the only near-match is
      the distinct `role_not_service_typed` (`integration_installations.go:138`).
      It is carried as a reviewed exception in `scripts/taxonomy-parity.py`.
      Removing it is safe in principle — nothing can be matching a code that
      never arrives — but it is a SPEC change across two languages and belongs
      in its own release, not smuggled into one about something else.
      *(Filed 2026-08-24 while registering `platform_not_found`.)*

- [ ] `docs/partner-integration-guide.md` + `docs/integration-guide.md` — TWO
      partner integration guides now sit side by side (~1600 and ~1700 lines) and
      overlap substantially. The first arrived 2026-08-28 from the private
      `Realm-ID/issuer` repo, where partners could not read it. They are not
      reconciled; `docs/INDEX.md` currently tells the reader which is which and
      that `SPEC.md` wins on conflict, which is a signpost, not a fix. Decide:
      merge, or split cleanly by audience (SDK-shaped vs platform-shaped).
- [ ] `docs/partner-integration-guide.md` — the published copy is REDACTED
      (customer names removed) and the private issuer original is not. There is
      no check that a future edit does not reintroduce a customer name into the
      public copy. A CI grep over the public repo for the partner-name list would
      be cheap, but the list itself is then hand-maintained — see the failure
      class in the global notes before writing one.

- [ ] `java/src/test/java/dev/realmid/sdk/roles/RolePredicatesDriftTest.java` —
      the drift gate compares `RolePredicates` against the issuer's own Go
      source, but `Realm-ID/issuer` is a separate private repo that this repo's
      CI never checks out, so the test ABORTS there and only returns a verdict
      on a machine with the workspace checkout. Wire the checkout into
      `ci.yml`'s java job (org-reader GitHub App or a read-only deploy key) and
      make the missing-checkout case a hard failure — a gate that cannot run is
      one release away from being a gate that stopped mattering.
      *(Filed 2026-08-30 with the A1-java predicate port.)*
- [ ] `java/CHANGELOG.md` — `0.40.0` (the ADR-101 work: `RoleScopes`, and
      `required_mfa_methods` / `can_invite_roles` leaving `RoleObject`) had NO
      per-package heading; `build.gradle.kts` was bumped and only the monorepo
      `CHANGELOG.md` recorded it. `changelog-hygiene.sh maven` would have caught
      it at publish. The `0.40.0` heading now added covers only the predicate
      port, so the ADR-101 java bullets are still missing from that section.
      *(Filed 2026-08-30.)*
- [ ] `go/roles_authority.go` `ConfersAuthority` — the issuer classifies a
      well-formed but NON-CATALOG permission (`widgets:read`) as conferring, via
      catalog membership; the SDKs classify by action because they deliberately
      embed no catalog copy. ts and java both take the SERVED catalog as an
      optional argument and then answer exactly as the issuer does; Go has no
      such form, so the three languages do not agree at that edge. Unreachable
      today (write validation rejects unknown permissions), but it is a partner-
      visible difference between SDKs. *(Filed 2026-08-30.)*
- [ ] `ts/src/roles.ts` — `SYSTEM_UNASSIGNABLE` there is
      `{owner, platform_api}`, but the issuer's `realmrole.NonAssignableRoles`
      (`internal/realmrole/store.go:131`) is `{owner, platform_api,
      platform_mgmt_api}`; go and java carry all three. A ts-based picker will
      offer the key-minting bot role to a human — the credential-issuance path
      outside the owner pointer that ADR-101 D6 exists to close. The ts drift
      test does not compare that set.
      *(Filed 2026-08-30 from the java port; ts/ was owned by another agent.)*
- [ ] role predicates — go/java expose ONE `isRoleAssignableTo` that folds in
      the system-name and disabled guards; ts splits them into
      `isRoleAssignableTo` (pure server mirror) + `isRoleSeatable` (the picker
      predicate). Three languages, two shapes, and reaching for the wrong one in
      ts offers `owner`. Pick one shape before the SDKs are released together.
      *(Filed 2026-08-30.)*
- [ ] `ts/src/roles-drift.test.ts` — same limit as the Java gate above, and the
      same fix: the half that re-reads the LIVE issuer source cannot run in this
      repo's single-repo CI checkout, so it emits a diagnostic and
      `REALMID_DRIFT_STRICT=1` is what turns "issuer not reachable" into a
      failure. The pinned-snapshot half DOES run everywhere. Wire the issuer
      checkout into `ci.yml` (org-reader GitHub App or read-only deploy key) and
      set `REALMID_DRIFT_STRICT=1` there.
      *(Filed 2026-08-30 with the A1-ts predicate port.)*
- [ ] `ts` — the `confersAuthority` non-catalog divergence filed above is now
      CLOSED in TypeScript: `confersAuthority(role, { catalog })` takes the list
      `roles.listPermissions()` already serves and answers exactly as the issuer
      does, unknown keys included, with the action-derived rule as the default
      when no catalog is supplied. `go` and `java` should take the same overload
      so the three languages agree. *(Filed 2026-08-30.)*
- [ ] `ts/src/errors.ts` + `go/errors.go` + `java/.../ErrorCode.java` —
      `membership_not_found` is emitted by the issuer
      (`internal/httpapi/me_memberships.go`, three call sites) and is in NONE of
      the three taxonomies, so it falls back to `not_found` and the specific
      remedy is lost. Adding it to one language alone fails
      `scripts/taxonomy-parity.py`, which is why it was not done with the
      ADR-092 D5 `MembershipActionCode` type — that union carries the code, the
      SDK taxonomy does not. Three-language change. *(Filed 2026-08-30.)*
- [ ] `ui/web/src/roleAssignability.ts` — the console mirror never learned
      ADR-091's `is_system` exemption from the §2.3 human-only floor, so it
      filters `platform_api` out of a service-account picker on a rule the
      issuer stopped applying to RI-managed roles. Inert today only because
      `platform_api` is also in the console's hardcoded exclusion set. Fixed by
      wave 4 deleting the file for the SDK predicate; recorded here so the
      finding is not lost if that slips. *(Filed 2026-08-30 from W1b.)*
- [ ] `ts/CHANGELOG.md` — `0.43.0` is in `ts/package.json` (bumped by a92cdac,
      the ADR-101 role-wire change) with NO heading of its own; only the
      monorepo `CHANGELOG.md` recorded it. Same gap as the `java` `0.40.0` item
      above. The `## Unreleased` section added 2026-08-30 sits above it and does
      not cover it. *(Filed 2026-08-30.)*
- [ ] `go/roles_drift_test.go` — the cross-repo drift check
      (`TestRolePredicatesMatchTheIssuer` and its two siblings) can only run
      where an `issuer/` checkout is a sibling of `sdk/`. In `Realm-ID/sdk`'s
      own CI it finds none, logs `DRIFT CHECK DID NOT RUN` and returns — so the
      only CI that runs the Go suite is the one place the check is inert.
      Either give `.github/workflows/ci.yml` a read-only checkout of
      `Realm-ID/issuer` (see the `cross-repo-deploy-key` pattern) or move the
      comparison to the umbrella repo's cross-repo CI, which already has both
      trees. Until then the guard is a local-session guard. *(Filed 2026-08-30
      from W1a.)*
> ~~**`go/http.go` — an UNCANONICAL error code nested INSIDE the `error` object**
> (`{"error":{"code":"role_owner_only",…}}` with nothing at the top level) is
> dropped.~~ **CLOSED 2026-08-30** (`938483b` for go; the three-language check
> this item asked for landed with the contract settle — the key is
> `details.server_code` everywhere, `SPEC.md` §3.3).
>
> **What it was:** `errorFromEnvelope` skipped `code` when collecting the nested
> object's siblings, so `detailCode`/`specificCode` could not see it and
> `mapRoleErr` et al. fell back to the status. It worked only because the issuer
> ALSO emitted the specific code at the TOP level beside the nested object — a
> handler that stopped doing that would have silently lost every sentinel
> mapping. `ts/src/errors.ts` and the java equivalent were read for the same
> shape. *(Filed 2026-08-30 from W1a.)*
- [ ] `go/middleware.go` — `MiddlewareOptions.MFAProtectedPaths` is now
      validated by `ValidateMFARules` at wiring time, but an invalid rule only
      LOGS at error level; the middleware still builds. Refusing to construct
      would be the honest behaviour (a rule that cannot fire reads as
      protection and is none), but `Middleware()` has no error return and
      changing that is a breaking signature change for every existing partner.
      Decide it deliberately at the next major. *(Filed 2026-08-30 from W1a.)*
- [ ] `ts/src/memberships.ts` — `MembershipActionCode`'s nine codes are all
      really emitted (verified 2026-08-30 against `internal/httpapi/`), but they
      are the ONE set `ts/src/roles-drift.test.ts` still cannot compare: the
      issuer declares them inline at ~20 call sites rather than in a single Go
      map, so there is nothing to parse. Either give the issuer a declared
      vocabulary for them or accept the gap knowingly — but it IS a gap, and the
      `platform_mgmt_api` miss is the evidence that an uncovered mirror rots.
      *(Filed 2026-08-30 from W1b.)*
- [ ] `ts/src/roles.ts` — the drift gate compares the SETS the predicates read,
      not the predicate LOGIC: the ADR-091 `is_system` exemption and the ADR-101
      ABSENCE of a per-role MFA floor are asserted by unit tests, so they would
      not go red if the ISSUER changed its mind. `sdk/java`'s gate does parse
      those from the Go source; ts should match. *(Filed 2026-08-30 from W1b.)*
- [ ] `web/packages/core/src/envelope.ts` + `memberships.ts` — `@realm-id/web`
      takes ZERO runtime dependencies, so it cannot import `@realm-id/sdk`,
      which OWNS `unwrapData` / `parseErrorEnvelope` / `MEMBERSHIP_ACTION_CODES`.
      They are held identical by parity TESTS (a devDependency + a shared
      fixture table) rather than by a single source. That is a real gate, not a
      silent copy — but it is still two implementations. Decide deliberately
      whether core should take `@realm-id/sdk` as a runtime dep (it is itself
      dep-free and browser-safe); the cost is the `ui/web` tarball-vendoring
      chain, which pins by filename. *(Filed 2026-08-30 from W2.)*
- [ ] `web/packages/core/src/transport.ts` — the package now has TWO envelope
      unwrappers with DIFFERENT rules: `unwrapEnvelope` (unwraps only when
      `data` is the SOLE key, used by `Transport`) and `unwrapData` (unwraps
      whenever `data` holds something, the sdk contract). Both are deliberate
      and both are documented, but one call site picking the wrong one is a
      silent data loss. Reconcile, or make the choice explicit at each call.
      *(Filed 2026-08-30 from W2.)*
- [ ] `web/packages/core/src/types.ts` — `ProvidersResponse.tenantId` and
      `IdentityProvider.nickname` are populated ONLY by the
      `@realm-id/web-bff-realmid` adapter. A partner BFF following BFF-SPEC
      literally returns neither, so a partner login page reading `tenantId`
      silently gets `undefined`. BFF-SPEC should name both fields on the
      discovery response. *(Filed 2026-08-30 from W2.)*
- [ ] `web/packages/admin/` — three `ui/web/src/api.ts` shims were NOT in the
      W2 move list and still have no SDK resource: `fetchPlatformAuditEvents`
      (`GET /platforms/{id}/audit-events`, ADR-055 — distinct from the
      staff-gated `admin.admin.listEvents`), `listTenantUsers` +
      `TenantUserSummary` (`GET /tenants/{id}/users`, the first page only), and
      `selfEnrollMfa` / `verifyMfa` (`/auth/mfa/{enroll,verify}`, which the new
      `withStepUpRetry` drives internally but does not expose). Wave 4 cannot
      empty `api.ts` without them. *(Filed 2026-08-30 from W2.)*
- [ ] `web/packages/admin/src/types.ts` — still hand-declares wire shapes the
      issuer serves (`PlatformNote`, `ApiKeyListItem`, …) with no drift test of
      any kind, which is the same class of defect W2 just removed for
      `ActiveSession`. Audit the file against `issuer/docs/swagger.yaml`.
      *(Filed 2026-08-30 from W2.)*
> **BOTH SETTLED 2026-08-30, before publish — see `DECISIONS.md` "one key, two
> levels".** ~~Cross-language KEY divergence for a preserved unrecognised error
> code~~ → **`details.server_code` in all three languages**, written into
> `SPEC.md` §3.3. `go` moved, because `SPEC.md` named neither key and its
> `Details["code"]` write had never been released, while `server_code` is read
> by four shipped consumers. The item's premise that "moving either breaks a
> published SDK" was half wrong, and the half that was wrong is what decided it.
> ~~Nested siblings not collected in ts/java~~ → **both levels are collected in
> all three, nested wins a collision.** The item called this a parity gap; it was
> a LIVE defect. GoFr's `createErrorResponse` renders the issuer's merged
> `Response()` map under the top-level `error` field, so EVERY issuer gate
> payload is nested and a ts/java partner driving a step-up against
> `auth.realmid.dev` got an empty `details` — a challenge with no token. Only the
> reference BFF's own envelope puts it beside `error`, which is why the console
> never saw it.

> ~~**`web/BFF-SPEC.md` says nothing about what a PARTNER's BFF must do when it
> relays an issuer error envelope.**~~ **CLOSED 2026-08-30 (W5).** BFF-SPEC
> § Conventions now carries "Relaying an upstream error: preserve BOTH envelope
> levels" — both shapes shown, the flatten-is-silent failure named, and the
> existing readers (`parseErrorEnvelope`, `ParseErrorEnvelope`, `ProxyStatus`)
> pointed at so nobody re-derives one. The code-less GoFr 401 is called out in
> the same place.
- [ ] **The `@realm-id/web` ↔ `@realm-id/sdk` parity gate is a LOCAL-SESSION
      guard that reports nothing in CI.** `web/packages/core/src/envelope.test.ts`
      really does run both implementations over a shared fixture table — but
      `.github/workflows/ci.yml` has no job for `web/packages/*` at all, so it
      never runs on a push. It also stayed GREEN through two real divergences on
      2026-08-30 (the nested-sibling sweep and the legacy-message fallback)
      because its FIXTURE TABLE is hand-maintained and carried neither shape;
      five fixtures were added, which fixes those two cases and not the
      mechanism. Two separate gaps, one item: give it a runner, and derive or
      widen the table. (The missing CI job is also the first item in this file,
      filed 2026-08-28 for the same package — this is the second time it has
      cost something.) *(Filed 2026-08-30 while settling the error contract.)*
- [ ] `web/packages/core/src/stepup.ts` — `parseStepUp` hand-reads the 412
      instead of using `parseErrorEnvelope`, which is why it needed its own
      fix for the nested gate payload on 2026-08-30 after the parser already
      had one. `@realm-id/web` cannot import `@realm-id/sdk` (zero runtime
      deps) but it OWNS `parseErrorEnvelope` in the same package — route
      `parseStepUp` through it so there is one reader of that envelope, not two.
      *(Filed 2026-08-30 while settling the error contract.)*

## Known contract debt

- [ ] **The reference BFF does not follow RealmID's own `BFF-SPEC.md` — ADR
      needed.** `api.realmid.dev` deviates in SIX places (snake_case bodies, a
      status discriminator on `/login`, tokenless `/token`, a flat `/me`, and
      two 412-gated flows: MFA and session-limit), which is why
      `web/packages/bff-realmid` exists at all. The package is a correct
      quarantine of the symptom; the deviation itself is the boundary defect.
      Consequence, and this is the part that matters: the CANONICAL code path in
      `@realm-id/web` — the one every spec-following partner BFF takes — is the
      path RealmID itself never exercises. So the better-tested path is the
      non-canonical one, and a regression in the canonical one gets found by a
      partner, not by us.
      Two ways to close it, and choosing between them IS the ADR: converge the
      reference BFF onto the canonical shape (breaking `ui/`, the CLI's expected
      shapes, and any partner already on the `bff-realmid` preset), or amend
      BFF-SPEC to bless a shape it currently documents as a deviation (which
      makes the adapters permanent and the snake_case/`data`-envelope wire the
      contract). Either way the ADR must say what the canonical path's test
      coverage becomes, because "the reference impl exercises it" stops being
      available under both options.
      **Explicitly OUT OF SCOPE** of the 2026-08-30 SDK dogfooding refactor —
      recorded, not attempted. Numbering note: `issuer/docs/adr/` runs through
      101, so this would be 102+; the ADR belongs in that (private) directory,
      while the partner-visible statement of the problem lives in
      `web/BFF-SPEC.md` § Reference implementation.
      *(Filed 2026-08-30, W5 docs — REVIEW.md item C3.)*

- [ ] `java/src/main/java/dev/realmid/sdk/auth/JwtPeek.java` — THREE private
      unverified-JWT peeks now exist in the Java SDK and none can see the
      others: `tokens/TokensClient.peek` reads `jti`+`exp`,
      `platformtoken/PlatformTokenManager.peekJwtIssuer` reads `iss`, and
      `auth/JwtPeek.subject` reads `sub`. Each was added because the previous
      one was unreachable from the new call site. Consolidate them into one
      package-visible helper (Go has exactly two, `peekJWTUserFields` and
      `peekJWTRevokeFields`, both in one file). Deliberately NOT done inside the
      derived-claims fix — a live-defect fix is the wrong place to move three
      security-adjacent decoders. Any consolidation must keep the "never
      authorize on this" warning attached and must not weaken the malformed-input
      behaviour, which differs per call site today (null vs "" vs null).
      *(Filed 2026-09-01, java `0.44.0`.)*
