# TODO-ARCHIVE — sdk/

Closed, retired or superseded records, kept for traceability. See [`TODO.md`](TODO.md) for open, actionable items.

> ⚠️ **DOWNGRADED 2026-09-02 after validating it against source — this is NOT a
> live defect, and the version below (filed 2026-09-01) was wrong in the way that
> would have cost the most: it prescribed a three-language redesign for a path no
> SDK lane can reach.**
>
> What is TRUE: `narrow()` returns the stored cap unchanged when
> `RolePermissions == nil` (`authsvc/user_api_key_login.go`), and the refresh
> lane passes exactly that. A user-API-key session IS refreshable — `AuthMethod`
> is `user_api_key`, which `isCredentialBootstrapped` does not list, and the class
> is `ClassUser`, so `MintForRefresh` falls through to `MintForTenant`.
>
> What is FALSE: that the SDK middleware widens anything. The capped mint is
> gated on `sess.ViaUserAPIKeyID`, which ONLY the `grant_type=user_api_key`
> exchange sets — and **the SDK has no user-key exchange at all**.
> `user_api_keys.go` is the key MANAGEMENT surface (create/list/update), not a
> login lane. Every session the middleware can create is provider/password/OTP,
> for which `recheckUserKeyForMint` returns nil and the capped mint is never
> taken. So the middleware's refresh cannot widen a cap that cannot exist.
>
> What it actually is: **the specified contract**, not a bug. ADR-100 D6/D18 say
> the operand is optional and absent means unnarrowed, and
> `TestRolePermissions_NarrowTheCapAtMint` pins exactly that as a deliberate
> POSITIVE CONTROL — omit the field on refresh and the cap comes back unnarrowed.
> A "fix" would have to change the ADR and that test, not the SDKs.
>
> The residual hazard, which is real but is a DOCUMENTATION problem: a caller who
> exchanges a user key themselves and then refreshes without re-supplying the
> list gets a wider token than they held. `TokenRequest.RolePermissions` already
> says so in bold ("Supply it on EVERY mint... comes back WIDER"), and RealmID's
> own BFF (`api/internal/middleware/refresh.go:53`) already threads it onto every
> mint including refresh. **Nothing to build.**
>
> ⚠️ It WOULD become live if an SDK user-key exchange were ever added. If you add
> one, the resolver question below becomes real — that is the trigger to watch
> for, not a task to schedule.
>
> ~~Needs a design pass~~ — withdrawn. The design question it posed ("no handler
> configured cannot mean do nothing") only exists on a lane that does not exist.
>
> ✅ The one REAL finding in the original entry is FIXED: the comment at
> `authsvc/user_api_key_login.go` claiming *"this lane is ADR-089
> access-token-only"* was false — the same function mints a refresh token, stores
> its hash and returns it. Corrected in issuer, with the reason recorded.
>
> **Standing lesson (this is the third time):** a TODO's defect description is a
> timestamped CLAIM, not a finding. This one quoted issuer source accurately and
> still reached the wrong conclusion, because it never checked whether the lane it
> blamed could produce the session the defect needs.

> ✅ **CLOSED 2026-09-03 — the derived-claims seam is complete on EVERY lane in
> all three SDKs.** This entry described the refresh hole and said "Not started"
> while `Config.Scopes` and the refresh enrichment were already shipped and
> tested in go/ts/java (`derived_claims_refresh.go`,
> `derived-claims-refresh.test.ts`, `DerivedClaimsRefreshTest`). It had gone
> stale in the direction that costs the most: it would have sent someone to
> rebuild a shipped seam.
>
> The half that WAS still open is now done too. The entry's own line —
> *"`mintProductRoles` has exactly THREE call sites"* — was the hand-maintained
> list that hid it. The lane set is now DERIVED from the package AST
> (`go/derived_claims_lanes_test.go`), and it found **two** uncovered lanes,
> `OTPLogin` and `MFAVerify`/`MFAVerifyOTP`, where the report that prompted the
> guard had named only the second. Fixed and behaviourally tested in all three
> languages. Why + RCA: `DECISIONS.md`, 2026-09-03.
>
> ⚠️ **Still owed to Traide:** they reported the MFA lane and have not been told
> it is fixed, nor that a second lane was found alongside it.


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
> **The `## Docs` section note, archived 2026-09-13 — and its "Empty" claim
> was FALSE by the time anyone read it again.** The closure it reports is
> real and is why it is kept: the `TransferOwnerRequest` schema backfill was
> verified done on 2026-08-03 and removed. What was wrong is the word
> *Empty*. The note sat directly under `## Docs` in `TODO.md`, and **25 open
> items were later appended beneath it** without anyone removing it — so the
> heading carried a standing "nothing here" for weeks while it held most of
> the file's unwrapped-surface work.
>
> Nobody re-read it, because a parenthetical saying "nothing here" is exactly
> the line a reader skips. That is the same mechanism as the cli "Broken
> today" banner (which told sweeps to skip a section for three days after
> three items were filed under it) and the umbrella's "Release gate —
> EXECUTED, except §2" heading (whose §2 was in fact closed). **A
> section-level status claim is a claim with a date on it**, and nothing
> re-checks one when the section changes underneath it.
>
> The original note, verbatim:

