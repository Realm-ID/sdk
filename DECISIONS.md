# Decision Log — Realm ID SDK monorepo

The **why** behind changes to `Realm-ID/sdk` — problem, options weighed,
decision, tradeoffs. Terse "what shipped" lives in `CHANGELOG.md`; the locked
behavioural contract lives in `SPEC.md`. This file is the running index of "why
did this change happen."

Newest first.


## Index

64 entries total — 9 here, 55 in [`DECISIONS-ARCHIVE.md`](DECISIONS-ARCHIVE.md). Newest first; archived entries link across to that file.

- [2026-08-27 (latest) — ADR-100 in four SDKs: making the illegal state unrepresentable in four different type systems](#2026-08-27--adr-100-in-four-sdks-making-the-illegal-state-unrepresentable-in-four-different-type-systems)
- [2026-08-25 (latest) — a changelog can be present and unreachable: the order gate, and the entry that never got its number](#2026-08-25-latest--a-changelog-can-be-present-and-unreachable-the-order-gate-and-the-entry-that-never-got-its-number)
- [2026-08-25 — changelog backfill + the DECISIONS.md index/archive split, re-pointed at the real problem file](#2026-08-25--changelog-backfill--the-decisionsmd-indexarchive-split-re-pointed-at-the-real-problem-file)
- [2026-08-25 (later) — the web-admin suite tested a build artifact, and three mutations proved it](#2026-08-25-later--the-web-admin-suite-tested-a-build-artifact-and-three-mutations-proved-it)
- [2026-08-25 — the host `npm test` was broken by the workaround written to work around it](#2026-08-25--the-host-npm-test-was-broken-by-the-workaround-written-to-work-around-it)
- [2026-08-24 (later) — the taxonomy claim was measured, and it was eight codes wrong](#2026-08-24-later--the-taxonomy-claim-was-measured-and-it-was-eight-codes-wrong)
- [2026-08-24 — the changelog gate derives its subjects, and refuses to check nothing](#2026-08-24--the-changelog-gate-derives-its-subjects-and-refuses-to-check-nothing)
- [2026-08-23 (later still) — SPEC §10.4's "backstop" claim is WITHDRAWN (ADR-096 D3)](#2026-08-23-later-still--spec-104s-backstop-claim-is-withdrawn-adr-096-d3)
- [2026-08-23 (later) — tag hygiene extended to ts/java, and the one check that can actually prevent](#2026-08-23-later--tag-hygiene-extended-to-tsjava-and-the-one-check-that-can-actually-prevent)
- [2026-08-23 — the annotated/immutable tag rule was documented for seven weeks and followed by a coin flip](DECISIONS-ARCHIVE.md#2026-08-23--the-annotatedimmutable-tag-rule-was-documented-for-seven-weeks-and-followed-by-a-coin-flip)
- [2026-08-21 (last) — the SDK monorepo had no CI, which is why "add a gofmt gate" was never ten minutes](DECISIONS-ARCHIVE.md#2026-08-21-last--the-sdk-monorepo-had-no-ci-which-is-why-add-a-gofmt-gate-was-never-ten-minutes)
- [2026-08-21 (latest) — TS `listSessions` pages, and the break is deliberate](DECISIONS-ARCHIVE.md#2026-08-21-latest--ts-listsessions-pages-and-the-break-is-deliberate)
- [2026-08-21 (later still) — the last parity gap was a mode the issuer refuses](DECISIONS-ARCHIVE.md#2026-08-21-later-still--the-last-parity-gap-was-a-mode-the-issuer-refuses)
- [2026-08-21 (later) — an SDK E2E suite, and the two defects it found on its first run](DECISIONS-ARCHIVE.md#2026-08-21-later--an-sdk-e2e-suite-and-the-two-defects-it-found-on-its-first-run)
- [2026-08-21 — the Java realm pin, and the device label TS never sent](DECISIONS-ARCHIVE.md#2026-08-21--the-java-realm-pin-and-the-device-label-ts-never-sent)
- [2026-08-06 — wrap both by-id platform reads; two "blocked on a repack" items were already shipped](DECISIONS-ARCHIVE.md#2026-08-06--wrap-both-by-id-platform-reads-two-blocked-on-a-repack-items-were-already-shipped)
- [2026-08-05 — the Go `Version` const drifted a third time; the fix is the check, not the bump](DECISIONS-ARCHIVE.md#2026-08-05--the-go-version-const-drifted-a-third-time-the-fix-is-the-check-not-the-bump)
- [2026-08-03 — the browser SDK's `MeMembership` catches up to `/me`, and the changelog catches up to the versions (web-admin `0.8.18`)](DECISIONS-ARCHIVE.md#2026-08-03--the-browser-sdks-memembership-catches-up-to-me-and-the-changelog-catches-up-to-the-versions-web-admin-0818)
- [2026-08-03 — `acceptInvitation` ships with the tests the feature commit skipped (go `0.44.0`, ts `0.35.0`, java `0.34.0`)](DECISIONS-ARCHIVE.md#2026-08-03--acceptinvitation-ships-with-the-tests-the-feature-commit-skipped-go-0440-ts-0350-java-0340)
- [2026-08-02 — dropping `allowedDomains`: a removed field is safer than a stale one (go `0.43.0`, ts `0.34.0`, java `0.33.0`, web-admin `0.8.17`)](DECISIONS-ARCHIVE.md#2026-08-02--dropping-alloweddomains-a-removed-field-is-safer-than-a-stale-one-go-0430-ts-0340-java-0330-web-admin-0817)
- [2026-08-02 — on-behalf-of reaches the typed surface by DERIVING a client (ts `0.33.0`, java `0.32.0`)](DECISIONS-ARCHIVE.md#2026-08-02--on-behalf-of-reaches-the-typed-surface-by-deriving-a-client-ts-0330-java-0320)
- [2026-07-30 — ADR-092 surface: a `me` namespace, and the picker is not an error](DECISIONS-ARCHIVE.md#2026-07-30--adr-092-surface-a-me-namespace-and-the-picker-is-not-an-error)
- [2026-07-28 — cookie shadowing: read every candidate, and evict the twin](DECISIONS-ARCHIVE.md#2026-07-28--cookie-shadowing-read-every-candidate-and-evict-the-twin)
- [2026-07-28 — web-admin 0.8.16: publish permissions, not a marker to expand](DECISIONS-ARCHIVE.md#2026-07-28--web-admin-0816-publish-permissions-not-a-marker-to-expand)
- [2026-07-27 — ADR-089's doc debt: the spec still described the refresh step it deleted](DECISIONS-ARCHIVE.md#2026-07-27--adr-089s-doc-debt-the-spec-still-described-the-refresh-step-it-deleted)
- [2026-07-26 — the missing `/internal` export: why the UI reimplemented a client we shipped](DECISIONS-ARCHIVE.md#2026-07-26--the-missing-internal-export-why-the-ui-reimplemented-a-client-we-shipped)
- [2026-07-26 — the api-key `label` asymmetry: a known quirk is not the same as a decision](DECISIONS-ARCHIVE.md#2026-07-26--the-api-key-label-asymmetry-a-known-quirk-is-not-the-same-as-a-decision)
- [2026-07-24 — web-admin transport must not relabel client-side auth errors as `network` (0.8.11)](DECISIONS-ARCHIVE.md#2026-07-24--web-admin-transport-must-not-relabel-client-side-auth-errors-as-network-0811)
- [2026-07-23 — cross-realm integrations surface; the mint returns an access token only](DECISIONS-ARCHIVE.md#2026-07-23--cross-realm-integrations-surface-the-mint-returns-an-access-token-only)
- [2026-07-22 — role `assignable_to` + `can_invite_roles` typed into go/ts/java](DECISIONS-ARCHIVE.md#2026-07-22--role-assignable_to--can_invite_roles-typed-into-gotsjava)
- [2026-07-22 — `web-admin` 0.8.9: starter roles (issuer v0.54.0)](DECISIONS-ARCHIVE.md#2026-07-22--web-admin-089-starter-roles-issuer-v0540)
- [2026-07-21 — GET config + GET platform stats typed into go/ts/java](DECISIONS-ARCHIVE.md#2026-07-21--get-config--get-platform-stats-typed-into-gotsjava)
- [2026-07-20 — ADR-080 Phase B + session-revoke + MFA-self typed parity (all 4 SDKs)](DECISIONS-ARCHIVE.md#2026-07-20--adr-080-phase-b--session-revoke--mfa-self-typed-parity-all-4-sdks)
- [2026-07-16 — fix: Java `tenants().create` diverged from the contract (route + body)](DECISIONS-ARCHIVE.md#2026-07-16--fix-java-tenantscreate-diverged-from-the-contract-route--body)
- [2026-07-16 — feat: federation-bindings client in all three SDKs (S-06, ADR-057)](DECISIONS-ARCHIVE.md#2026-07-16--feat-federation-bindings-client-in-all-three-sdks-s-06-adr-057)
- [2026-07-16 — feat: IdP discovery surface ported to TS + Java (S-05, SPEC §6.10)](DECISIONS-ARCHIVE.md#2026-07-16--feat-idp-discovery-surface-ported-to-ts--java-s-05-spec-610)
- [2026-07-16 — feat: list filters (role/status/q on users, status on invitations) across all SDKs (S-07)](DECISIONS-ARCHIVE.md#2026-07-16--feat-list-filters-rolestatusq-on-users-status-on-invitations-across-all-sdks-s-07)
- [2026-07-16 — feat: `users.importUsers` ported to Go + Java (S-03, ADR-073 Release B)](DECISIONS-ARCHIVE.md#2026-07-16--feat-usersimportusers-ported-to-go--java-s-03-adr-073-release-b)
- [2026-07-16 — feat: owner-transfer optional params across all three SDKs (WP6, ADR-076)](DECISIONS-ARCHIVE.md#2026-07-16--feat-owner-transfer-optional-params-across-all-three-sdks-wp6-adr-076)
- [2026-07-16 — feat: Java `tenants.updateUserRole` parity (S-04)](DECISIONS-ARCHIVE.md#2026-07-16--feat-java-tenantsupdateuserrole-parity-s-04)
- [2026-07-15 — fix: TS + Java `auth.login` wire body diverged from the issuer contract (S-01/S-02)](DECISIONS-ARCHIVE.md#2026-07-15--fix-ts--java-authlogin-wire-body-diverged-from-the-issuer-contract-s-01s-02)
- [2026-07-15 — SPEC.md rewritten to current surface (doc sweep)](DECISIONS-ARCHIVE.md#2026-07-15--specmd-rewritten-to-current-surface-doc-sweep)
- [2026-07-15 — ADR-075: role `required_mfa_methods` write surface](DECISIONS-ARCHIVE.md#2026-07-15--adr-075-role-required_mfa_methods-write-surface)
- [2026-07-14 — ADR-074: `roles.listPermissions()` + delete `migrate_to`](DECISIONS-ARCHIVE.md#2026-07-14--adr-074-roleslistpermissions--delete-migrate_to)
- [2026-07-14 — Realign Go `const Version` to the module tag (`go/v0.30.0`)](DECISIONS-ARCHIVE.md#2026-07-14--realign-go-const-version-to-the-module-tag-gov0300)
- [2026-07-14 — ADR-073 Release B: `users.importUsers` (`@realm-id/web-admin` 0.8.3)](DECISIONS-ARCHIVE.md#2026-07-14--adr-073-release-b-usersimportusers-realm-idweb-admin-083)
- [2026-07-14 — ADR-073 Release A: `PlatformCreate.domain` optional (`@realm-id/web-admin` 0.8.2)](DECISIONS-ARCHIVE.md#2026-07-14--adr-073-release-a-platformcreatedomain-optional-realm-idweb-admin-082)
- [2026-07-14 — ADR-071/072 WP8: web-admin service-accounts + sources surface (`@realm-id/web-admin` 0.8.0)](DECISIONS-ARCHIVE.md#2026-07-14--adr-071072-wp8-web-admin-service-accounts--sources-surface-realm-idweb-admin-080)
- [2026-07-14 — ADR-071/072 WP6: ts + java parity port (ts 0.20.0 · java 0.18.0)](DECISIONS-ARCHIVE.md#2026-07-14--adr-071072-wp6-ts--java-parity-port-ts-0200--java-0180)
- [2026-07-14 — ADR-071/072 WP5: service accounts + OTP-login cutover + sources (go reference)](DECISIONS-ARCHIVE.md#2026-07-14--adr-071072-wp5-service-accounts--otp-login-cutover--sources-go-reference)
- [2026-07-13 — roles enable/disable + owner signing-keys client (go/v0.28.0 · ts 0.19.0 · java 0.17.0 · web-admin 0.7.1)](DECISIONS-ARCHIVE.md#2026-07-13--roles-enabledisable--owner-signing-keys-client-gov0280--ts-0190--java-0170--web-admin-071)
- [2026-07-11 — `is_base` on `MeMembership` (`@realm-id/web-admin@0.6.1`)](DECISIONS-ARCHIVE.md#2026-07-11--is_base-on-memembership-realm-idweb-admin061)
- [2026-07-10 — surface `idle_ttl` from login/token/refresh (ADR-070 idle session timeout)](DECISIONS-ARCHIVE.md#2026-07-10--surface-idle_ttl-from-logintokenrefresh-adr-070-idle-session-timeout)
- [2026-07-10 — SPEC §3: document the uniform-200 success/envelope contract (issuer ADR-069)](DECISIONS-ARCHIVE.md#2026-07-10--spec-3-document-the-uniform-200-successenvelope-contract-issuer-adr-069)
- [2026-07-09 — `refresh_exp` on the wire (SPEC §4.1) + drop the dead `Origin.DetachedAt`](DECISIONS-ARCHIVE.md#2026-07-09--refresh_exp-on-the-wire-spec-41--drop-the-dead-origindetachedat)
- [2026-07-08 — `SessionInfo` last-used timestamp reconciled to the issuer's `last_seen_at` field (Go / TS / Java)](DECISIONS-ARCHIVE.md#2026-07-08--sessioninfo-last-used-timestamp-reconciled-to-the-issuers-last_seen_at-field-go--ts--java)
- [2026-07-05 — `@realm-id/web@0.4.5`: `resolveTenant()` — complete a tenant-picker gate without re-running the provider redirect](DECISIONS-ARCHIVE.md#2026-07-05--realm-idweb045-resolvetenant--complete-a-tenant-picker-gate-without-re-running-the-provider-redirect)
- [2026-07-05 — `go/v0.25.0`: retire the deprecated `method` login field on the RIGHT hop (ADR-051)](DECISIONS-ARCHIVE.md#2026-07-05--gov0250-retire-the-deprecated-method-login-field-on-the-right-hop-adr-051)
- [2026-07-05 — `web-bff-realmid@0.3.6`: revert 0.3.5 — the web SDK migration targeted the wrong hop](DECISIONS-ARCHIVE.md#2026-07-05--web-bff-realmid036-revert-035--the-web-sdk-migration-targeted-the-wrong-hop)
- [2026-07-05 — `web-bff-realmid@0.3.5`: migrate login off the deprecated `method` field to `grant_type`](DECISIONS-ARCHIVE.md#2026-07-05--web-bff-realmid035-migrate-login-off-the-deprecated-method-field-to-grant_type)
- [2026-07-05 — `web-bff-realmid@0.3.4`: bump forced by a fix that shipped without a version bump](DECISIONS-ARCHIVE.md#2026-07-05--web-bff-realmid034-bump-forced-by-a-fix-that-shipped-without-a-version-bump)
- [2026-07-04 — Purge partner identifiers + private-repo references from the public SDK repo (working tree + history)](DECISIONS-ARCHIVE.md#2026-07-04--purge-partner-identifiers--private-repo-references-from-the-public-sdk-repo-working-tree--history)
- [2026-07-01 — `restore()` must send the session bearer; tokenless sessions outlive the access-TTL (web/v0.4.4)](DECISIONS-ARCHIVE.md#2026-07-01--restore-must-send-the-session-bearer-tokenless-sessions-outlive-the-access-ttl-webv044)
- [2026-06 — session-limit 412 gate: collect the issuer's nested-error siblings](DECISIONS-ARCHIVE.md#2026-06--session-limit-412-gate-collect-the-issuers-nested-error-siblings)

## 2026-08-27 (latest) — ADR-100 in four SDKs: making the illegal state unrepresentable in four different type systems

**Problem.** A user API key's authority was expressed by the ABSENCE of a
field. `{ "label": "x" }` — the body every one of these SDKs produced when the
caller named no permissions — minted a key carrying the holder's FULL authority.
That shape was ALSO the only way to ask for an unrestricted key deliberately, so
no server-side check could refuse the accident without refusing the intent. The
fix has to be on the wire, and therefore in every client at once.

**Decision.** `uncapped` is required, and — the part that actually matters —
each SDK expresses "the caller did not say" in its own idiom rather than
defaulting.

- **TS**: `uncapped: boolean`, no `?`, spread UNCONDITIONALLY through a single
  `writeBody()`. A conditional spread is the file's own idiom for every
  neighbouring field, and `false` is exactly what it drops.
- **Go**: `Uncapped *bool` with **no `omitempty`**. Pointer so nil is
  distinguishable; no `omitempty` so nil marshals to JSON `null` and reaches the
  server, which answers `400`. Either half alone would have re-hidden the state.
- **Java**: `UserAPIKeyCreate.of(label)` **deleted**, not adapted. It passed four
  nulls and produced the illegal body; the compile error is the deliverable.
  `capped(label, perms)` and `uncapped(label)` replace it — two factories for two
  states, and no third.
- **web-admin**: nothing, by design. It re-exports and owns no types, and the
  one existing create-body assertion was the right place to pin the new field.

**Options weighed.** A server-side default of `uncapped: false` was rejected:
every existing caller would silently start minting keys that mint nothing, and
the failure would surface at token-exchange time in a different repo. A separate
boolean COLUMN alongside the array was rejected in the ADR for the same family
of reason — two encodings for one idea drift.

**Tradeoff accepted.** Four breaking SDK releases at once, plus a Java
positional record widening that breaks direct `new UserAPIKey(...)` calls. It is
affordable exactly once: prod holds zero user API keys and always has, so no
partner is minting today. That window closes the first time someone does.

**Also deleted: `scopes.remove`** (TS and web-admin; go and java never wrapped
it). Not reduced to one mode — deleted. Retiring a scope is self-healing once
the partner supplies `role_permissions` at every mint: stop emitting the string,
map no route to it, and a stale cap entry never survives an intersection again.
Removing the endpoint also settles the storage CHECK, because nothing is left
that can write an empty cap. Its five tests went with it, and the realm-id-default
test that happened to drive `remove` was re-pointed at `rename` rather than
dropped — it was never about removal.

**What is deliberately NOT cleaned up.** Every SDK still denies on a
PRESENT-but-empty `permissions_cap` claim, a state the issuer can no longer
produce. Each of those assertions now carries a comment saying so, at both ends,
because the next reader will otherwise correctly identify it as dead code and
tidy it away — and it is not dead: it is what a garbled or hostile claim off the
wire lands on, where the only safe reading is "capped to nothing".

## 2026-08-25 (latest) — a changelog can be present and unreachable: the order gate, and the entry that never got its number

**Problem.** `scripts/changelog-hygiene.sh` landed on 2026-08-24 after three
packages silently lost changelog history, and it gates exactly one thing: the
version being published has a `## ` heading. That says nothing about where the
heading SITS. Found by hand on 2026-08-25 while verifying the backfill it
enabled: `ts/CHANGELOG.md`'s `0.36.0` (2026-08-06) sat between `0.29.0` and
`0.28.0`, six releases out of descending order.

**Why that is the same defect and not a cosmetic one.** A reader scanning a
descending changelog stops at the first heading below the version they want. A
heading in the wrong place is therefore invisible in exactly the way a MISSING
heading is — *present and unreachable reads the same as absent* — which is the
fault the script's own header describes at length. It is also why the seven-entry
backfill could only be spot-checked by `grep`: there was no gate to run.

**Decision: an `order` mode, and it runs in `ci.yml`, not in the publishers.**
Placement is the substantive call. The three existing modes fire at publish
time, so `java/CHANGELOG.md` would be order-checked only on a Maven release and
a misplaced heading could sit for weeks. Order is a property of the file at all
times, so it belongs on every push.

**The root `CHANGELOG.md` is deliberately NOT checked, and that was measured
rather than assumed.** Its headings name up to three languages at once
(`… go 0.47.0 · ts 0.39.0 · java 0.37.0`), so there is no single version to
order by — and **15 of its 64 headings carry no date either**, so date order is
not available as a fallback. There is no total order to assert over that file.
Asserting one anyway would mean inventing a rule the file has never followed,
and a gate that fails on correct input teaches people to bypass it — worse than
no gate. Written into the script so the next reader does not "fix" the omission.

**It found a second defect the same minute, one degree worse than the first.**
`ts/CHANGELOG.md` ended with `## Unreleased` — below `0.14.0`, at the bottom of
the file. It is not unreleased: it is a released entry that never got its
number. Identified as **`0.13.0`** on three agreeing pieces of evidence: the
monorepo `CHANGELOG.md`'s *"Go + TS — token manager + refresh_invalid + api-key
DTO (2026-05-28)"* names the release `ts-v0.13.0`; `0.13.0` is absent from the
file, whose lowest entry is `0.14.0`; and the block already sat directly beneath
`0.14.0`, exactly where `0.13.0` belongs.
**One thing does not agree and is left standing rather than smoothed over:** the
draft cites SPEC v0.7.0 while the released entry cites v0.8.0 — a draft written
before the SPEC bump and finished in the other file. The heading takes the
number and date from the released entry; the prose is NOT rewritten to match,
because that would be inventing a record instead of recovering one. The
uncertainty is stated in the entry itself.

**`## Unreleased` is accepted only as the FIRST heading**, which is the
convention it belongs to. Anywhere else it is precisely what it was here.

**Mutation-verified**, not merely observed green: restoring the pre-fix
`ts/CHANGELOG.md` makes the gate name `0.36.0` at its exact line and the
`0.29.0` it sits below.

**A latent defect in `ci.yml` was verified and fixed on the way.** The taxonomy
job's comment says *"`set -e` is deliberately OFF for the run itself"* and then
writes only `set -uo pipefail` — which does not clear the `-e` that a `run:`
step's `bash -e {0}` shell already has in force. Verified, not reasoned:
`bash -e -c 'set -uo pipefail; false; rc=$?; echo reached'` prints nothing. So
on every drift that job has ever detected, the summary it exists to write was
skipped. The gate still failed correctly, which is why nothing ever showed. The
comment described the intent; the code did the opposite. `set +e` added to both
that step and the umbrella's new one.

## 2026-08-25 — changelog backfill + the DECISIONS.md index/archive split, re-pointed at the real problem file

**Problem 1.** `ts/CHANGELOG.md` was missing entries for `0.29.0`–`0.35.0`
(seven releases) and `java/CHANGELOG.md` was missing `java-v0.34.0`, both
recorded as open items in `TODO.md` since `scripts/changelog-hygiene.sh`
closed the mechanism that let it happen (2026-08-24) but did not backfill
history.

**Resolved.** All eight entries backfilled from their release commits
(`ffa935c`, `a512679`, `b6c9ad0`, `52f4eb1`, `398c3ef`, `5f44408`, `1b5e1c0`
for ts; `1b5e1c0` for java), cross-checked against the matching entries
already present in `../CHANGELOG.md` — which had the full cross-language
writeup for every one of these releases, so nothing here is invented. The
stale "Gap notice" blockquote in `ts/CHANGELOG.md` is removed with it.

**Problem 2.** `TODO.md` carried an item asking for an index + archive split
on `DECISIONS.md`, last measured at 2,261 lines. Re-measuring before acting
found two things wrong with the item itself: the number had drifted to 2,480,
and — the bigger miss — `issuer/DECISIONS.md` was 11,565 lines / 198 entries
the same day, 4.6× larger, and named in no item anywhere. The filed file was
not the problem file.

**Resolved.** Both files now carry the `decision-log`-skill treatment: a
one-line-per-entry index under the H1 (archived entries link into
`DECISIONS-ARCHIVE.md`), and an archive split by date. `sdk/DECISIONS.md`
→ 1,285 lines main / 1,274 archive lines (22 entries kept, from
2026-08-25 back to 2026-07-27; 39 archived). `issuer/DECISIONS.md` →
3,183 / 8,598 (46 kept back to 2026-08-08; 152 archived). Entries were
**moved, never reworded** — verified two ways per repo: every original `## `
heading present in exactly one of the two post-split files (sorted-list
diff), and every entry's body text byte-identical to the pre-split original.
No entry lost; a link into the old single file still resolves via the index.

**Not changed:** `sdk/TODO.md`'s own item text is corrected in place rather
than closed-and-refiled, per the file's convention (`> ~~...~~` blockquote
carrying what was verified).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

## 2026-08-25 (later) — the web-admin suite tested a build artifact, and three mutations proved it

**Found while closing a TODO that turned out to be false.** `sdk/TODO.md` said
`web-admin` needed `scopes.remove` to match `scopes.rename`. It did not:
`web/node_modules/@realm-id/sdk` is a **symlink to `../../../ts`**, so
`web-admin` re-exports the ts `ScopesClient` and `remove` arrived with ts
`0.40.0`. The item was filed from the shape of the `rename` release rather than
from the package — the same "verify the artifact, not the workaround's absence"
lesson this repo has now recorded three times.

**What was genuinely missing was a test.** No test in this package went through
`createAdmin` at all, so a handle that dropped `scopes`, passed the wrong realm
id, or lost the `/api` prefix would have shipped green — and `0.8.20`'s
changelog asserts exactly that wiring.

**Then the new tests failed to fail.** Three deliberate mutations to
`ts/src/scopes.ts` — remove's path repointed at `/rename`, `dry_run` moved from
query to body, `on_empty` dropped — **all left the suite green**. The cause is
the `exports` map: `@realm-id/sdk/internal` resolves to `dist/internal.js`, so
this suite tests a **build artifact**, and nothing kept it current. `dist/` was
hours stale, so the mutations were never in the code under test.

This is `stack.sh test` running against an unrebuilt api image (issuer
`DECISIONS.md`, 2026-08-25) one layer over, in JS. **Fourth instance of the same
family in two days: the guard is fine and the RUNNER reports success for work it
never did.** The recurring tell is that green costs nothing to obtain.

**Decision — `pretest` rebuilds the dependency, rather than a documented "run
`npm run build` in ts first".** A written prerequisite is a hand-maintained
subject list with one entry, and this workspace's standing finding is that those
decay. Verified by re-running the M1 mutation with **no manual build**: 3 red,
exit 1; clean tree green.

Also rejected: pointing `exports` at `src/`. It would make the tests honest and
the PUBLISHED package wrong — consumers get `dist/`, so testing `src/` would
stop testing what ships.

Five tests, each mutation-verified (M1 remove-path → 3 red · M2 dry_run
query→body → 1 · M3 on_empty dropped → 1 · M4 realm-id default → 1 · M5 dry_run
always sent → 4). web-admin 58 pass / 0 fail; the `web` workspace green
throughout.

## 2026-08-25 — the host `npm test` was broken by the workaround written to work around it

**Symptom.** `npm test` in `sdk/ts` failed on the macOS host with *"You installed
esbuild for another platform"* — **0 pass / 30 fail, on a clean HEAD**. The tree
held `@esbuild/linux-arm64` and nothing else, while the lockfile lists every
platform as an optional dependency. Measured 2026-08-24; the suite is 221/0 in
Docker, so a green CI and a red laptop disagreed about the same commit.

**Root cause.** A container `npm ci` ran over the **bind-mounted host tree**, so
the linux binary replaced the darwin one. The tracker recorded this as
compose damage and prescribed *"shadow `node_modules` in compose, as the
2026-07-27 `ui/web` rollup fix did"* — and **that shadow was already in place**:
`tests/docker-compose.test.yml`'s `sdk-e2e-ts` mounts a named volume at
`/work/sdk/ts/node_modules`, and has since `dbeeb75`, the commit that introduced
the service. Its comment names this exact hazard. Compose could not have done it.

What did it is the recipe people reach for **when there is no compose service** —
the one the TODO itself published as the remedy:

    docker run --rm -v "$(pwd)":/w -w /w node:22-alpine npm ci && npm test

That bind-mounts the package with no shadow. **The documented workaround was the
defect**, and the prescribed fix was already shipped, so following the entry
would have produced no change and left the tree broken.

**Reproduced, not argued.** Host `darwin-arm64` → one run of the recipe above →
host `linux-arm64`. Then repaired and re-run under the new script → host stays
`darwin-arm64`, suite 221/0 in the container. Four measurements, both directions.

**Why it wasn't caught.** Nothing observes the host tree. The unit suite runs in
CI on linux, where a linux-only `node_modules` is correct, so the only surface
that can see the breakage is a developer's laptop — and the damage is silent at
write time and only surfaces on the *next* host run, by which point the container
run that caused it is far away. The dating is what closed it: `node_modules` and
`package-lock.json` share an mtime of 2026-08-24 19:11, inside the session that
ran the recipe.

**Fix.** `scripts/npm-in-docker.sh <package-dir> [npm args...]` — bind-mounts the
package, shadows `node_modules` with a per-package named volume, runs `npm ci`
into the shadow, then the requested npm command. The shadow now lives **wherever
an npm command meets a bind mount**, not only in compose, which is the property
that was actually missing. The host tree was reinstalled; `npm test` is 221/0 on
macOS again.

**Prevention.** The script replaces the recipe in `sdk/TODO.md` and
`ts/README.md`, so the written remedy is no longer the cause. It handles
SELF-CONTAINED packages only and **refuses the `web` workspace outright** rather
than half-running it: measured, `web` as a target fails web-admin's pretest with
`ENOENT /ts/package.json` (the sdk symlink points above the mount), then runs the
other three workspaces anyway and exits 254 — a partial run under a non-zero
code, the shape that gets skimmed as "noisy but passing". The web tree needs no
native binaries, so the host is the right place for it. A regression *test*
was considered and rejected: asserting "a container run leaves the host tree
alone" requires a docker-in-test harness to prove a property that is now
structural (there is no unshadowed mount left to exercise), and the guard would
cost more than the class it protects. Stated rather than skipped silently.

## 2026-08-24 (later) — the taxonomy claim was measured, and it was eight codes wrong

**Problem.** `sdk/TODO.md` asked whether `platform_not_found` should join the
`ErrorCode` taxonomy, and argued: *"Consistent across the three SDKs, so no
language is the outlier; that is why it reads as intentional and may be."*

**The premise was false twice over.**

1. **Consistency is not evidence of intent.** The three lists are hand-maintained
   from one SPEC, so a single omission propagates identically to all three.
   Agreement between them is exactly what a shared oversight looks like; it can
   never distinguish a decision from a miss.
2. **They were not consistent.** Measured: Go lacked six codes ts and Java had
   carried since ADR-071/072; ts and Java both lacked `mfa_registration_required`,
   which Go has had since ADR-061. Eight codes, in both directions.

The taxonomy also already held **six** entity-specific `*_not_found` codes, so
the alternative the item offered — "document that platform-scoped 404s normalize
deliberately" — was not a coherent rule either. It would have been an exception
by decree, with nothing for the next `*_not_found` to follow.

**Decision 1 — register it, and close the whole gap rather than the one code.**
Shipping `platform_not_found` "in lockstep" while eight codes stayed out of
lockstep would have been the ceremony without the substance.

**Decision 2 — `not_service` is NOT propagated.** ts and Java declare it; no
issuer handler emits it (the only near-match is the distinct
`role_not_service_typed`). A code with no producer is a phantom, and adding a
third copy spreads one. It is a reviewed exception in the parity gate, carrying
its reason, and removing it from ts/Java is filed rather than smuggled into a
release about something else.

**Decision 3 — accept the break, and name the migration.** A caller matching
`not_found` on a platform route now stops matching. That is behaviour-breaking
even though the change is purely additive to a union, so all three changelogs
say BREAKING and give the remedy — match both, which is already the idiom the
sibling codes use. Zero first-party consumers branch on `not_found` for a
platform route; the exposure is external partners, and the cost of leaving it is
a taxonomy nobody can reason about.

**What registration BROKE, and why the existing test mattered more than the new
ones.** A registered code lands in `RealmError.Code` and is never copied into
the envelope siblings; an unregistered one survives only in the siblings. Go's
`mapServiceAccountErr` and `mapSourceErr` read only the siblings, via
`detailCode` — so the day their codes became canonical they stopped matching,
and stopped **silently**: the call returns a bare `*RealmError` and
`errors.Is(err, ErrSourceNotFound)` goes false at every call site with nothing
logged. `TestServiceAccounts_HandleTakenMapsSentinel` caught it on the first
run. `integrations.go` had already hit this exact thing and fixed it inline with
a comment; that inline fix is now the named, shared `specificCode` helper, so
the next code to be registered does not re-earn the bug.

**Decision 4 — the gate is a separate CI job reading all three languages.** The
drift is invisible from inside any single language's suite, because each list is
individually self-consistent — which is precisely how it survived. The script
also checks Go's `knownCodes` map against Go's own const block (a second
hand-maintained list in one file, where a const that never reaches the map is
registered in name only), and refuses to pass when it parses implausibly few
codes: a regex that quietly stops matching would otherwise report perfect parity
across three empty sets. Five mutations; one found that the ts anchor matched
`ErrorCodeX` as a prefix and kept parsing a renamed union.

**Not done: `web-admin`.** Its browser transport keeps a **separate** 33-code
list against ts's 60, so the admin console still normalizes `platform_not_found`
— and 26 others. That is a bigger, older drift with its own release path
(a repack + re-vendor into `ui/`), and folding it in here would have hidden it
inside a release about something else. Filed.

## 2026-08-24 — the changelog gate derives its subjects, and refuses to check nothing

**Problem.** Three packages independently lost changelog history (`ts`
`0.29.0`–`0.35.0`, `web-admin` `0.8.13`–`0.8.17`, `java` `java-v0.34.0`). Two
TODO items proposed backfilling the entries. Backfilling is the wrong first
move: nothing failed when a release skipped its entry, so the next release skips
again and the backfill is re-earned. The mechanism goes first; the backfills stay
open and can no longer grow.

**Decision 1 — the subject list is the filesystem, never a list in the script.**
`npm` mode globs `web/packages/*` and adds `ts/`. This workspace has been burned
repeatedly by guards whose subject list was hand-maintained (root `TODO.md`, the
2026-08-02 sweep: three findings in one day, every one a check whose subjects
were enumerated by hand). The cost of deriving is that the gate sees packages the
publish workflow does not — which is the point, and is what it found: two
non-private packages, `@realm-id/web-firebase` and `@realm-id/web-google`,
versioned `0.4.0` and **404 on the npm registry across every version**, absent
from the workflow's `for pkg in core react bff-realmid admin` loop.

**Decision 2 — record "not published" in the package, not in the omission.**
Both are marked `"private": true` rather than special-cased in the gate. npm
itself then refuses to publish them, and the fact stops depending on a name
being missing from a `for` loop in a YAML file. They are genuinely superseded:
`realm.signIn(type)` in `@realm-id/web` reads the provider's public config from
`realm.providers()` and needs no adapter package. `web/README.md` had been
telling partners to install exactly one of the two — an `npm i` that 404s — and
its "Release status (2026-06-03)" block still claimed the whole `0.4.0` line was
unreleased. Corrected against the registry, not against the repo.

**Decision 3 — a missing CHANGELOG.md is a failure, not a skip.** Three web
packages had none at all. Treating that as "this package doesn't keep one" is
how fourteen published versions went unrecorded without ever looking wrong. All
three are seeded from their current version, each stating plainly where the
earlier history is (`git log`, and for `bff-realmid` the monorepo changelog's
own `web-bff-realmid/v0.3.x` headings). **Nothing is reconstructed from commit
subjects and presented as a record**, and the `bff-realmid` entries are NOT
copied out of the monorepo file — two copies of one changelog is the mechanism
that lost `web-admin` `0.8.13`–`0.8.17` in the first place.

**Decision 4 — `go` is gated even though its remedy comes late.** The module
publishes by tag push, so the check necessarily runs after release. Unlike the
`Version`-const check, that is acceptable here: prose is not immutable the way a
module hash is, so a red gate means "write the entry", never "re-point the tag".

**What the mutations were worth.** Seven were run; six confirmed the intended
check. The seventh found a defect in the gate itself: with the derivation
returning nothing, `set -u` aborted on the empty array *before* the "inspected 0
packages" guard could run — exit 1 with no diagnosis, in exactly the case that
guard exists for. A zero-subject guard placed after the loop it protects cannot
fire. Moved above it; both empty cases (no directories, all directories private)
now exit 2 with a distinct message.

## 2026-08-23 (later still) — SPEC §10.4's "backstop" claim is WITHDRAWN (ADR-096 D3)

§10.4 said: *"The server's `RequireMFA(pattern, opts)` registry is the backstop
for non-SDK callers."*

Under ADR-096 D2 that is not merely unimplemented, it is **impossible**: the
route→policy map lives in the enforcing backend, RealmID stores no list of a
partner's operations, and **you cannot back-stop a policy you do not hold**.

Corrected rather than left standing, because the sentence is load-bearing in the
wrong direction: the next reader designs against a guarantee that is not there
and ships an unenforced gate. The replacement says what the issuer registry
actually is — the gate for RealmID's OWN auth-surface operations, where RI is
the enforcing party — and points a non-SDK adopter at
`issuer/docs/partner-integration-guide.md` §5.1, which now carries the HTTP-level
contract they need.

No package version moves: this is a SPEC edit with no behavioural change in any
language SDK.

## 2026-08-23 (later) — tag hygiene extended to ts/java, and the one check that can actually prevent

Both residuals filed earlier today were decided by the repo owner and shipped:
`annotated-prepublish` wired into `publish-npm.yml` and `publish-maven.yml`, and
`unreleased-go` wired into the CI Go job.

### ts/java: the ORDERING mattered more than the decision

The filed question was whether to enforce annotation on `ts-v*` / `java-v*` at
all, given npm and Maven Central are immutable by policy so a moved tag costs
provenance rather than correctness. Answer: enforce.

Wiring it exposed something the question had not: **for these two, the check runs
BEFORE anything is published**, because the tag merely triggers a publisher. So a
lightweight tag is still the operator's to fix — delete it, re-cut with `-a`,
push. That is the exact opposite of `go/v*`, where the tag IS the release and the
only remedy is the next patch version.

Printing Go's remedy here would tell an operator to burn a version number for a
tag they could simply recut. Hence a separate `annotated-prepublish` mode whose
sole difference is the remedy it prints, with the caveat that a re-RUN after a
partial publish must not delete the tag. The check is the FIRST step in both
publish jobs so that the "nothing has been released yet" premise it states is
actually true.

### `unreleased-go`: a policy, adopted knowingly

`tag-hygiene.sh unreleased-go` runs on main and every PR: if `const Version` is
`V` and `go/vV` exists and `go/` differs from that tag, it fails and says to bump
the const before merging.

This is the only check in the repo that can prevent rather than report, and it is
aimed at the root shape of the 2026-07-05 incident — a tree changed, the version
did not, and the "fix" was to move the tag. The two tag-time checks cannot help
there: by the time either runs, the tag exists and the proxy may have served it.

**Its cost is a workflow policy and was accepted as one:** after a release, the
first PR touching `go/` goes red until someone bumps the const. That is not a
side effect to apologise for — the skipped bump is the defect. It was filed as a
decision rather than shipped with the earlier work precisely because it changes
how every Go PR merges.

Mutation-verified against the real tree rather than a fixture: declaring the
already-released `0.44.0` makes it fail and print the 12 files that have changed
since that tag. With today's unreleased `0.45.0` it passes, correctly, because
nothing is tagged under it.

`actionlint` and `shellcheck` clean; every mode exercised locally against the
real repository, since Actions is still down.