*(Empty. The `TransferOwnerRequest` schema backfill was verified done
2026-08-03 and removed.)*
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

## ~~Partner ask (Traide, 2026-09-05) — a post-identity, PRE-MINT hook~~ — CLOSED 2026-09-13, BUILT as `OnIdentityResolved`

> **Option 1 was built and shipped** (go `0.58.0`, ts, java). The section below
> is the ask as filed, kept verbatim for its investigation — which remains the
> best written account of why option 2 was never available.
>
> **What closes it.** `AuthClient.mintProductRoles` (`go/auth.go:658`) fires
> `OnIdentityResolved` BEFORE `resolveProductRoles`/`resolveScopes`, and the
> comment there names this partner's case outright: *"a hook that fired after
> the resolvers would be useless to the partner it exists for — their Scopes
> handler reads the row this hook writes."* The refresh lane does the same
> (`go/derived_claims_refresh.go:82,93`). So the reconciler can seed the mirror
> and the scope resolver reads it within one authentication; the extra
> `/auth/token` round trip on every login can go. The hook lives on
> `Config`/`RealmConfig`/`Realm.Builder` — **never middleware** — so direct
> clients get it too, which the ask's §"Any cross-language hook is therefore a
> NEW three-language surface" correctly predicted it would have to.
>
> **Its four open questions, as answered by what shipped:** the seam now
> exists under the name `OnIdentityResolved`; its error refuses the mint
> UNCONDITIONALLY, with no knob (a caller expresses fail-open by returning
> nil); it is in all three SDKs; and it is NOT retried, so it must be
> idempotent.
>
> **The sharpest criticism in the section was also addressed.** It flagged
> that the ordering was "two adjacent statements with nothing enforcing it"
> and that no test would fail if they were reordered, because the hook and the
> resolver were tested in disjoint universes. `IdentityResolvedOrderingTest`
> now asserts the CAUSAL property — the resolver's return value is *produced
> by* the hook — and is mutation-verified: moving `fireIdentityResolved` below
> `ScopeClaims.resolve` turns it red.
>
> ⚠️ **Two things this does NOT mean, both easy to get wrong.** It is **not**
> literally a pre-mint hook — the first mint IS `POST /auth/login` — so do not
> document it as one. And its guarantee is *once per derived-claims
> resolution*, which is **vacuous on the credential-bootstrapped (api key,
> platform api key) and ADR-057 token-exchange lanes**, where neither the hook
> nor the resolvers run at all. Neither limit touches this partner, whose
> problem is the login lane with a scope resolver.
>
> Design: `docs/design/pre-mint-hook.md`. This does NOT close OQ-4 —
> `OnAuthSuccess` is still Go-only and middleware-only.

## Partner ask (Traide, 2026-09-05) — a post-identity, PRE-MINT hook

**NOT designed, NOT approved, NOT started.** Recorded verbatim in intent so it
is not lost; per this workspace's "discuss new features first" rule the model
and tradeoffs go to the owner before any code.

**Their problem, in their words.** `Config.Scopes` resolves their authorization
claim at MINT time by reading their local `users` row. On a login the mint
happens inside the SDK **before `OnAuthSuccess`**, and their local row is
written by their reconciler INSIDE that hook. So a brand-new user's first login
resolves against a row that does not exist yet and gets a **scope-less token**.
They repair it by re-minting after the reconciler — an extra `/auth/token`
round trip on EVERY login, now a permanent load-bearing piece of their auth
path, which they would like to delete.

**Why they cannot fix it themselves.** `ScopeResolver.Resolve` is contractually
side-effect free because the SDK retries it an unspecified number of times per
mint, so seeding from there would violate that contract N times per login. They
own no earlier seam.

**What would close it (either is sufficient, per them):**
1. A hook firing ONCE per authentication, after the principal's identity and
   tenant are known but BEFORE the first mint, where a relying party may perform
   side effects (write its local mirror) and whose error can FAIL the login; or
2. merely a DOCUMENTED GUARANTEE that `Config.Scopes` is called at least once
   AFTER `OnAuthSuccess` on the login lane.

**INVESTIGATED 2026-09-05 — OPTION 2 IS NOT AVAILABLE.** `Config.Scopes` is
never invoked after `OnAuthSuccess` within a single authentication, on ANY lane,
in ANY of the three SDKs. There is nothing to document; it would have to be
BUILT. Verified by reading the call sites, not inferred:

- **Login / OTP / password / MFA-verify** — the mint (and its scope resolution)
  happens INSIDE `Auth.*`, which returns before the middleware fires the hook:
  `middleware.go:485` → `auth.go:561` → `auth.go:658` `resolveScopes`, with the
  hook only at `middleware.go:505`.
- **Refresh** — the scope-resolving re-mint is an explicit statement ABOVE the
  hook block: `middleware.go:590` `enrichRefreshMint` →
  `derived_claims_refresh.go:82`, hook block starts `middleware.go:598`.
- **Tenant choice / `CompleteLogin`** — the hook NEVER fires: the middleware
  route table (`middleware.go:368-390`) has only Login/Logout/Refresh/MFAVerify,
  so `CompleteLogin` (`auth.go:603`) is a direct-API call the middleware never
  reaches.
- **ADR-057 token exchange** and **credential-bootstrapped (api key / platform
  api key)** — neither the hook NOR the resolver runs at all
  (`credential.go:35,98,150`, `platform_token.go:136-164`). A guarantee worded
  "after `OnAuthSuccess`" would be both vacuous AND misleading here.
- **ADR-089 no-refresh sessions** — the resolver is skipped outright,
  `derived_claims_refresh.go:58-63`, citing ADR-089 by name.

⚠️ **`OnAuthSuccess` is Go-ONLY and middleware-ONLY.** `grep -rin authsuccess
ts/src java/src web` returns ZERO hits; `ts/src/middleware.ts:71` has only
`onAuthFailure`, and `java/.../MiddlewareConfig.java:67-80` exposes no hook
accessor. It is also absent from Go's DIRECT-client path — the field lives on
`MiddlewareOptions` (`go/middleware.go:186`), so a partner using `AuthClient`
without the middleware has no hook on any lane. **Any cross-language hook is
therefore a NEW three-language surface, not an extension of an existing one.**

⚠️ **Their retry constraint is REAL** — `scopes_handler.go:28-33` states
side-effect freedom as a contract, and `product_roles.go:74,76` implements
`productRolesAttempts = 3` with `{50ms, 150ms}` backoff. Seeding from `Resolve`
would run their write up to 3x per mint. They are right that they are stuck.

⚠️ **The refresh ordering is two adjacent statements with nothing enforcing it**
(`middleware.go:590` then `:598`), and **no test would fail if they were
reordered** — verified mechanically: no Go test configures both `Scopes:` and
`OnAuthSuccess:`. `derived_claims_lanes_test.go` and
`middleware_derived_claims_test.go` set the resolver and not the hook;
`middleware_hooks_test.go:66,101,150` set the hook and not the resolver. The two
features are tested in disjoint universes.

**Open questions for the owner before anything is built:**
- Does such a seam already exist under another name? They asked us to say so
  rather than build a second one.
- Is "its error can fail the login" acceptable? That hands a relying party a
  veto over authentication, which is a real availability surface.
- Does this belong in all three SDKs or only the ones with a scope resolver?
- Retry semantics: fire-once-per-authentication is easy to say and hard to
  guarantee across refresh, token exchange and the credential-bootstrapped
  lanes that get no refresh token at all (ADR-089).

They stated explicitly: **no urgency** — they have a working, tested repair.
