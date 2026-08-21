# Decision Log — Realm ID SDK monorepo

The **why** behind changes to `Realm-ID/sdk` — problem, options weighed,
decision, tradeoffs. Terse "what shipped" lives in `CHANGELOG.md`; the locked
behavioural contract lives in `SPEC.md`. This file is the running index of "why
did this change happen."

Newest first.

## 2026-08-21 (latest) — TS `listSessions` pages, and the break is deliberate

`AuthClient.listSessions` now returns `Paginated<SessionInfo>` and follows
`next_cursor`. Through `0.36.0` it resolved to `Promise<SessionInfo[]>` holding
the FIRST PAGE ONLY (server default 50). Lands in the unpublished `0.37.0`,
marked BREAKING; SPEC §4.6 updated, since that section documented the divergence
as a standing carve-out.

### Why this list, and not "one more paging TODO"

Silent truncation is bad everywhere; it is sharper here. `listSessions` is what
"sign out everywhere" and "revoke that device" are built on — the controls
someone reaches for when they believe they are compromised. A session missing
from the list is a session they cannot act on, and nothing in the response says
rows were withheld. This is the same reasoning that made issuer `v0.86.0` a
security fix rather than a tidy-up.

### The break was chosen, and the alternatives were real

Three options, all workable:

1. **`Paginated<SessionInfo>`** — breaking, parity-exact.
2. **Keep the array, loop internally to fetch every page** — non-breaking, fixes
   the truncation, but unbounded in requests and memory with no way for a caller
   to stop early, and TS stays shaped unlike both siblings, so SPEC §7's
   cross-language pagination contract keeps a TS carve-out.
3. **Add `listSessionsPaged()` alongside** — nothing breaks, but the truncating
   method stays the one everybody reaches for, so the bug remains the
   out-of-the-box behaviour, and the SDK carries two methods for one endpoint.

(1) was chosen (user call). **The deciding argument was internal consistency,
not cross-language tidiness**: `Paginated<T>` is already exported TS public API
and already what `federationBindings.list()` returns, so the bare array was the
odd one out *inside the TS SDK itself*. It is also the exact counterpart of
Java's `Paginated<Session>`; Go's `iter.Seq2` is the same idea in Go's idiom.

The break is worth naming honestly: a partner on the published `0.36.0` gets a
compile error. That is the POINT — a loud break with an obvious fix beats the
same call quietly returning a different number of rows, which is the failure
mode (2) would have shipped.

### The legacy tolerance is kept, and cannot spin the iterator

`readSessionPage` normalises the flat `{sessions: […]}` and bare-array bodies
before delegating to `readPage`, so SPEC §7's validation still applies to the
envelope a real server sends while partner mocks keep working. Neither legacy
shape carries a cursor, so such a server yields one page and stops — a
pre-envelope mock cannot put a caller in an endless loop. That is asserted, not
assumed: the legacy test now drains through the ITERATOR rather than `page()`.

### Verified against the real issuer, not only a fixture

The unit test proves the SDK follows a cursor its own fixture hands it. It
cannot prove the issuer emits one — and "the fixture agreed with the client
while both disagreed with the server" is exactly how the `{sessions: […]}`
decode survived, in this same method, four days ago. So `tests/sdk-e2e` gained a
case driving the issuer's own `pagedSlice` with `limit: 1`, so two sessions
force a second page and the test costs two logins rather than fifty-one. It
asserts as a PRECONDITION that the server emits `next_cursor` at all; without
that, a server returning everything on page one would satisfy the drain
assertion vacuously.

Mutation-verified three ways: dropping `next_cursor` from the page reader fails
both unit tests AND the e2e case (at the precondition); omitting the cursor from
follow-up requests fails the unit cursor assertion. ts unit 203 pass / 0 fail,
`tsc --noEmit` clean, sdk-e2e ts 8 pass / 0 fail.

### Also fixed, same lines

`docs/integration-guide.md` §4.5 was wrong twice over: it showed the old array
call AND read `s.createdAt` / `s.lastUsedAt`, which TS has never returned — it
hands back the parsed server JSON unmapped, so the fields are `created_at` and
`last_seen_at`. A snippet that cannot run is worse than no snippet; it was the
first thing a partner building a sessions UI would copy.

## 2026-08-21 (later still) — the last parity gap was a mode the issuer refuses

`TODO.md` § *Cross-language parity gaps* carried one entry after the realm pin
and the device label: add the `userId` + `X-On-Behalf-Of-User` BFF path to TS,
"because Go and Java support it". **It is closed by measurement, and the item
was pointing at the wrong SDK.**

**What the live issuer says** (`tests/sdk-e2e`, 2026-08-21):

| call | result |
|---|---|
| platform bearer + bare `X-On-Behalf-Of-User` | `401 x_user_token_required` |
| platform bearer + `X-User-Token`, no id at all | `200` |

Issuer v0.66.0 removed the id-as-identity mode — it was an unauthenticated user
id that any holder of a realm's platform key could use to act as any user in
that realm — and `derivePlatformActsOnUser` now refuses it explicitly rather
than demoting it to the bearer's own authority.

**So TS was never missing the working mode.** `realm.withUserToken(jwt)` has
sent exactly the shape the issuer accepts since ts `0.33.0`. Building the item
as written would have added a mode that 401s — "documented, wired, does
nothing", the shape this workspace has now paid for repeatedly. **Checking the
premise cost one probe against a stack that was already up; building it would
have cost a release.**

**The real defect was on the side the item cited as correct.** Go's and Java's
`UserID` path sends the id with no user token at all, so BFF mode there has been
dead against any issuer since v0.66.0 unless the caller separately threads a
token (Go: `WithUserToken(ctx, …)`; Java/TS: the derived `withUserToken` handle).
Both now refuse locally with an error naming the remedy, rather than issuing a
request that cannot succeed — the server's `401` cannot say which SDK call site
forgot the token, and this can.

**The refusal is SCOPED, and the scoping is the part worth remembering.** The
same header means two different things on the issuer: an IDENTITY pivot on the
sessions and MFA-self routes (`derivePlatformActsOnUser`), and a DOMAIN
PARAMETER on the OTP routes — the OTP subject, read straight off the header,
which `internal/httpapi/otp.go` marks "NOT an authz pivot". A blanket refusal in
Go's shared `resolveOnBehalfOf` broke three OTP tests; the helper now takes an
`idAssertsIdentity` flag and OTP passes false. **A header's name is not its
meaning** — the same bytes were an assertion on one route and an argument on
another.

**Nine tests were pinning the dead mode** (7 Go, 2 Java): they asserted a bare
on-behalf-of id against a fake server that accepts any header, so they passed
throughout the two years the issuer would have refused them. Updated to thread a
user token. Same shape as every other finding in this log where the guard tested
the half that was not broken — and another argument for the E2E suite, which is
where the truth came from.

## 2026-08-21 (later) — an SDK E2E suite, and the two defects it found on its first run

`tests/sdk-e2e/` drives the TS and Java clients against a real issuer on the
compose network. Homed in the umbrella per the ADR-053 SUT-span rule (the SUT
spans sdk + issuer), sharing the existing harness rather than forking one.

**Why it was worth building at all, stated as the finding rather than the
intent.** The unit suites assert what the SDK SENDS, against a fake server the
same suite owns. Nothing in that loop can observe what the ISSUER does, and the
first run turned up two defects that had survived every unit test, both of the
same shape: **the fixture agreed with the client, and both disagreed with the
server.**

**1. `listSessions` returned `[]` against every real issuer (TS).** It read
`raw.sessions`; the issuer answers the LOCKED paged envelope
`{items, next_cursor, total}` (`httpapi.pagedSlice`). Go has read `items` — with
`sessions` as an explicit legacy fallback — the whole time, so this was TS
holding the fallback and not the actual contract. A TS consumer's "your active
sessions" screen was empty and indistinguishable from having no sessions; the
`device_name` field we shipped hours earlier would have rendered nowhere.

The unit test could not have caught it: its fixture served `{sessions: [...]}`,
a shape no issuer emits. **A fixture is a claim about the wire, and an invented
one measures nothing.** Fixed by reading `items` first, keeping `sessions` as a
documented legacy/mock fallback (mirroring Go), re-pointing the fixture at the
real envelope, and moving the legacy case into its OWN test — so the primary
assertion now rests on the shape the server actually sends.

Left open and filed: TS returns the FIRST PAGE only, where Go iterates
`next_cursor`. Real, but a different bug from this one, and conflating them
would have hidden the envelope fix inside a pagination change.

**2. A device label containing a control character never reached the server —
in ANY SDK.** "Send the value raw; the server sanitizes" is the rule we wrote
into three SDKs and the SPEC that same morning. It is wrong for exactly the
input sanitizing exists for: undici throws `Headers.append: … is an invalid
header value` and Go's `net/http` returns `invalid header field value`
(**measured in a container, not inferred**), so the login failed outright with
an error naming the NETWORK rather than the argument.

The fix splits the rule where the responsibility actually splits. The SDK strips
what an HTTP field value cannot carry — C0 controls and DEL — because that is a
TRANSPORT constraint the client must satisfy to make any request at all. The
**120-character cap stays server-side**, because that is a POLICY and a
client-side copy drifts the day either end changes. The stripped value is
byte-identical to what `sanitizeDeviceName` would have stored, so the split
costs nothing observable.

Fixed in all three languages, Go included — it had shipped this hole since
ADR-062 and nothing had ever sent it a control character. An empty result after
stripping sends NO header, because the issuer reads a present empty value as a
supplied label.

**What the E2E is allowed to assume is itself the design.** Each case has a
positive control or a companion negative, and the suite is mutation-verified
end to end: reverting the `listSessions` decode fails 3 TS cases, un-sending the
header fails 3 Java cases, and un-wiring the realm pin from `Realm.builder()`
fails exactly the pin case — the same mutation that four SDK-level unit tests
sail through. The pin case is also the only place anything checks that the
issuer's `iss` is really shaped `<base>/<realmId>` (ADR-020); a unit test mints
its own `iss` and is blind to both failure modes it could have.

**The Java half compiles against the SOURCE tree** (`includeBuild` with an
explicit `dependencySubstitution`), not a published artifact. With releases
blocked, the source is the only thing that changes, and a version coordinate
would have quietly tested what Maven Central last served.

**Incident worth recording, because it inverts a claim made in this file
hours earlier:** the Java SDK's `--offline` builds were passing on stale build
outputs. `jackson-databind:2.17.2` was never in the host Gradle cache; a `clean`
exposed it, and the "195 tests, 0 failures, offline" runs earlier today had been
skipping `compileJava` as UP-TO-DATE. The tests themselves were real and did
run — but "it builds offline" was not true, and is now, since the fetch
populated the cache. **An offline build proves nothing until it has survived a
clean.**

## 2026-08-21 — the Java realm pin, and the device label TS never sent

Two `TODO.md` § *Cross-language parity gaps* entries, closed together because
both are "one language disagrees with the other two about a rule that is
already written down". Java `0.35.0`, TS `0.37.0`. **Neither is released** —
Actions is down on the org, so the bumps sit in the repo unpublished.

**Why parity gaps are worth closing at all.** A rule three SDKs are supposed to
enforce, enforced by two, is worse than one enforced by none: the SPEC says the
check exists, so nobody looks for it, and the language that skips it is the one
where a partner is least likely to notice. `realm_mismatch` had been in Java's
`ErrorCode` since the taxonomy pass — a constant that made the taxonomy look
complete while the check behind it did not exist.

**The pin refuses on mismatch and stays silent on undecodable.** The tempting
"stricter" reading — an access token whose payload we cannot decode is
suspicious, refuse it — is wrong, and the mutation run measured how wrong:
130+ tests across the Java suite go red, because every fixture mints an opaque
`pt-…`, and so would any consumer whose issuer or mock returns a non-JWT
access token. The pin answers *which realm is this token for*; an unreadable
answer is not a wrong answer, and validating tokens is `Verifier`'s job. Go and
TS had both already made this call (Go returns nil on a malformed payload; TS's
peek returns `""` → skip), so matching them is also the interop-safe choice.

**The constructor was kept, not replaced.** `PlatformTokenManager`'s 7-arg
constructor stays and skips the pin, mirroring TS's `if (!realmId) return`. A
manager with no realm to pin against has nothing to compare, and turning that
into a hard failure would break direct constructor users for a check they never
asked for. `Realm.builder()` — how every partner actually builds the SDK —
passes the realm id, so the default is pinned.

**The wiring test is the one that matters, and the mutation proves it.** Four
manager-level tests pass with `Realm` handing the manager `null` for the realm
id: the check is present, correct, and dead for every real consumer. That is
the exact shape this workspace has shipped repeatedly (v0.88.0's correlation
subject side, v0.90.0's `/me` fallback, v0.83.0's console-level invitation
accept) — a guard that is right one layer below where it has to fire.
`RealmPinWiringTest` builds through the public builder and is the only test
that dies under that mutation. Its second case is a positive control, so it
cannot pass by refusing everything.

**The device-name item's own description was false, and in the direction that
hides work.** It read "JAVA ONLY now — `ts/` has it". TS had the READ half
(`SessionInfo.device_name`) and no send half at all: no `deviceName` on
`LoginRequest`, no `X-Device-Name` anywhere in `ts/src`. So a TS consumer could
render a device label with no way to set one, and the entry's own evidence —
the field being present — is what made it look done. Tenth confirmed case in
two weeks of a TODO description outliving its facts; the reusable rule is the
one this very item already carried in its other half: **check the artifact the
consumer gets, not the presence of something nearby.**

**Header, not body, and only on the user grant.** The issuer reads
`X-Device-Name` on `POST /auth/login` (swagger, `maxLength: 120`) and sanitizes
it server-side (`sanitizeDeviceName` strips control characters and caps the
length), so no SDK duplicates that — a client-side cap would silently disagree
with the server's the day either changes. The platform bootstrap that precedes
every user login is an M2M mint the issuer records no device for; sending the
operator's hostname there would leak it onto a credential session for nothing,
so both SDKs assert its absence. Absent means **no header**, not an empty one:
the issuer treats a present empty value as a supplied label.

**Java's session-list fixture had been serving `device_name` since the test was
written** and asserting nothing about it, because `Session` had no such
component and `@JsonIgnoreProperties(ignoreUnknown = true)` swallowed it in
silence. A fixture that carries a field is not coverage of that field.

Every new guard was mutation-verified (8 mutations: pin not called, comparison
inverted, undecodable-treated-as-mismatch, realm id not wired, header
unconditional, header never sent — in both languages, `Session` component
renamed). Java 195 tests / 0 failures; TS 197 / 0 with `tsc --noEmit` clean.

## 2026-08-06 — wrap both by-id platform reads; two "blocked on a repack" items were already shipped

Issuer `v0.87.0` added `GET /platforms/{id}` (owner) and
`GET /admin/platforms/{id}` (base-realm staff). Three TODO items across two
repos wanted them wrapped. Shipped `@realm-id/sdk` `0.36.0`
(`AdminClient.getPlatform`) and `@realm-id/web-admin` `0.8.19`
(`PlatformsClient.get`).

**Why two wrappers and not one.** They are different endpoints with different
audiences and different row shapes — swagger keeps `PlatformSummary` and
`AdminPlatformSummary` distinct and carries an explicit "do not re-merge them"
note, because both were once called `PlatformSummary` and the ops row silently
won every `$ref` under YAML last-key-wins, mis-documenting two partner
endpoints. The staff read stays out of the partner SDK per the standing
`/admin/*` rule.

**The staff wrapper is a correctness fix, not a convenience.** The console was
paging `listPlatforms({limit:100})` up to 20 times and matching client-side, so
the scan was capped at 2000 rows and a platform past that point was reported as
**not found although it exists** — a false negative no retry would clear, and
one that arrives on its own as the fleet grows.

**Correction, recorded because it was asserted before it was checked.**
`ui/TODO.md` described this as rendering "the raw UUID as the platform name with
empty KPI tiles and **no error**", and that description was carried into the
first draft of this entry, the `0.36.0` changelog and the commit message. It is
**wrong**: the screen has always had a `loaded && !summary && !loadErr` branch
rendering a "Platform not found" EmptyState, and the UUID in the header is
deliberate — its own copy says "The header still lets you act on it by id", so
Suspend and Rotate stay usable when the row cannot be read. The bug was a false
negative, not a silent one. It was caught by writing a test that asserted the
UUID must not appear and watching it fail against the actual component.
The lesson is narrow and worth keeping: **a TODO's description of a defect is a
claim about code, not a fact** — this one had been re-copied across two repos.

**Both wrappers must preserve an identical 404.** A platform the caller cannot
see returns the same `platform_not_found` as an id that was never issued —
never `403`. A wrapper that re-labels it (or a consumer that renders "you don't
have access to this platform") reconstructs the enumeration oracle the
identical 404 exists to close. Recorded in both changelogs and in the JSDoc,
because this is the kind of property a well-meaning "better error message" PR
removes.

**Rejected: adding `platform_not_found` to the `ErrorCode` taxonomy.** The
first draft of the 404 test asserted that code and failed — it is absent from
the TS union, and from Go's and Java's too, so a 404 normalizes to `not_found`.
Adding it is a lockstep SPEC change across three languages, and it is
behaviour-breaking despite being additive to a union: every consumer currently
catching `not_found` on a platform route would silently stop matching. Filed in
`TODO.md` as a decision to take deliberately rather than as a side effect of a
wrapper release. The test now asserts the real contract (`not_found` +
`httpStatus: 404` + explicitly not `forbidden`/`unauthorized`), which pins the
security property without over-specifying the code.

**The finding worth keeping: two items were closed by CHECKING, not by
building.** `sdk/TODO.md` recorded `ActiveSession.device_name` and
`RoleObject.assignable_to`/`can_invite_roles` as still-owed and blocked on one
repack, re-verified three times across eight repacks. Both were **already in
the published `0.8.18` tarball**. The re-verifications kept asking whether the
UI still carried its shim — it did — but *a shim that has outlived its need
looks exactly like a shim still needed*. Nobody asked the question that settles
it: is the field in the tarball? `tar -xzOf …tgz package/dist/types.d.ts`
answered it in seconds.

The ADR-081 entry compounded this with a correct grep supporting a false
conclusion: "0 matches for `assignable_to` in `web/packages/admin/src`" is true
and proves nothing, because web-admin **re-exports** `RoleObject` from
`@realm-id/sdk/internal`, so the field was never expected to appear there.

**So the real defect was never the missing fields — it was the shims.**
`ui/web` carried a `SessionRow = ActiveSession & { device_name?: string }`
augmentation and five `r as AssignableRoleLike` casts over values already typed
`RoleObject`. A structural `as` over an SDK type silences precisely the drift
the type exists to report: had the fields genuinely never arrived, those casts
would have gone on passing. Deleted rather than widened — same call as the
`MeMembership` mirror in `0.8.18`. `tsc` passing afterwards is a real check,
not a vacuous one, because the component reads `device_name` at two sites.

**Verification method, stated so it is reusable:** check the packed artifact,
not the source, and not the presence of a workaround.

## 2026-08-05 — the Go `Version` const drifted a third time; the fix is the check, not the bump

`go/realmid.go` declared `Version = "0.38.0"` while the newest published tag was
`go/v0.44.0` — six releases stale, and **live**.

**RCA**

**Symptom** — anyone reading `realmid.Version` got `0.38.0` from a module
resolved at `0.44.0`. Nothing failed; the wrong number was simply reported as
fact. It matters now in a way it did not before: `docs/integrator-sdk-pins.md`
(Realm-ID/project, shipped 2026-08-03) asks partners to report this exact
number back to us as their pin, and that register is what we diff against the
ADR-089 hard floors to decide whether a breaking issuer change is safe to ship.
A wrong const becomes a wrong row in the register built to prevent the Traide
outage.

**Root cause** — the const has **no in-module consumers**. Nothing reads it, so
nothing can fail when it is wrong, so the only thing standing between it and
drift was a human remembering to edit one line during a release that is
otherwise entirely `git tag && git push`. The Go SDK publishes by tag push
alone — the module proxy serves the tag directly, with no release script in
between — so there was never a place where the release *could* have checked.

**Why it wasn't caught** — it was caught, twice, and the prevention chosen both
times was a comment. `go/v0.29.0` shipped reading `0.20.0` and misled a partner
into thinking the ADR-071/072 service-account surface was unreleased; the fix
added a doc comment saying the const MUST be kept in lockstep. `go/v0.35.0`
shipped reading `0.34.0`; the fix extended the comment. The comment grew to 31
lines of accreted per-release narrative, which is the second half of the
mechanism: a declaration wearing that much prose *looks* maintained, so the
stale value underneath reads as deliberate.

**Fix** — two parts, and the order matters.
1. `.github/workflows/verify-go-release.yml` asserts `const Version` equals the
   pushed `go/v*` tag, and can be dispatched to check the newest existing tag at
   any time. This is the actual fix: it is the first prevention that can fail.
2. The const is set to `0.44.0` and its comment cut to the rule plus a pointer
   at the check. Per-release history moved to where it belongs (`CHANGELOG.md`).
   Bumping alone was explicitly rejected — it leaves the same mechanism that
   rotted three times and would have made the fourth drift look like the first.

**Prevention** — the workflow above. Verified by mutation: the extraction is
anchored to `^const Version = "` (so a mention in a comment or a test cannot
satisfy it), it requires exactly one matching declaration, and fed the old
`0.38.0` it rejects against tag `0.44.0`.

**Tradeoff, stated rather than solved:** the check fires at TAG time, which is
after the release exists. It cannot prevent a bad publish, only make it loud —
and because tags are immutable once `proxy.golang.org` has cached them (root
`TODO.md` § Tag hygiene, `go/v0.21.0`), the remedy when it goes red is the next
patch version, never a re-pointed tag. The workflow says so in its failure
output. An earlier check is possible only by giving the const a real consumer —
e.g. sending it as a `User-Agent` — which is a wire change and a separate
decision, so it is not made here.

## 2026-08-03 — the browser SDK's `MeMembership` catches up to `/me`, and the changelog catches up to the versions (web-admin `0.8.18`)

Issuer `v0.83.0` added `invitation_pending` to `/me` and the BFF passed it
through, but `@realm-id/web-admin`'s `MeMembership` never declared it. Nothing
was broken: `ui/web`'s `AccountOrganizations.tsx` declared a local mirror of the
four fields it reads and got the behaviour right. **The mirror is the finding.**

It could only exist because of a cast — `auth.profile?.memberships as
Membership[]` — asserting a `MeMembership[]` into a wider local shape. That
assertion silenced the compiler on precisely the drift the type exists to catch:
the day the console read a field the SDK did not declare, the type system had the
information to say so and was told not to. So the fix is not only "add the
field", it is **delete the mirror and the cast**, which is why the ui change here
is a deletion rather than an addition.

Keying the invitation controls on the wrong flag is not hypothetical — it shipped
in `v0.38.0` and the ui-e2e run caught it. `invitation_pending` and
`pending_first_signin` are ORTHOGONAL and BOTH true on a pending invitation,
which is what makes the wrong one pass every happy-path test; they diverge only
on a settled invitation and a bulk import. A consumer trusting the published type
had no field to key on but the wrong one. The doc comment on the new field
therefore spends more lines on the distinction than on the field, deliberately —
a one-line `invitation_pending?: boolean` would have been an accurate type and a
useless one.

**Released rather than left in-repo.** The standing plan was to hold this for the
next `web-admin` roll so the repack gotcha is paid once. Rejected: an unpublished
type is the "documented, wired, does nothing" shape this workspace hit four times
in a week — every installed consumer still resolves `0.8.17`, so a type sitting
correct in `main` protects nobody. The gotcha cost one staging step that
`publish-npm.yml` already automates.

**Changelog backfill.** `CHANGELOG.md` jumped `0.8.12` → the current version
while `package.json` read `0.8.17`; `0.8.8` and `0.8.13`–`0.8.17` had no entries
at all. Their only record was a prose paragraph inside `ui/web/vendor/README.md`
— a vendoring note in a different repo, which is how a changelog goes missing
without anyone noticing. All six are backfilled from the version-bump commits,
and the vendor README now carries the version table only and points at the
changelog for the why. A release note stored next to the tarball is a note that
exists for exactly as long as the tarball does.

## 2026-08-03 — `acceptInvitation` ships with the tests the feature commit skipped (go `0.44.0`, ts `0.35.0`, java `0.34.0`)

Issuer `v0.82.0` (ADR-095 D5) adds `POST /me/invitations/{tenantId}/accept`, and
the SDK wrapper for it landed in the previous commit **with no test in any of the
three languages** — while its mirror, `rejectInvitation`, has one in all three.
That asymmetry is the decision worth recording, because the wrapper is three
lines of path construction and the temptation is to call it too small to test.

It is not, and the mutation check says so: repointing the Go implementation at
`/reject` — a one-character-class edit, the exact slip a copy-pasted mirror
invites — fails both new tests. The wrapper's entire job **is** the path, so an
untested wrapper has nothing verified about it at all. A caller who asked to
accept an invitation and silently declined it has no recovery: `reject` is
terminal for that lifecycle row, and the invitee must be invited again by someone
else.

The second test per language pins the ERROR CODE rather than the status. `409`
carries both `not_invited` (you are already an active member — nothing to do) and
`not_pending` (the invitation was answered, revoked or expired — ask for a new
one). The remedies differ and only the code separates them, so a status-only
assertion would pass against an SDK that flattened both into a generic conflict.
Same reasoning as the `owner_cannot_be_revoked` test that already sits beside it.

Nothing was changed about the shipped behaviour — this release is tests, the
version bumps, and two documentation corrections. The SPEC header and its §12 tag
matrix had gone stale on 2026-07-15, advertising `go/v0.32.0` while `go/v0.43.0`
was live: eleven releases of drift in the one table whose stated purpose is to
say which tag matches this document. Refreshed here rather than filed, because a
version table that is known-wrong is worse than absent — a reader who distrusts it
gains nothing from it, and one who trusts it installs an SDK missing the surface
they are reading about.

## 2026-08-02 — dropping `allowedDomains`: a removed field is safer than a stale one (go `0.43.0`, ts `0.34.0`, java `0.33.0`, web-admin `0.8.17`)

Issuer `v0.77.0` (ADR-094 R3) deletes `tenants.allowed_domains`. The SDK
question was whether to remove the field or leave it as a harmless no-op for one
release, which is the usual courtesy for a breaking wire change.

Left in place it would not have been harmless. `Tenant.allowed_domains` is typed
`string[]` (non-optional) in `@realm-id/web-admin`, and the issuer stops sending
it — so `t.allowed_domains.length`, which is what every consumer actually
writes, keeps typechecking and throws `Cannot read properties of undefined` at
runtime. A field that is present in the type and absent on the wire converts a
compile-time error into a production crash; that is strictly worse than the
breakage of deleting it, which surfaces at build time in the caller's own repo.

Java takes the sharpest hit and it is accepted rather than worked around: the
`of(displayName, allowedDomains, owner)` overload is deleted outright instead of
being deprecated to a no-op. A no-op overload would silently accept a list of
domains and discard them — the caller's code compiles, runs, and quietly does
not configure the SSO they asked for. Source-incompatibility is the honest
signal.

The replacement is not a rename. Domains that auto-provision are now
`tenant_domains` grants requiring PROOF of control, reached through the domains
API, so there is nothing on `create` to point the old field at — which is also
why a bulk-imported org starts with its domains inert (ADR-094 §Consequences,
no bulk-approve path). Recorded in SPEC §6.1 so a partner reading only the spec
does not plan a migration around a field that cannot exist.

## 2026-08-02 — on-behalf-of reaches the typed surface by DERIVING a client (ts `0.33.0`, java `0.32.0`)

A partner BFF acting for a signed-in user forwards that user's verified access
JWT as `X-User-Token` beside the platform bearer (ADR-056; the bare
`X-On-Behalf-Of-User` id stopped being an identity in issuer v0.66.0). Go has
carried it on every typed method since `go/v0.37.0`; **TS and Java could send it
only on `realm.me.*`**, so a partner calling `tenants.list()` for a user had to
drop to raw HTTP. ADR-094 flow 1 — an org admin claiming a domain through their
platform's own console — cannot be built until that is closed, which is why this
is R1 of that work rather than a standalone SDK chore.

**Client derivation, not a per-call option.** Threading a `userToken` through
every typed method meant ~104 signature changes per language, each one a
breaking-ish churn on a locked spec, and every new method a fresh chance to
forget. `realm.withUserToken(jwt)` instead rebuilds the resource bundle around
one derived transport: the header reaches every method, present and future, and
**not one signature moved**. The cost is a second object graph per call site —
cheap, because everything expensive (platform-token manager + cache, verifier,
JWKS cache) is *shared* with the parent. Those are all platform-scoped; nothing
user-scoped is shared, which is what makes sharing safe.

**Why Go's mechanism could not simply be copied.** Go uses a context value, so
it needed zero signature changes and reaches `Do` and typed methods alike. TS
and Java have no ambient request context. The Java-shaped equivalent would be a
`ThreadLocal` — rejected: this SDK targets virtual threads, where an ambient
token that must be set and cleared around every dispatch is a leak waiting to
happen, and a leaked identity here is *authorization as the wrong user*. A
mutable field on the realm handle was rejected for the same reason one step
down: the handle is long-lived and shared across requests, so one request's user
would bleed into the next. Derivation makes that failure unrepresentable — a
derived handle cannot mutate its parent, and Java refuses an empty token rather
than returning a handle that *looks* user-scoped and silently calls as the bare
platform credential.

**A bug found on the way: the header could have been sent twice.** `me` sets
`X-User-Token` as a per-call header; the new transport sets `x-user-token`.
Header names are case-insensitive, but both languages' merges were plain map
writes keyed on the literal string — so both would have gone on the wire, and
`fetch` joins duplicates with a comma while `HttpRequest.Builder.header()`
appends. The issuer would have received `"a, b"` and rejected a token neither
half authored. Per-call header names are now lower-cased on the way in, so a
per-call value *overrides* rather than *joins*. Both suites assert on the raw
header list, not the folded map — folding is exactly what hides this class of
bug.

**Also corrected: the TODO that scoped this work was wrong.** Both `sdk/TODO.md`
and the root `TODO.md` carried "re-confirmed 2026-07-28: 0 matches for
`X-User-Token` in `ts/src` and `java/src/main`". Both languages already sent it
on `/me`. The real gap was never absence, it was reach — and a scoping line that
says "absent" points at a different, larger fix than one that says "cannot ride
the typed path". Both entries now record the correction, because a grep pasted
into a TODO is a timestamped claim, not a fact.

## 2026-07-30 — ADR-092 surface: a `me` namespace, and the picker is not an error

The issuer shipped ADR-092 (single-tenant membership + the D5 picker + membership
self-service). This change types that contract in all three SDKs. It is purely
additive — no existing field, method or signature moved — because the issuer
side is already live and older SDK builds must keep working against it.

**A new `realm.me.*` namespace rather than methods on `auth`.** `auth.*` is the
credential-exchange surface (login, refresh, MFA, session revoke); these three
routes are *membership* operations that happen to be self-scoped. Hanging them
off `auth` would have made "the thing you call with a user's token" the
organizing principle, which is transport, not meaning. `me` names the subject,
which is the actual invariant: no path parameter here can name someone else.

**Two auth modes, no user-id mode.** Direct (`userBearer`) and BFF (`userToken`
→ `X-User-Token` beside the platform bearer) mirror the rest of the SDK. The
existing `resolveOnBehalfOf` trio was deliberately NOT reused: its `UserID` arm
sends `X-On-Behalf-Of-User`, which issuer v0.66.0 removed as an identity
assertion (`401 x_user_token_required`). Offering it here would have shipped a
mode that cannot work, and worse, one that *looks* like the authenticated path.

**The picker is typed on the SUCCESS response, not as an error.** The tempting
shape was a `tenant_choice_required` throw, symmetric with `mfa_required`. It
would have been wrong: the issuer mints a real access token and a real refresh
token in this state, and turning that into an exception would have forced every
consumer to catch-and-continue to stay logged in. The rule this encodes — a
reconciliation prompt is not an authentication failure — is the same reason the
issuer does not refuse the login: refusing strands exactly the users the drain
exists to resolve.

**`singleTenantPendingReconciliation` typed BESIDE `config`, not inside it.**
The issuer puts it outside the settings bag because it is derived state, and the
SDKs preserve that seam rather than flattening it for convenience. Modelled as
`*int` / `number | undefined` / `Integer` so ABSENT (rule off, not reported) is
distinguishable from `0` (rule on, fully drained) — a UI that renders "0 users
pending" for a realm that never enabled the rule is reporting a fact it does not
have.

**Seven error codes registered in the known set.** Six of them are 409s. Without
registration they all collapse to the generic `conflict` and the caller cannot
tell "transfer ownership first" from "you wanted `leave`, not `reject`" from
"there is nothing to settle" — three different remedies behind one status. This
is the same reason the integration codes were registered in ADR-082/083.

## 2026-07-28 — cookie shadowing: read every candidate, and evict the twin

**Reported by Traide from a live incident.** Their analysis was correct on every
point; I re-verified it against `middleware.go` and `RealmFilter.java` before
acting rather than taking the report on trust, and both SDKs had the defect
exactly as described.

### RCA

**Symptom** — after a partner set `REFRESH_COOKIE_DOMAIN=.traide.co.in` on a
deployment with live sessions, every page reload logged the user out. `POST
/auth/token` returned `401 refresh_invalid` on every attempt, deterministically,
from the moment the existing access token expired. Logging out and back in did
not help; neither did waiting. The only recovery was deleting cookies by hand.

**Root cause** — three decisions that are individually reasonable and jointly
unrecoverable. (1) `setRefreshCookie` writes `Domain: opts.CookieDomain`, and
per RFC 6265 a Domain-scoped `Set-Cookie` cannot overwrite a host-only cookie of
the same name — they are separate jar entries, so a scope change *forks* the
cookie rather than moving it. (2) `readRefreshToken` used
`(*http.Request).Cookie`, which returns the first match and silently discards
the rest; RFC 6265 §5.4 orders equal-path cookies by creation time, so the
first match is the OLDER, already-rotated one. It never self-heals and never
intermittently works. (3) `clearRefreshCookie` also scoped itself to
`CookieDomain`, so logout could not clear the shadow — which is what removed the
last recovery path.

The originating mistake is (2): treating "the refresh cookie" as a value when
the platform models it as a *set*. Once the read is a first-match, (1) and (3)
turn a transient inconsistency into a permanent one.

**Why it wasn't caught** — every test wrote and read the cookie within a single
configuration. Nothing exercised a CONFIGURATION CHANGE against pre-existing
state, which is the only way to produce two cookies of one name; the whole
defect lives in the transition, not in either steady state. The option was also
documented as `CookieDomain string // optional`, which reads like a free-form
knob rather than a one-way door.

**Fix** — read every candidate and try each until one mints (this alone restores
service for already-stranded browsers, because the valid token was in the header
the whole time), plus actively evict the other scopes on every write and on
logout so the jar converges instead of accumulating. `CookieDomainMigrateFrom`
covers the direction the SDK cannot infer. Logout revokes every candidate.

**Prevention** — tests that assert the *transition* rather than a steady state,
in both SDKs; SPEC §10.4 now documents the hazard and the migration; the option
comments carry the warning at the point of use.

### Decisions worth recording

**Trying each candidate is only safe because this issuer has no reuse
detection.** I checked `authsvc.MintForTenant` before implementing the reporter's
suggested fix: an unrecognised refresh hash resolves to nothing and returns
`ErrNotAuthenticated`, revoking nothing. Had the issuer treated refresh replay
as a breach signal and killed the session family — a common and defensible
design — then "try each candidate" would have been *worse than the disease*,
handing it one stale token per request. That constraint is now a comment at both
call sites, because the safety of this loop is a property of the server, not of
the SDK, and a future reuse-detection feature would silently invalidate it.

**Both halves, not just the cheap one.** Reading every candidate alone would
have restored service while leaving every affected browser permanently carrying
garbage, and left logout still unable to clear it. Eviction alone would fix new
sessions and strand existing ones. They address different things and the
reporter was right to ask for both.

**Report the FIRST failure, not the last.** With one cookie the two are
identical; with several, the first is the error the old code would have surfaced.
Partners branch on `refresh_invalid`, and a fix for a cookie problem must not
change the error shape of an unrelated failure just because a browser happened
to be carrying a twin.

**Scope comparison trims the leading dot.** `.example.com` and `example.com`
name the same scope under RFC 6265 (and Go's `http.SetCookie` strips the dot
anyway). A raw string compare between `CookieDomain` and `CookieDomainMigrateFrom`
would let a partner who spelled the two settings differently delete their own
live cookie on every write — the same self-inflicted-logout class this change
exists to remove.

### What we could not answer

Their §4.4 asks us to confirm the blast radius across other realms. **We cannot
enumerate it.** `CookieDomain` is configured in each partner's own deployment of
the SDK; RealmID never sees it, so there is no query that lists affected realms.
The honest answer is that the symptom is observable from our side but the cause
is not: a realm whose users were stranded this way would show a sustained
elevated rate of `refresh_invalid` at `/auth/token` against otherwise healthy
logins. That is a proxy, not an enumeration, and it needs the fix shipped before
it is worth acting on.

## 2026-07-28 — web-admin 0.8.16: publish permissions, not a marker to expand

ADR-090 has the issuer resolve the caller's effective permission set per
membership. The SDK's only decision was what shape to expose.

We publish the resolved array and no expansion rule. The tempting alternative —
document "if `is_owner`, treat as all" — is smaller on the wire and would have
kept the type unchanged. It is wrong twice: it re-creates the marker-inference
bug ADR-090 removes, one layer up in every consumer rather than once in the
server; and it is incorrect for a capped principal, where an owner's effective
authority is `catalog ∩ permissions_cap`, not the catalog. A consumer that ORs
in `is_owner` for convenience gets it wrong in exactly the case that matters.

`is_admin_tenant` ships alongside because `permissions` alone over-reports: the
realm-scoped gate has a structural precondition (sitting in the realm's admin
tenant) that no permission string encodes. Naming it as its own boolean is
honest; folding it into the array would assert a gate scope per permission that
has not been audited yet.

Both fields are optional, and the doc comments say absent means UNKNOWN rather
than none. A consumer that reads absent as "no permissions" would blank its
console against an older BFF mid-rollout — a worse failure than briefly showing
a control the server refuses.

## 2026-07-27 — ADR-089's doc debt: the spec still described the refresh step it deleted

**Problem.** ADR-089 removed the platform refresh token, and `sdk/go` + `sdk/ts`
were updated in lockstep. The *documentation* was not, in four places that all
contradicted `SPEC.md` §190's own "there is no platform refresh step":

- `SPEC.md` §6 — "refreshes via `POST /auth/token`" as the management-call lifecycle.
- `SPEC.md` §"Auth header" — listed "the platform refresh token" as a legal bearer.
- `SPEC.md` §4.x — contrasted the user lane against "a dead platform refresh".
- `java` `PlatformTokenManager.invalidate()` — "the refresh token is preserved so
  the next `getToken()` can try `/auth/token`", 40 lines below that class's own
  correct ADR-089 note. There is no refresh field in the class at all.

**Why it matters more than a typo.** `sdk/CLAUDE.md` makes SPEC.md law — "if a
language SDK and SPEC.md disagree, fix the SDK." A stale spec therefore doesn't
just misinform, it authorizes re-implementing the withdrawn behaviour. And these
are the paragraphs a partner reads while debugging exactly this path: Traide's
2026-07-27 reply (§5) caught the same class of defect in the issuer's comments,
having traced a live bug through them.

**Decision.** Correct all four to state the absence positively (re-mint from the
bootstrap credential; `POST /auth/token` returns `401 m2m_refresh_withdrawn` for
such a session) rather than deleting the mention — a reader arriving with an old
mental model needs to be told it changed, not to find silence.

One nuance the old wording flattened and the fix preserves: "service / platform
refresh tokens" was not uniformly wrong. ADR-089 splits `class=service` by
`auth_method`, so the ADR-071 OTP-bootstrapped service account *keeps* its refresh
token; only the platform/api-key lanes lost theirs.

**Tradeoff.** Doc-only, so no version bump — java `0.29.0`'s published javadoc
carries the stale sentence until the next release. Judged acceptable: the code it
describes is correct, and forcing a release to fix a comment costs more than the
exposure.

## 2026-07-26 — the missing `/internal` export: why the UI reimplemented a client we shipped

**Problem.** `ui/web/src/api.ts` carried `listUserApiKeys` / `createUserApiKey` /
`revokeUserApiKey` as hand-rolled `fetch` shims, against a repo convention that
explicitly says admin calls belong in `@realm-id/web-admin`. The stated reason
was "web-admin has no `userApiKeys` resource." That turned out to be false in the
way that matters: `sdk/ts` HAS shipped `UserApiKeysClient` since 0.29.0 — it was
simply never listed in `src/internal.ts`, the entry point web-admin imports from.
The public `realm.userApiKeys` facade worked; the admin path did not exist.

**Why it went unnoticed.** `internal.ts` is a hand-maintained re-export list with
no test asserting it covers the resource classes, and its own header disclaims
semver coverage — so "not exported from internal" reads as a deliberate choice
rather than an omission. Adding a resource means editing two files, and nothing
fails if you edit one. The UI author correctly observed the absence and drew the
wrong conclusion from it, which cost a duplicate implementation of three calls
plus three DTOs that could drift from the SPEC independently.

**Decision.** Export from `internal.ts` (client, `capAllows`,
`isUserApiKeyRevoked`, and the four types) and wire `admin.userApiKeys` in
web-admin, rather than build a package-local client the way `apiKeys` did.
`apiKeys` is package-local for a real reason — the bundled client's
`displayName`/`scopes[]` shape predates the issuer contract — and that reason
does not apply here: `UserApiKeysClient` targets the current contract exactly.
Duplicating it would have created the second copy the `apiKeys` note warns about.

**Tradeoff.** This widens the `/internal` surface, which is deliberately not
semver-guaranteed. Acceptable: web-admin is versioned in lockstep in this
monorepo and is the entry's only consumer. Shipped as ts 0.30.0 (additive) and
web-admin 0.8.14, with three transport-level tests pinning the route segment so
`userApiKeys` can never quietly start pointing at the platform-key path.

## 2026-07-26 — the api-key `label` asymmetry: a known quirk is not the same as a decision

**Problem.** All three SDKs, plus the UI, carried a comment explaining that
api-key list rows have **no** `label` — the Go struct, the TS interface, the
web-admin type and `ApiKeys.tsx` each described the asymmetry in their own words
and pointed at someone else's backlog. Four descriptions of a gap, zero fixes.
ADR-085 §7 then closes with "labels are the only handle", which is exactly right
and, given the omission, unactionable: the plaintext is echoed once at create and
`prefix` is derived from the stored hash, so a key found in a deployment config
matches nothing.

**Decision.** Fix it at the issuer and let the field flow, rather than continuing
to document it. One response field retired four comments. This is the general
shape worth remembering: a divergence that has been *written down* in several
places is usually cheaper to fix than the prose already spent describing it.

**`expires_at` rides along, and `null` is a value.** Every SDK types it nullable,
and the surrounding prose says explicitly that `null` means "never expires" and
not "unknown" — because the natural rendering of an absent number is a dash, and
a dash would hide the one thing ADR-085 §2 permits at most one of per realm. The
UI backs that with distinct wording ("no expiry" versus the "never" used for
last-used) so a standing decision does not read as a missing event.

**`Expired(now)` next to `Revoked()`, in Go and Java.** The issuer deliberately
returns the same envelope for expired and revoked keys so a holder cannot
distinguish them — but an ADMIN SDK's caller is on the other side of that line
and often needs to tell an operator which happened. Two predicates, not one
`Usable()`, for that reason.

**Repack note, because it nearly shipped stale.** `@realm-id/web-admin` bundles
`@realm-id/sdk` via `bundledDependencies`, and the first pack picked up a
`ts/dist` built before the edit — `npm pack` ships whatever `dist/` holds, and
`tsc --noEmit` (which is what the typecheck runs) writes nothing. The tarball
looked correct: right version, right web-admin dist, silently stale bundled SDK.
Verify by extracting the tarball and grepping the BUNDLED dist, not the version
number.


## 2026-07-24 — web-admin transport must not relabel client-side auth errors as `network` (0.8.11)

**Symptom.** Opening `app.realmid.dev` after a long idle showed the fatal
*"We couldn't load your workspace — network error calling GET /me: no current
tenant"* screen; a second reload landed cleanly on login.

**Root cause (SDK half).** On reload the `@realm-id/web` realm optimistically
paints `authenticated` from the localStorage snapshot before its background
`restore()` revalidates (`ui/CLAUDE.md` step 4). The console flips to its authed
phase and fires `admin.me.profile()` (`GET /me`) against the unvalidated
session. When the stored session is dead, `restore()`'s own `/me` 401s and calls
`tokens.clear()`, dropping the current tenant out from under the in-flight call;
`realm.fetch` then throws `RealmError("unauthorized", "no current tenant")`
**client-side, before any request leaves the browser**. `web-admin`'s transport
caught *every* throw from `realm.fetch` and wrapped it as `code:"network"` with
a `network error calling GET /me: …` message — hiding the real `unauthorized`
code behind a fake network error, so callers couldn't tell "dead session" from
"transport down" and surfaced a retry screen instead of routing to sign-in.

**Decision.** In the transport `catch`, re-throw the error unchanged when it
carries a string `code` (it is already a typed realm error) and only wrap a
genuine fetch rejection (a bare `TypeError`, no `code`) as `network`. Duck-typed
on `code` rather than `instanceof RealmError` **on purpose**: the thrown value
is `@realm-id/web`'s RealmError, a *different class* from this package's
`@realm-id/sdk` RealmError, so `instanceof` would miss it and silently keep
mislabeling. The app half (route auth/session/tenant workspace-load failures to
the login card) lives in `ui/DECISIONS.md`.

**Why it wasn't caught.** The 2026-07-01 `web@0.4.4` fix addressed the *sign-out*
and the bearerless `/me`, but not this optimistic-adopt-vs-restore race on the
app's *own* tenant-scoped calls; the console only started routing `/me` through
this transport after moving to `admin.me.profile()`. No test exercised
`realm.fetch` *throwing* (all stubs returned a Response), so the blanket wrap was
never observed. Added: transport tests for the throw path (typed error re-thrown
unchanged; bare `TypeError` wrapped as `network`).

**Tradeoffs.** `0.8.11` also carries a backfilled `0.8.10` CHANGELOG entry (the
ADR-082/083 surface bumped the version without one). Vendored into `ui/web` as a
tarball; npm publish of `0.8.11` is a follow-up (the app pins the tgz, not npm).

## 2026-07-23 — cross-realm integrations surface; the mint returns an access token only

**What.** New `realm.integrations.*` across go/ts/java (+ `admin.integrations` in
web-admin) for ADR-082/083: source-side `register/list/update/disable/enable/remove`,
target-side `install/listInstallations/uninstall`, and `mintToken`. SPEC §6.14 +
a 7th `/auth/login` grant (`integration_installation`).

**The load-bearing shape decision: `mintToken` returns an access token only — no
refresh token — modelled as a plain one-shot, deliberately NOT wired into a
token manager.** The caller re-mints (and may cache for `< expires_in`, a fixed
600 s). A user raised the obvious alternative — mint a refresh token so the
source re-uses it via `/auth/token` — and we walked through it in full.

**Why access-only won.** The deciding principle is that a refresh token exists to
solve *"the credential-holder is not present to re-authenticate"* — the
user-session problem. In machine-to-machine the source platform always holds its
`platform_api` key, so re-authentication is free (call the mint again), and the
problem refresh tokens solve does not exist. This is not just GitHub App
installation tokens; it is the M2M norm: OAuth 2.0's client-credentials grant
(RFC 6749 §4.4.3) says a refresh token *SHOULD NOT* be issued, and AWS STS
AssumeRole + GCP service-account impersonation both return short-lived tokens
with no refresh, re-minted with the caller's own credential. Refresh appears in
M2M only as an opt-in convenience (Slack token rotation), never the default.

**Two arguments we discarded as wrong or weak** (credit to the user for both):
- *"Refresh is unsafe on drift"* — misframed. Whether the installed role was
  since disabled/narrowed/deleted (ADR-082 §6.1 drift) is **RI's** responsibility
  to enforce wherever it issues the access token; the callee never sees it. With
  access-only that check runs on every mint for free; with refresh it would have
  to be added to the generic refresh path, which today knows nothing about
  installations. So refresh is *safe on drift if RI re-validates on refresh* — the
  cost is coupling, not a safety hole.
- *"A refresh token is a second standing credential in the source's infra"* —
  weak, because the `platform_api` key the source already holds strictly
  dominates it: the key can mint fresh tokens against any installation anyway, so
  a narrower per-installation refresh token adds no exposure.

**So the real basis is simplicity, not safety:** access-only gets drift-checking
for free (every acquisition is a full mint), needs no session rows (ADR-083 §2.2
kept that hot table clean), and has single-mechanism revocation (stop minting;
window ≤ 600 s). Refresh buys only marginally fewer round-trips, which is
negligible for a server integration that mints once per ~10 min and caches. The
SDK docstrings and the integration guide state the re-mint model explicitly so a
partner does not reach for a token manager that cannot refresh this token.

Detail: `SPEC.md` §6.14, `issuer/docs/adr/083-cross-realm-integrations-build.md`
§7.5, `docs/integration-guide.md` § Cross-realm integrations.

## 2026-07-22 — role `assignable_to` + `can_invite_roles` typed into go/ts/java

**Problem.** Two role fields had been live on the wire for releases with no SDK
type: `can_invite_roles` since issuer v0.41.0 (ADR-076 WP4) and `assignable_to`
since v0.55.0 (ADR-081). A partner using the SDK could neither read a role's
principal constraint nor set one — `RoleCreate` silently dropped the field. The
admin console had already worked around it by declaring a local structural type
(`ui/web/src/roleAssignability.ts`, "same local read-back extension pattern the
ADR-078 provider-MFA keys use"), which is the drift ADR-081 § Consequences names
as the standing risk of expressing principal kind in several places.

**Decision — type both, and type the response half too.** `migrated_holders` /
`migrated_holders_to` are read-only and appear only on the PATCH response of a
narrowing that reassigned human holders (ADR-081 §2.5). They are **nullable in
all three languages** (`*int` / optional / boxed `Integer`) for the same reason
`mfa_coverage.percent` is: a reported `0` means "narrowed, moved nobody" and
must stay distinguishable from "the server didn't say". Coercing to 0 would
render a real migration of zero people identically to a field that was never
sent.

**TS gets a union, Go and Java don't.** `PrincipalKind = "human" | "service"`
is a closed server vocabulary (unknown → 400 `unknown_principal_kind`), so in TS
the union catches a typo at compile time — the same argument that made
`StarterRole` a union in web-admin 0.8.9. Go and Java stay `[]string` /
`List<String>`, matching how they already type the equally-closed
`required_mfa_methods`; introducing a Go string-enum type there would be
inconsistent with the sibling field for no added safety (Go would not reject an
unlisted constant anyway).

**The `[]` asymmetry is preserved rather than smoothed over.** Every sibling
array clears on an explicit `[]`; `assignable_to` 400s instead, because ADR-081
§ Amendment 2 deleted "unconstrained" as a storable state. The SDKs do not
paper over this — the doc comments state it, and Go's `omitempty` means an empty
slice omits the key (defaulting to both kinds server-side) rather than
manufacturing a 400. A caller who wants that error can still send it from TS/Java.

**Java records: additive arity.** Both records gained components, so the
canonical constructor changed shape. The previous arities are kept as delegating
constructors — the same back-compat ladder the ADR-075 bump used — so existing
positional callers compile unchanged.

**Found in passing: the Go `Version` const was a release behind its tag** (read
`0.34.0`, published as `go/v0.35.0`). Its own doc comment records this exact
failure from `go/v0.29.0`, where the drift convinced a partner that a shipped
surface was unreleased. Bumped to `0.36.0` with this release. The const has no
consumers in the module, which is why nothing caught it — worth a release-script
assertion rather than another comment (`TODO.md`).

**Not done here:** re-packing `@realm-id/web-admin` and re-vendoring it into
`ui/`, which is what would let the console narrow `AssignableRoleLike` to the
SDK's `RoleObject`. The console's local type is correct and inert today, so that
is a follow-up, not a fix.

## 2026-07-22 — `web-admin` 0.8.9: starter roles (issuer v0.54.0)

Types the opt-in starter-role surface: `PlatformCreate.starter_roles`, a new
`StarterRole = "admin" | "viewer"` union, and
`admin.platforms.seedStarterRoles(platformId, roles)` for the post-creation
endpoint.

A **union rather than `string[]`** because the server menu is closed and an
unknown name is a hard `400 unknown_starter_role` — better to fail at compile
time than at runtime for a typo. It does mean the union must track
`realmrole.StarterRoles`; the issuer has no endpoint advertising the menu, so
this is a knowingly-duplicated literal (noted in `sdk/TODO.md`).

Optional and additive: omitting `starter_roles` reproduces the pre-0.8.9 request
byte-for-byte, so no consumer is forced to change. Re-vendored into `ui/web` as
`realm-id-web-admin-0.8.9.tgz` — the version bump is load-bearing, since the
`file:` pin is by filename and a same-name repack would be masked.


## 2026-07-21 — GET config + GET platform stats typed into go/ts/java

**Problem.** issuer v0.52.0 shipped two read endpoints with no SDK surface:
`GET /platforms/{id}/config` (the read counterpart of the long-standing PATCH —
until it existed the realm config was write-only, so every consumer patched
blind) and `GET /platforms/{pid}/stats` (the platform KPI rollup: orgs, users,
sessions·24h, MFA coverage in one 30s-cached query).

**Decision — two deliberately different typing strategies.**

1. **Config stays a loose map** (`ConfigValues`/`RealmConfigValues`/
   `Map<String,Object>`), mirroring how the PATCH side already takes an untyped
   patch. The read key set is *derived server-side by reflection* from the
   issuer's `RealmConfigPatch` and drift-tested there (`realm.ConfigView`), so a
   hand-maintained struct in three languages would go stale the moment a key is
   added — and would silently drop the new key rather than fail loudly. Only the
   envelope (`{id, config}`) is typed. Documented in each language's doc comment,
   including the server conventions the map obeys: every allowlist key is always
   present, the zero value means "unset", `access_token_custom_claim_keys` is
   never null, `refresh_absolute_expiry` is always the full object.
2. **Stats IS typed** (struct / interface / POJO) — a fixed 6-field shape.
   `mfa_coverage.percent` is **nullable on purpose** (`*float64` / `number|null`
   / boxed `Double`): the issuer returns null when `eligible_users == 0`, and
   coercing it to `0` would render as "nobody has MFA" for an empty population.
   Each language has a dedicated test asserting null decodes as null, not 0.

**Two follow-on decisions taken while wiring web-admin + the UI (same day).**

3. **web-admin types the config, the partner SDKs don't.** The admin console is
   the one consumer that must render individual keys as form controls, so
   `@realm-id/web-admin` carries a real `RealmConfigPatch` (write) and
   `RealmConfigView` (read — every key required, string unions widened to
   `string` because the unset zero is `""`). That duplicates the key list in
   exactly one place instead of four, and it is the place with a UI test that
   fails when a control loses its key. It also let the UI delete its local
   `patchRealmConfig` / `RealmConfigPatch` / `MyPlatformMfaConfig` shims.
4. **`AdminStats` is re-exported, not redeclared.** web-admin had its own loose
   `{[k: string]: unknown}` `AdminStats` for the BFF `/home` section while
   `@realm-id/sdk` had a typed one for `admin.admin.stats()`. Once the UI fed the
   fleet strip from the latter, the two structurally-different types collided at
   the call site. Fixed by deleting the local declaration and re-exporting the
   SDK's — which is also where the four new v0.52.0 fleet fields were added
   (optional, so an older issuer still decodes).

**Placement.** `Get` on the existing ConfigClient; a new `Stats`/`stats` client
hung off the realm handle next to `config`, matching how `roles`/`signingKeys`
are wired. Read-only + additive: no SPEC change, no wire change, no version bump
in this change.

## 2026-07-20 — ADR-080 Phase B + session-revoke + MFA-self typed parity (all 4 SDKs)

**Problem.** issuer v0.50.0 shipped 8 new surfaces backend-only; they were
callable via the BFF `/api/*` passthrough but had no typed SDK methods.

**Decision.** Port all 8 to go/ts/java/web-admin, Go as the reference. Placement
mirrors Go: delink/hand-back on the Users client, `rejectHard` on DriftReviews, a
new `Sessions` client (member + realm-wide revoke), self-MFA on Auth (`admin.mfa`
in web-admin). `DriftRejectResult` was reshaped to the ADR-080 `{mode,parked,
revoked_bindings}` shape (the reject no longer forks a user, so `new_user_id`/
`original_value` are gone).

**Two judgement calls worth recording:**

1. **Flat-envelope decoder bug (go + java).** While adding the
   `contact_admin_required` code I found the Go decoder only extracted the
   specific `code` from the *nested* `{error:{code}}` envelope. The issuer's
   `apiErr.Response()` is FLAT — `{"error":"<msg string>","code":"<code>"}` —
   verified against `issuer/internal/httpapi/types.go` and the BFF's
   `parseUpstreamError` (which explicitly handles "root-level code (flat)"). So
   for every flat error the SDK silently fell back to the HTTP-status class
   (`refresh_invalid`→`unauthorized`, etc.). Fixed the Go decoder to read the
   top-level `code` when `error` is a string; the Java decoder read the code but
   dropped the message, fixed to fall back to the `error` string. TS already
   branched on `typeof error === "object"`, so it was correct. This is a real
   latent-bug fix beyond pure parity.

2. **web-admin bundles a stale `@realm-id/sdk`.** The admin SDK bundles the ts
   SDK's built dist; that dist predated ADR-080. The subagent extended the
   bundled `UsersClient`/`DriftReviewsClient` with local subclasses + local
   result types so web-admin is correct regardless of bundle staleness. At
   repack I rebuilt the ts dist fresh (0.24.0, now with the native methods) and
   re-bundled it — verified web-admin still typechecks + tests green (the local
   overrides are structurally compatible with the now-native base methods), so
   no rework of the extension design was needed. `revokeRealmSessions(realmId)`
   (not `revokeAll`) names the realm-wide op because `revokeAll` already existed
   on web-admin's `SessionsClient` as the *self* op.

## 2026-07-16 — fix: Java `tenants().create` diverged from the contract (route + body)

**Symptom.** The Java SDK's `TenantsClient.create` posted to `POST /tenants`
with a body of `{display_name, owner_user_id?, config?}`. The canonical contract
(`SPEC.md` §6.1, `swagger.yaml` `POST /platforms/{pid}/tenants`) and both peer
SDKs (Go `Create` → `/platforms/{realmID}/tenants`; TS `create` → same, body
`{display_name, allowed_domains?, signup_mode?}`) route platform-scoped and send
a different body. Against the real issuer the Java path would 404/405 (no
`POST /tenants` route) and, even if routed, would send unknown fields
(`owner_user_id`/`config` are not accepted on create) while omitting the
`allowed_domains`/`signup_mode` the contract defines.

**Root cause.** The Java `create` was authored against an imagined shape rather
than the locked SPEC: it invented `owner_user_id` (ownership on create is not a
thing — ADR-076 ownership is set by the seat/invite path, transferred via
`PUT …/owner`) and `config` (config is a separate `PATCH …/config` surface), and
it never carried the implicit realm into the path. `TenantsClient` wasn't even
constructed with the `realmId`, so it *couldn't* build the platform-scoped route
— the divergence was structural, not a typo.

**Why it wasn't caught.** `TenantsClientTest` had no `create` case at all (it
covered list/users/invitations/import/transfer/role but not create), so nothing
asserted the route or body. The record compiled fine because `owner_user_id`/
`config` are valid Java — the mismatch was purely against the wire contract,
which unit tests never exercised.

**Fix.** `TenantCreate` now carries the contract fields
`(displayName, allowedDomains, signupMode)` (dropping `ownerUserId`/`config`);
`TenantsClient` takes `realmId` in its constructor (wired from `Realm`) and
`create` posts to `/platforms/{realmId}/tenants` with
`{display_name, allowed_domains?, signup_mode?}`, omitting the optionals when
null. Matches Go/TS byte-for-byte on the wire.

**Prevention.** Added two pinning tests —
`createRoutesToPlatformScopeAndSendsContractBody` (asserts the
`POST /platforms/{realmId}/tenants` route, the three body fields, **and** that
the retired `owner_user_id`/`config` keys never reappear) and
`createOmitsOptionalFieldsWhenNull`. A silent re-divergence now fails the suite.
No contract/Go/TS change (the contract was already right); Java-only alignment,
no version bump.

## 2026-07-16 — feat: federation-bindings client in all three SDKs (S-06, ADR-057)

**Problem.** The workload-identity federation trust-binding surface
(`/platforms/{id}/federation-bindings` list/create/revoke, ADR-057) had no SDK
client in any language — a partner using WIF had to hand-roll the HTTP.

**Decision.** Added a `federationBindings` client to each SDK, realm-scoped
(the platform id == the realm's id):
- **Go** — `federation_bindings.go`: `FederationBindingsClient` on
  `realm.FederationBindings` with `List` / `Create` / `Revoke`, plus
  `FederationBinding` / `FederationBindingCreate` /
  `FederationBindingRevokeResult` types. All exported funcs use the `ctxpkg`
  context alias (check-gofr hook requirement).
- **TS** — `federation-bindings.ts`: `FederationBindingsClient` on
  `realm.federationBindings` (`list`/`create`/`revoke`); create maps
  camelCase `matchClaims`/`mappedRole` to the snake_case wire.
- **Java** — `federation` package: `FederationBindingsClient` on
  `realm.federationBindings()` with matching records; create omits null
  `mapped_role`/`scope`.

Create sends `{issuer, match_claims, mapped_role?, scope?}` per swagger;
`audience` is server-forced (read-only in the response type). List uses the
shared paginated envelope. Revoke returns `{status:"revoked", id}`.

**Why.** Server contract shipped (ADR-057). Tests in each language exercise
list + create (asserting the snake_case body and, for TS/Java, the
omitted-optional case) + revoke.

## 2026-07-16 — feat: IdP discovery surface ported to TS + Java (S-05, SPEC §6.10)

**Problem.** Public identity-provider discovery
(`GET /platforms/{id}/identity-providers` — the login-provider list a partner
backend fetches for its SPA) existed only in the Go SDK
(`Realm.IdentityProviders`). TS/Java partners had no typed way to call it and
were driven to the raw HTTP path or the wrong client (the admin `IdP config`
CRUD, which is a different resource).

**Decision.** Ported the Go surface into both, keeping the response/opts shape:
- **TS** — new `identity-providers.ts`: `IdentityProvidersClient` wired as
  `realm.identityProviders`, method `discover(opts?)` →
  `{ tenant_id?, providers[] }`; `IdentityProvider` carries `type` /
  `client_type` / `client_id` / optional `config`. `opts.origin` rides as the
  `Origin` header (ADR-047 tenant resolution); `platform`/`tenantId` as query.
- **Java** — new `idp.IdentityProvidersClient` wired as
  `realm.identityProviders()`, `discover()` / `discover(opts)` with
  `PublicIdentityProvider` / `IdentityProvidersResponse` /
  `IdentityProvidersOptions` records.

Named `identityProviders` to sit clearly beside the pre-existing
`identityProviderConfig` (admin CRUD) — the two are distinct resources and the
Realm doc-comments say so. Platform token is auto-attached by each SDK's
transport (no manual bearer).

**Why.** Server contract shipped; pure port-to-parity. Tests assert the
`/platforms/{realmId}/identity-providers` path, the `platform`/`tenant_id`
query, the `Origin` header, and the decoded providers incl. Firebase `config`.

## 2026-07-16 — feat: list filters (role/status/q on users, status on invitations) across all SDKs (S-07)

**Problem.** The issuer supports `role`/`status`/`q` query filters on
`GET /tenants/{id}/users` and `status` on `GET /tenants/{id}/invitations`
(`swagger.yaml`), but no SDK threaded them — a partner could only page the
full list and filter client-side.

**Decision.** Added optional filter inputs to both list methods in all three
SDKs, following each language's existing filtered-list convention:
- **Go** — `UsersClient.List(ctx, tenantID, *UserListOpts{Role,Status,Q})` and
  `InvitationsClient.List(ctx, tenantID, *InvitationListOpts{Status})`,
  matching the `DriftReviewsClient.List` / `ContactVerificationsClient.List`
  opts-pointer shape. Refactored the shared `fetchPage` into
  `fetchFilteredPage` (extra query map merged with cursor/limit); `fetchPage`
  now delegates with nil extra, so Tenants.List is unchanged.
- **TS** — `users.list(id, opts?: UserListOpts & PageOpts)` and
  `invitations.list(id, opts?: InvitationListOpts & PageOpts)`; undefined
  filter values are dropped by the http query builder.
- **Java** — overloads `list(tenantId, UserListOpts)` /
  `list(tenantId, InvitationListOpts)` beside the existing single-arg forms
  (mirrors `ContactVerificationsClient.list`).

Signature changes on Go's `Users.List`/`Invitations.List` (added opts param)
are safe: no SDK-internal or test callers existed. Empty/null filters are
omitted from the query (unfiltered == prior behavior).

**Why.** Server contract shipped; pure port-to-parity. Each language's test
asserts the built query string carries the filters (and that nil opts adds
none).

## 2026-07-16 — feat: `users.importUsers` ported to Go + Java (S-03, ADR-073 Release B)

**Problem.** TS shipped `admin.tenants.users.importUsers`
(`POST /tenants/{id}/users/import`) for whole-file-atomic bulk import; Go and
Java had no equivalent, so those partners could not pre-provision users.

**Decision.** Ported the TS surface verbatim:
- **Go** — new `tenants_import.go`: `UsersClient.ImportUsers(ctx, tenantID,
  []ImportUserRow) (*ImportUsersResult, error)` + `ImportUserRow` /
  `ImportUserRowResult` / `ImportUsersResult` types. Body is `{users: rows}`.
- **Java** — `UsersClient.importUsers(tenantId, List<ImportUserRow>)` +
  `ImportUserRow` / `ImportUserRowResult` / `ImportUsersResult` records. Each
  row is hand-serialized to a snake_case map omitting null fields (mirrors the
  existing `create`/`updateContact` body-building style) so an absent
  bring-your-own `user_id` is omitted, not sent as null.

Both keep the TS contract: the call resolves HTTP 200 regardless (ADR-069
uniform-200) and the caller inspects `committed`, not the status code; a row
without a `user_id` gets a minted id back in its row result.

**Why.** Server contract shipped (issuer live); pure port-to-parity. Tests
assert the `{users:[...]}` body (including the omitted-`user_id` row) and
decode the committed report + minted row id.

## 2026-07-16 — feat: owner-transfer optional params across all three SDKs (WP6, ADR-076)

**Problem.** ADR-076 replaced the propose→accept handshake with a direct
owner-pointer op: `PUT /tenants/{id}/owner` now accepts
`{owner_user_id, outgoing_owner_role?, leave_entirely?}` (issuer
`internal/httpapi/tenants.go` `TransferOwnerRequest`). All three SDKs only
sent `owner_user_id`, so a partner could not, in one call, also demote the
outgoing owner to a chosen role or remove them from the tenant.

**Decision.** Threaded the two optional knobs through every SDK, primary
recipient still positional:
- **Go** — `TransferOwner(ctx, id, newOwnerUserID, opts *TransferOwnerOptions)`
  (`OutgoingOwnerRole`, `LeaveEntirely`). Signature gained an `opts` param
  (pre-release, no external callers); body switched from `map[string]string`
  to `map[string]any` so `leave_entirely` rides as a real bool.
- **TS** — `transferOwner(id, newOwnerUserId, opts?)` with
  `TransferOwnerOptions { outgoingOwnerRole?, leaveEntirely? }`.
- **Java** — overload `transferOwner(id, newOwnerUserId, TransferOwnerOptions)`
  plus the existing 2-arg form (delegates with null opts), keeping source
  compat.

Optional fields are omitted from the body unless set, so the default call is
byte-identical to before (strictly widening).

**Owner fields.** `Tenant.owner_user_id` already existed in all three type
models (Go `OwnerUserID`, TS `owner_user_id`, Java `ownerUserId`) — no change
needed. The ADR-076 `is_owner` flag lives only on the BFF/SPA `/me` response,
which is **not** part of the partner SDK surface (no `/me` client in any
language), so nothing to add there. The swagger `TransferOwnerRequest` schema
is still stale (shows only `new_owner_email`); the issuer handler is the
source of truth per the "code wins" rule — flagged in TODO for a swagger
backfill.

**Why.** Server contract shipped (issuer v0.40.0 live); pure port-to-parity.
Tests in each language assert owner_user_id-only body with nil opts and both
knobs present with opts.

## 2026-07-16 — feat: Java `tenants.updateUserRole` parity (S-04)

**Problem.** The Go (`tenants_role.go`) and TS (`tenants.ts`) SDKs both wrap
`PATCH /tenants/{id}/users/{uid}/role` for changing a member's role; Java had
no equivalent, so a Java partner could not change a member role without hand-
rolling the request.

**Decision.** Added `TenantsClient.updateUserRole(tenantId, userId, role)` +
an `UpdateUserRoleResult` record (`id`/`role`/`tenant_id`/`updated_at`),
mirroring the Go signature and response shape verbatim. Placed on
`TenantsClient` (not `UsersClient`) to match Go/TS, and next to
`transferOwner` since role=owner is rejected there and steered to the
transfer path. `updated_at` typed `Long` (unix seconds JSON number), matching
Go's `int64`.

**Why.** Contract already shipped on the issuer (`swagger.yaml`
`/tenants/{id}/users/{uid}/role`); this is pure port-to-parity, no new server
surface. Test drives the real client against the FakeServer and asserts the
`{role}` body + decoded result.

## 2026-07-15 — fix: TS + Java `auth.login` wire body diverged from the issuer contract (S-01/S-02)

**Symptom.** `POST /auth/login` reads `grant_type` (`provider_token`),
`provider` (the IdP name), and `token` (the IdP credential) — see
`sdk/go/auth.go` `Login`, the reference implementation, which already sends
exactly that triple. The TS SDK's `auth.login` instead posted
`{ realm_id, method, provider_token }`; the Java SDK posted
`{ realm_id, method, token, provider_token }`. Neither field the issuer
reads includes `provider_token`, so in TS the actual IdP credential
(carried only under `provider_token`) never reached the server — the
credential was silently dropped. Java sent the credential correctly under
`token` but also carried the dead `provider_token` key and the doomed
`method` field, which is Sunset 2026-08-01 and due for removal from the
issuer.

**Root cause.** Both language ports were written against an earlier/assumed
wire shape and never reconciled against the issuer's actual `loginReq`
struct or the Go reference SDK, which had already been fixed for ADR-051.
The mock tests in both suites asserted the wrong (as-shipped, not
as-contracted) body fields, so they passed the divergence straight through
CI instead of catching it — mocking your own bug and then asserting the bug
is not the same as testing the contract.

**Fix.** `sdk/ts/src/auth.ts` `login()` and
`sdk/java/.../auth/AuthClient.java` `login()` now send exactly
`{ grant_type: "provider_token", provider: <method>, token: <providerToken> }`
(plus `realm_id`), mirroring `sdk/go/auth.go` verbatim. Removed the `method`
and `provider_token` fields entirely from both. `LoginRequest` shape is
otherwise unchanged (no `tenantId` field existed on either — not invented
here, matches Go's optional-only-when-present threading). Mock tests
(`ts/src/auth.test.ts`, `java/.../AuthClientTest.java`) rewritten to assert
the real wire fields (`grant_type`/`provider`/`token`) and assert absence of
`method`/`provider_token`, so a regression back to the old shape fails the
suite instead of passing it. Verified via Docker (`node:22` — 138/138 TS
tests + `tsc` build; `gradle:8-jdk17` — full Java suite including
`AuthClientTest`). Version bumps only: ts 0.22.0→0.22.1, java
0.20.0→0.20.1; no tag/publish in this change — a human coordinates the
release tags separately (`sdk/CHANGELOG.md` per-package entries added).

**Prevention.** The mock-response pattern in both suites now doubles as the
wire-contract guard by asserting the *complete* expected body (present
fields present, deprecated fields explicitly absent) rather than a loose
subset — the same discipline the Go SDK's tests already followed. No new
tooling; TS/Java should periodically be diffed against `sdk/go/auth.go` as
the reference when touching `/auth/login`-adjacent code.

## 2026-07-15 — SPEC.md rewritten to current surface (doc sweep)

Part of the workspace-wide doc sweep (umbrella `DECISIONS.md` 2026-07-15).
SPEC.md was "locked" at v0.10.0 while the SDKs shipped ~14 further releases.
Decision (user): rewrite the body to the current surface rather than append
amendment blocks — git + `CHANGELOG.md` carry the trail; a patch-on-patch spec
is harder to implement from. Added the shipped surface (listPermissions,
required_mfa_methods, service accounts + view_bff, sources, signing keys,
importUsers, mfa_policy, refresh_exp/idle_ttl/subject_type); refreshed the tag
matrix (go/v0.32.0 · ts-v0.22.0 · java-v0.20.0). Found while writing:
**importUsers exists only in ts + web-admin — go/java parity gap**, noted in
SPEC as a follow-up and logged in the umbrella code-vs-docs review.

## 2026-07-15 — ADR-075: role `required_mfa_methods` write surface

**Problem.** ADR-075 makes the per-role MFA requirement writable; the SDKs
carried `RoleObject.permissions` but not the sibling `required_mfa_methods`, and
create/update had no way to set it.

**Decision.** Mirror `permissions` exactly across go/ts/java: decode
`required_mfa_methods` on `RoleObject`, add `requiredMfaMethods` to
`RoleCreate`/`RolePatch`, forward it as the wire field. Java's records took a new
component with **back-compat constructors** (existing 3-arg `RoleCreate` /
2-arg `RolePatch` callers keep compiling) rather than a breaking signature bump.
The platform `mfa_policy` config key rides the existing generic realm-config
PATCH — no new typed SDK method, since it's one enum on a map already exposed via
the UI shim. web-admin 0.8.5 re-vendored with `Platform.mfa_policy` on the type +
the new bundled roles surface. go/v0.32.0 · ts0.22.0 · java0.20.0 · web-admin0.8.5.

## 2026-07-14 — ADR-074: `roles.listPermissions()` + delete `migrate_to`

**Problem.** ADR-074 made the issuer enforce `realm_roles.permissions` and added
a live catalog endpoint (`GET /platforms/{id}/permissions`) plus a `?migrate_to=`
option on role delete. The SDKs needed to surface both so the admin UI (and
partners) can render a checklist and reassign-on-delete without hand-rolling
requests.

**Decision.**
- **`ListPermissions()` / `listPermissions()`** on the roles client (go/ts/java)
  returns the catalog `[]Permission{key,resource,action,label}`. Served **live**,
  not shipped as a static SDK const — chosen so the UI can never drift from the
  server's catalog (a const would need an SDK re-release on every catalog edit).
  `Permission` is also re-exported from `@realm-id/web-admin` for the browser UI.
- **`Delete(roleID, {migrateTo})`** (ts opts / go variadic `RoleDeleteOpts` / java
  overload) forwards `?migrate_to=<name>` as a raw query param — the simplest
  wire shape, and the BFF `/api/*` passthrough forwards it unchanged (no BFF
  change; pinned by `passthrough_contract_test.go`).

**Compat.** Purely additive — `RoleObject.permissions` already existed; catalog
validation is server-side. Absent the query param, delete behaves exactly as
before (409 on an in-use role). No breaking change; go/ts/java minor bumps +
web-admin 0.8.3→0.8.4 (re-vendored into ui).

## 2026-07-14 — Realign Go `const Version` to the module tag (`go/v0.30.0`)

**Problem.** The Go SDK carries two version counters that had silently diverged:
the resolvable module tag (`go/vX.Y.Z`, source of truth for `go get`) and an
in-code `const Version` (a hand-maintained semver that tracked ADR feature
rounds). At `go/v0.29.0` the tag said `v0.29.0` but the const said `"0.20.0"`. The
Traide team keyed off the const and concluded the ADR-071/072 service-account
surface was **unreleased** — when it was live in `go/v0.29.0`. This is the second
such drift (the const already "skipped 0.15.0" per its own doc comment).

**Options.** (A) Keep the two-counter model, cut the next semantic bump
(`0.20.0→0.21.0`) — perpetuates the divergence, the const would still not match
the tag a partner `go get`s. (B) **Realign the const to the module-tag scheme** and
keep them in lockstep every release.

**Decision — (B).** Set `const Version = "0.30.0"` and cut `go/v0.30.0` so
`realmid.Version` == the module version a partner resolves. Documented the
lockstep rule in the const's doc comment. No functional change — the ADR-071/072
surface is identical to `go/v0.29.0`; this release exists solely to make the
reported version honest. Only the Go SDK is affected (TS/Java version from their
own package manifests, which already match what's published).

**Related (not built, by decision).** The service-session refresh **grace window**
Traide asked about (single-previous-refresh tolerance for a lost rotation
response) — decided **not** to build; on a lost `/auth/token` response the
unattended agent re-provisions (owner re-issues a login OTP). Recorded because it
was weighed and declined, not merely deferred. Note there is no reuse-detection
chain-revoke on the refresh path today, so a stale-token retry only 401s that one
call; it does not kill the live session.

## 2026-07-14 — ADR-073 Release B: `users.importUsers` (`@realm-id/web-admin` 0.8.3)

**What.** New `UsersClient.importUsers(tenantId, rows)` on `@realm-id/sdk`'s
TenantsClient (`admin.tenants.users.importUsers` in web-admin) → `POST
/tenants/{id}/users/import`, plus the wire types `ImportUserRow`,
`ImportUserRowResult`, `ImportUsersResult`, threaded through `@realm-id/sdk/internal`
and re-exported from web-admin for UI consumers.

**Why the shape.** Returns the full report object (never throws on a rejected
file — `committed:false` carries the per-row errors), mirroring the issuer's
200-with-report contract (ADR-069 uniform-200). Rows are plain objects so the UI
can build them from parsed CSV without ceremony.

**Bump.** web-admin 0.8.2 → 0.8.3, re-bundled (fresh sdk/ts dist) + re-packed +
re-vendored into ui — the vendored-tarball pin mandates a version bump.

## 2026-07-14 — ADR-073 Release A: `PlatformCreate.domain` optional (`@realm-id/web-admin` 0.8.2)

**What.** `PlatformsClient.create`'s `PlatformCreate.domain` is now optional and
`slug` is a first-class field on the interface (it was previously bolted on via a
`& { slug: string }` cast at the call site). Omitting `domain` creates a
domainless platform on `<slug>.realmid.dev` (ADR-073 Release A); the issuer
handles the rest. No transport change — the client already POSTs the body
verbatim; this is a types-only relaxation so the UI can legally omit `domain`.

**Why bump.** ui/web vendors the tarball by filename and pins it; a content
change that isn't version-bumped is masked by the pin (the Microsoft-login prod
bug, 2026-06). Bumped 0.8.1 → 0.8.2, re-packed (with the bundled `@realm-id/sdk`
repack gotcha handled), re-vendored into `ui/web/vendor/`.

## 2026-07-14 — ADR-071/072 WP8: web-admin service-accounts + sources surface (`@realm-id/web-admin` 0.8.0)

**What.** Exposed the WP6 service-accounts, sources, and OTP clients on the
browser admin SDK so the owner console (`ui/web`) can reach them through the BFF
`/api/*` passthrough. `admin.serviceAccounts` (ADR-071 `/tenants/{id}/service-accounts`
lifecycle), `admin.sources` (ADR-072 `/sources` CRUD, bound to the admin's
`realmId`), and `admin.otp` (`/auth/otp/issue` — mint a `view_bff` login OTP).

**Decisions.**
- **Reuse the ts resource classes, don't re-implement.** The three clients
  already exist in `@realm-id/sdk` (WP6). Roles/Tenants are exposed on web-admin
  by re-exporting from `@realm-id/sdk/internal`; these weren't in that barrel
  (they're only on the top-level `createRealm` facade). Added them to
  `ts/src/internal.ts` and wired them into `createAdmin` exactly like
  `RolesClient` — one construction path, no duplicated wire logic. The clients
  only call `http.request()`, so the web-admin `HttpLike` transport shim
  satisfies them via the same cast used for `TenantsClient`.
- **Version bump 0.7.1 → 0.8.0 is mandatory (vendored-drift rule).** `ui/web`
  pins web-admin as a `file:` tarball by filename; a content change that reused
  the old version would be masked by the pin (the Microsoft-login prod bug).
  Bumped the version and re-vendored `realm-id-web-admin-0.8.0.tgz`.
- **Repack gotcha honored.** Root `npm install` hoists `@realm-id/sdk` out of
  `packages/admin/node_modules/@realm-id/sdk`; refreshed that copy with a
  freshly-built `ts/` (dist included) before `npm pack` so the tarball carries
  the bundled dep with the new internal exports. Verified `internal.d.ts` in the
  tarball exports `ServiceAccountsClient`/`SourcesClient`/`OtpClient`.

**Tests.** web-admin build + suite green in Docker (node:20-bookworm, 17/17
transport tests). No SPEC change — this is packaging/exposure of an
already-specced WP6 surface. No npm publish (release held/gated).

## 2026-07-14 — ADR-071/072 WP6: ts + java parity port (ts 0.20.0 · java 0.18.0)

**What.** Ported the WP5 go surface to `@realm-id/sdk` and `dev.realmid:sdk`,
one-to-one with the go reference (SPEC is law; go is the surface truth).

**Decisions / how the go semantics mapped to each language's idioms:**

- **OTP login sends `grant_type=otp`, not `method`.** The go reference (WP5)
  posts `grant_type: "otp"` on the OTP login path (the ADR-051 canonical
  discriminator); ts/java `otpLogin` still posted the *legacy* `method` field
  with value `otp_internal`. WP6 aligns them to the go wire shape — `grant_type:
  "otp"`, deprecated `method` dropped — rather than the smaller edit of just
  renaming the `method` value. Rationale: rule #1 of the port is "match the go
  reference exactly," and the issuer's frozen contract (proven by the shipped go
  SDK) accepts `grant_type` on this path. `mfaVerifyOtp` keeps the `method`
  field (that endpoint is method-keyed) with value `otp`.
- **Typed errors via the existing per-language convention, not new sentinels.**
  Go uses `errors.Is` sentinels; ts uses the `RealmError.code` string union +
  `KNOWN_CODES`; java uses the `ErrorCode` enum + `fromWire`. Rather than invent
  a parallel sentinel layer, WP6 adds the new server codes (`handle_taken`,
  `invalid_role`, `service_account_not_found`, `not_service`,
  `method_violates_kind`, `source_not_found`, `user_not_found`) to those
  existing discriminants so callers branch the idiomatic way. Without this the
  ts/java error mapper would have collapsed them to the HTTP-status fallback
  (`conflict`/`bad_request`/`not_found`) and lost the specific code.
- **ServiceAccounts/Sources auth = platform token**, mirroring `RolesClient`
  (no on-behalf ceremony in the SDK) — same call the go reference makes.
- **Surface naming follows each SDK's siblings.** DTO shapes mirror the Roles
  client (raw snake_case response fields in ts `ServiceAccount`/`Source`;
  camelCase mapped inputs like `RoleCreate`). Java uses Jackson records with
  `@JsonProperty` like `Session`/`RoleObject`.
- **Java `OtpIssueRequest` back-compat.** Adding `deliveryMode` to the record
  would break its 5-arg canonical constructor (used by tests + the `forUser`/
  `withBearer` factories), so a delegating 5-arg constructor + a
  `withDeliveryMode(...)` wither were added — no caller breakage.

**Verification.** TS `npm test` 136/136; Java `./gradlew test` 121/121. Tags held
for the coordinated release (WP-level, not per-SDK).

## 2026-07-14 — ADR-071/072 WP5: service accounts + OTP-login cutover + sources (go reference)

**What.** The go SDK (the reference the ts/java ports copy) learns the ADR-071/072
surface now that the issuer contract is frozen.

- **`otp_internal` → `otp`** on the wire (grant_type + mfa method arm). Chose a
  **direct cutover, no dual-accept** — mirrors the issuer (ADR-071 §4), safe
  because `otp_login_enabled` is default-off so no live consumer is on the old
  grant. The constants are named `grantOTP`/`otpMethodMFA` and the SPEC tables
  were corrected in the same commit (spec-is-law).
- **`ServiceAccounts` + `Sources` clients** authenticate with the realm's
  **platform token** (the realm's own M2M admin identity — `requireServiceAccountManage`
  / `requireRealmAdmin` accept it), matching the existing `RolesClient` pattern
  rather than inventing an on-behalf ceremony in the SDK. A BFF that needs
  human attribution uses the on-behalf transport (WP7); the issuer already runs
  `effectiveActor`.
- Added `Sources` to the go SDK even though the plan scoped WP5 to
  `ServiceAccounts` — it's the frozen contract, trivially small, and gives the
  ts/java port + web-admin a reference. `allowed_methods` is passed through
  verbatim; the mapping-1 invariant is validated server-side (the SDK doesn't
  duplicate it).
- **`Session.InitiatedByUserID`** decodes the provenance field (omitempty).

**Tradeoffs.** No on-behalf params on the SDK service-account methods yet — a
partner integrating via go acts as the realm admin. If a partner ever needs to
attribute a service-account mutation to a specific human via the go SDK, add an
optional on-behalf option (mirror `OTP.Issue`'s `UserID`/`UserBearer`). Deferred.

## 2026-07-13 — roles enable/disable + owner signing-keys client (go/v0.28.0 · ts 0.19.0 · java 0.17.0 · web-admin 0.7.1)

**Problem.** The issuer v0.32.0 realm-settings overhaul shipped new endpoints —
role `disable`/`enable`, an owner-scoped signing-keys read + self-serve rotate,
and per-org `role_overrides` / `default_invitation_role` config — but no SDK
spoke them. `Realm-ID/ui` reached them through hand-rolled `api.ts` shims over
the BFF `/api/*` catch-all (the same stopgap class as `patchRealmConfig`).

**Decision.** Give all three language SDKs parity and promote the shims:

- **Roles.** Add `disable`/`enable` to `RolesClient` (they POST
  `…/roles/{id}/disable|enable` and return the role object), a `disabled` /
  `disabled_at` field, and an `includeSystem` list option (surfaces the
  server-hidden `platform_api` row). Kept alongside the existing CRUD/rename —
  the server owns the guard rules (protected role, last-active-role,
  role-is-default), so the SDK just relays.
- **Signing keys.** A **new** `SigningKeysClient` (owner-facing) rather than
  overloading anything: `list()` (keyring + rotation policy) + `rotate()`.
  Deliberately separate from web-admin's pre-existing base-staff ops client
  (`admin.signingKeys`, `/admin/platforms/…`) — different authz, different
  path — so web-admin carries both (`admin.keys` owner, `admin.signingKeys`
  ops). The partner SDKs only get the owner one (they never had the ops route).
- **Org config.** ts adds a typed `TenantConfigPatch`; go/java `updateConfig`
  already took an arbitrary map, so no wire change there.

web-admin reuses the ts `RolesClient` + new `SigningKeysClient` via
`@realm-id/sdk/internal` (no duplicated transport), was re-vendored into the UI
as `realm-id-web-admin-0.7.1.tgz` (version bump so the file-pin can't mask the
change — see the RealmID `ui` vendored-drift note), and the UI's five shims were
deleted.

**Tradeoffs.** (+) One owner signing-keys client, consistent across languages;
the UI now speaks the SDK, not ad-hoc fetches. (−) web-admin exposes two
signing-key surfaces (`keys` vs `signingKeys`) whose names don't self-explain
the ops/owner split — documented on each. All additive + backward compatible.

## 2026-07-11 — `is_base` on `MeMembership` (`@realm-id/web-admin@0.6.1`)

**Problem.** The BFF now marks the base-realm admin tenant on `/me` with an
`is_base` flag (`api/DECISIONS.md`, same date) so admin UIs can drop "RealmID"
from the platform switcher and gate an Internal-Ops/Platform view toggle. The
`web-admin` `MeMembership` type didn't carry the field, so the SPA couldn't read
it type-safely.

**Decision.** Add `is_base?: boolean` to `MeMembership` in
`sdk/web/packages/admin/src/types.ts`. **Optional**, because a pre-`is_base` BFF
omits it and partner-realm sessions never set it — treating absent as `false` is
correct. Bumped `@realm-id/web-admin` 0.6.0 → 0.6.1 and re-vendored the tarball
into `ui/web` (the vendored-drift rule: a content change must bump the version
or the `file:` pin masks the fix).

**Scope.** Type-only, admin SDK only. No behavioural/SPEC change; no other
language SDK touched (this is a browser-admin surface). The repack carried the
usual bundled-`@realm-id/sdk` staging step (see `sdk/CLAUDE.md`).

## 2026-07-10 — surface `idle_ttl` from login/token/refresh (ADR-070 idle session timeout)

**Problem.** The issuer is gaining a per-realm **sliding-window idle timeout**
(ADR-070): a session that goes idle longer than a configured duration dies even
if its refresh token is otherwise still valid. The issuer now emits `idle_ttl`
(JSON integer, seconds — the idle-window duration) on the login, token, and
refresh responses, right alongside the existing `refresh_exp`. Nothing in the
SDKs surfaced it, so the BFF (the session-store owner) couldn't read the value
to enforce the idle window.

**Decision.** Mirror `refresh_exp`/`RefreshExp` **exactly**, per language, on the
same result types and the same decode spots — Go `Session.IdleTTL` +
`MintResult.IdleTTL` (`json:"idle_ttl,omitempty"`); TS `LoginResponse.idleTtl` +
`TokenResponse.idleTtl` (optional, mapped from wire `idle_ttl` in `mapAuthResp`
and the token mapper); Java `Session.idleTtl` + `TokenResponse.idleTtl`
(`@JsonProperty("idle_ttl") @JsonAlias("idleTtl") long`). It rides the exact same
plumbing, naming, and optionality conventions as `refresh_exp` — the SDK stays a
pass-through; enforcement is the BFF's job.

**Backward-compatible.** Optional / omitempty everywhere; absent or `0` means "no
idle timeout" and must decode cleanly to `0` (Go/Java) / `undefined` (TS) —
callers treat that as *disabled*, never *expire now*. A pre-ADR-070 issuer that
omits the field is unaffected. Guard tests assert both the present-value decode
and the absent→0/undefined fallback on Session and the token/mint result across
all three languages.

**Scope.** SDK slice only — the issuer emit path, the per-realm config knob, and
the BFF enforcement land in their own repos; the orchestrator tags/releases
centrally. Version numbers deliberately left as "next"/pending in each CHANGELOG.

## 2026-07-10 — SPEC §3: document the uniform-200 success/envelope contract (issuer ADR-069)

**Problem.** The issuer reconciled a wire-vs-swagger drift (ADR-069): ~30
POST/DELETE endpoints had been shipping GoFr-native `201`/`204` while swagger
documented `200`. The corrected contract is a uniform `200` `{data:...}` envelope
with `201` only for genuine resource creation, and `200`-with-body for all
DELETEs. SPEC.md never stated the success-status boundary explicitly.

**Decision.** Add the success-vs-failure rule to SPEC §3: success is the **entire
`2xx` class** (never an exact `200` check), with the envelope + the 201-create
exception spelled out. **Descriptive only** — every SDK already implements exactly
this (Go `< 400`, TS `resp.ok`, Java `200 ≤ s < 300`; the CLI's `exitForStatus`
treats `< 400` as OK), so ADR-069 is backward-compatible and needs **no SDK code
change and no version bump**. Verified all three transports + the CLI before
writing.

**Tradeoff.** Documenting an already-honored behavior risks looking like a no-op,
but the explicit boundary is what stops a future SDK author (or a raw-HTTP partner)
from reintroducing an exact-`200` check that the ~30 drifted endpoints would break.

## 2026-07-09 — `refresh_exp` on the wire (SPEC §4.1) + drop the dead `Origin.DetachedAt`

Two SDK-contract changes cut together (go/v0.26.0 + ts-v0.17.0 + java-v0.15.0).

### `refresh_exp` — surface the refresh token's absolute expiry (#10)

**Problem.** `Session`/`MintResult` carried only `expires_in` (the *access*
token TTL). The refresh token's absolute expiry — computed issuer-side as the
min of the rolling TTL, the ADR-054 scheduled cutoff, and the ADR-058 absolute
session cap — was never surfaced. A consumer that sizes a session from the
refresh lifetime (the BFF session store) had to *guess* it: `api/` hardcoded a
30-day ceiling (`buildRecord`). That guess diverges from realm policy — a realm
with a >30d refresh evicts live sessions early; a <30d realm keeps a dead
session "alive" until the next refresh fails.

**Decision.** Add `refresh_exp` (unix seconds) to the login (`§4.1`) and token
(`§4.2`) responses, wired through all three SDKs (`Session.RefreshExp`,
`MintResult.RefreshExp`; TS `refreshExp?`; Java `refreshExp`). **Optional /
forward-compatible:** absent decodes as `0`/`undefined`, and consumers MUST fall
back to a local ceiling on the zero value — so a new SDK against an old issuer,
or an old SDK against a new issuer, both keep working. Options weighed:
(a) surface it on the wire *(chosen — honest, one source of truth in realm
config)*; (b) have the BFF re-read `refresh_absolute_expiry` from realm config
on every login *(rejected — couples the BFF to issuer config semantics + adds a
config fetch on the hot path)*; (c) leave the 30d guess *(rejected — wrong for
any realm that overrides the default)*. Issuer emit lands in `v0.28.0`; BFF
consume in `v0.17.0`.

### Drop `Origin.DetachedAt` — it was dead code re-arming the v0.21.0 outage (#7)

**Problem.** Go `Origin` declared `DetachedAt *string json:"detached_at"` and
`fetchAllowlist` skipped rows where it was set. But the issuer's
`domainMappingDTO` **never serializes `detached_at`**, and the origins list is
already filtered to live rows server-side (`ListByEntity` → `detached_at IS
NULL`). So the field was always `nil` and the filter never fired — dead code.
Worse, it re-armed the exact go/v0.21.0 outage class: the `created_at` comment
right above it documents that a `*string` field receiving a JSON *number* throws
on the origins hot-path decode. If anyone ever added `detached_at` to the DTO
the natural way (`.Unix()` → a number), sign-in would break again.

**Decision.** Delete the field + the dead filter. The SDK uses plain
`encoding/json` (no `DisallowUnknownFields` — verified), so a future
`detached_at` on the wire is harmlessly ignored; keeping the mistyped `*string`
was the *only* dangerous state. Considered retyping to `*int64` for
forward-compatible defense-in-depth, but the server-side filter is the actual
contract and removal is the smaller, safer surface.

## 2026-07-08 — `SessionInfo` last-used timestamp reconciled to the issuer's `last_seen_at` field (Go / TS / Java)

**Symptom.** `ListSessions`/`listSessions` returned session records whose
last-used timestamp was always empty — Go `SessionInfo.LastUsedAt == 0`, Java
`Session#lastUsedAt() == null`, TS `SessionInfo` never carried the value at
runtime. Session creation time populated fine; only the "last active" column was
dead.

**Root cause.** Field-name drift between the issuer's serializer and every SDK.
The issuer's `sessionDTO` emits the last-used timestamp as **`last_seen_at`**
(verified: `issuer/internal/httpapi/sessions.go`, `LastSeenAt int64
\`json:"last_seen_at,omitempty"\``, set via `s.LastSeenAt.Unix()` — int64 unix
seconds). All three SDKs decoded **`last_used_at`** instead:
- Go: the `SessionInfo.LastUsedAt` json tag *and* the live `decodeSessionPage`
  path read `intField(obj, "last_used_at")`.
- Java: `Session` record `@JsonProperty("last_used_at")`.
- TS: `SessionInfo` used camelCase `lastUsedAt?: string`, but `listSessions`
  returns the parsed server JSON with **no snake→camel mapping** (unlike
  `login`, which maps via `mapAuthResp`), so both the name *and* the case were
  wrong and the field silently fell into the `[k: string]: unknown` index
  signature.

This was independent of the v0.22.0 timestamp outage: that fix corrected the
wire *type* (`string`→`int64`) but left the field *name* wrong, so `LastUsedAt`
stayed zero.

**Why it wasn't caught.** The existing `ListSessions` tests asserted only
`id`/`created_at`; no test exercised the last-used field, and `created_at`
happened to match the wire name, masking the drift. The SDKs are decoded against
hand-built mock payloads, never against a real issuer `sessionDTO`, so the
name mismatch never surfaced. TS additionally has no compile-time guard because
`listSessions` casts untransformed server JSON straight to the interface.

**Fix.** Point every SDK at the verified server field name (`last_seen_at`,
int64 unix seconds), keeping each language's public accessor name
(`LastUsedAt`/`lastUsedAt()`) for API stability and cross-language parity:
- Go: json tag `last_used_at`→`last_seen_at` on `SessionInfo.LastUsedAt`, and
  `decodeSessionPage` now reads `last_seen_at` (the live path).
- Java: `Session` `@JsonProperty("last_seen_at")` + `@JsonAlias` retains the old
  names defensively.
- TS: `SessionInfo` rewritten to the honest wire shape (`id`, `origin?`,
  `device_name?`, `created_at?: number`, `last_seen_at?: number`) since
  `listSessions` does no key mapping — the old camelCase fields were never
  populated. Dropped the phantom `userAgent`/`ip` fields the `sessionDTO`
  doesn't emit.

**Regression guard.** Go: a direct-unmarshal test of a representative issuer
payload (`TestSessionInfo_UnmarshalIssuerPayload`) plus an extended
`ListSessions` decode assertion. TS: `auth.listSessions` test asserting
`last_seen_at` decodes. Java: `listSessionsDecodesLastSeenAt`.

**Prevention.** All three regression tests key their payloads off the real
`sessionDTO` field names, so a future rename on either side breaks a test. TODO
item ticked off. (Broader class — the SDKs decode against mock payloads, not a
live issuer response — remains; a contract test against the issuer's actual DTO
would be the durable fix, noted for later.)

## 2026-07-05 — `@realm-id/web@0.4.5`: `resolveTenant()` — complete a tenant-picker gate without re-running the provider redirect

**Symptom.** Microsoft sign-in on a realm-root origin (`app.realmid.dev`) bounced
through the IdP **twice**: click "Log in with Microsoft" → Microsoft →
platform-picker → **Microsoft again** (a flash of the IdP) → dashboard.

**Root cause.** The OIDC redirect driver (`signIn`/`completeSignIn`) exchanges
the auth code for an `id_token`, calls `login(...)`, and — crucially — **does
not retain that `id_token`**; it's a local in `completeSignIn`. When the login
gates on `tenants_required` (a user in ≥2 platforms), the app had no token to
re-submit, so its only way to attach the chosen tenant was to call `signIn`
again — a full new OIDC authorize/redirect round-trip. The Firebase/Google-popup
path never showed this because the *app* (AuthGate) holds that `idToken` in React
state and re-submits it directly; only the redirect providers (microsoft/google
OIDC), whose token lives inside the SDK, were affected.

**Options.** (a) Surface the `id_token` in the `tenants_required` error body so
the app can re-submit it — rejected: leaks the raw provider token into app state
for no benefit. (b) **Retain the provider credential inside the SDK across the
gate and expose `resolveTenant(tenantId)`** that re-POSTs `/login` with the same
`{method, providerToken}` + the picked tenant — chosen: keeps the token
encapsulated, single-use (cleared on session-issue and on anon/logout), and gives
the app one uniform call for both popup and redirect providers.

**Tradeoff / scope.** Retention is triggered on `tenants_required` only. The
`session_limit_reached` provider-retry path still re-redirects (`signIn`); it's a
rarer flow and a genuine re-auth-after-revoke, tracked in `TODO.md` rather than
widened here. Reusing the same `id_token` seconds later is well within Entra's
token lifetime and passes the issuer's Microsoft verifier identically.

**Verified.** Additive + backward-compatible (patch; peers pin `^0.4.0`).
Unit test `realm.test.ts` "resolveTenant re-submits the SAME provider token…"
asserts exactly two `/login` calls (gated + resolved), the second carrying the
original token + chosen tenant, and single-use exhaustion. UI wiring (AuthGate +
vendored-tarball bump) lands in `Realm-ID/ui`.

## 2026-07-05 — `go/v0.25.0`: retire the deprecated `method` login field on the RIGHT hop (ADR-051)

**Problem.** ADR-051 deprecated the `method` field on the issuer's `/auth/login`
in favour of `grant_type` (+ `provider`), with a hard Sunset of **2026-08-01**.
After 0.3.5 mistargeted this on the web SDK (see the 0.3.6 entry below), the
migration was re-scoped to where the deprecated field actually lives: the
**BFF→issuer** hop, sent by the Go SDK (`sdk/go/auth.go`).

**Decision.** `Auth.Login` sends `grant_type=provider_token`+`provider=<idp>`;
`OTPLogin` sends `grant_type=otp_internal`. Both drop `method`.

- **Why fixed grant, not a method→grant map in the SDK?** `Auth.Login` is
  definitionally a provider-token exchange — `LoginMethod` only ever names an IdP
  (firebase/google/microsoft). So the grant is a constant and the method string
  is exactly the `provider` hint the issuer wants. A lookup table would only
  re-encode what the issuer's `legacyMethodToGrant` already did, on the wrong
  side of the wire.
- **Public API preserved.** Callers still pass `LoginMethod`; the change is
  wire-only. No BFF handler change needed — it already forwards `LoginMethod`
  through `realmid.LoginRequest`.
- **Tradeoff / sequencing.** The BFF (`api/`) was pinned at `sdk/go v0.21.0`;
  shipping this needs a bump to v0.25.0 + a BFF redeploy. Safe: v0.22 (timestamp
  hotfix) + v0.23/v0.24 (additive) carry no breaking change, verified by building
  the BFF against the local SDK. Against issuer ≥v0.27.1 there is zero
  behavioural change (it accepts both forms); the win is that the issuer's compat
  shim becomes dead code the moment every caller is ≥0.25.0, deletable at sunset.
- **Not touched.** `MFAVerify`'s `method` is the MFA-factor selector
  (totp/otp_internal) on `/auth/mfa/verify`, unrelated to the ADR-051 login
  selector — left as-is.

Links: `CHANGELOG.md` go/v0.25.0; issuer `internal/httpapi/auth.go`
`legacyMethodToGrant`; ADR-051.

## 2026-07-05 — `web-bff-realmid@0.3.6`: revert 0.3.5 — the web SDK migration targeted the wrong hop

**What went wrong.** 0.3.5 changed the web SDK's `/login` body from `method` to
`grant_type=provider_token`+`provider`, on the premise that the web SDK rode the
ADR-051-deprecated `method` field. It does not. The web SDK talks to the **BFF**
(`api.realmid.dev`), whose `/login` is a typed handler with its OWN contract —
`{ method, token }` (`api/internal/handlers/handlers.go` rejects a missing
`method` with `method and token are required`). The deprecated issuer `method`
field is on the **BFF→issuer** hop, sent by the **Go SDK** (`sdk/go/auth.go`).
0.3.5 therefore broke login (`method and token are required`) while touching a
non-deprecated contract.

**Correction.** Revert the login adapter to send `method` (0.3.6, re-vendored as
ui v0.11.4). The original Microsoft bug was already fixed by issuer v0.27.1 (the
shim maps `method:"microsoft"` on the Go SDK hop); the web SDK change was
unnecessary. The REAL migration — retiring the deprecated field before the
2026-08-01 sunset — is a **Go SDK** change (`auth.go` login body: send
`grant_type`+`provider`) plus a BFF go.mod bump, tracked in root `TODO.md`. The
web↔BFF `method` contract is the BFF's own API and stays.

**Lesson.** Identify which hop owns a field before "migrating" it. Two services
can name a field `method` and mean different contracts; the deprecation applied
to only one of them.

## 2026-07-05 — `web-bff-realmid@0.3.5`: migrate login off the deprecated `method` field to `grant_type`

**Problem.** ADR-051 (issuer v0.7.0) reworked `/auth/login` to dispatch on
`grant_type` and deprecated the `method` field with a hard Sunset of 2026-08-01.
The server migrated; the web SDK never did — its login adapter still sent
`{ method }`, so EVERY web login (google/firebase/microsoft) rode the issuer's
`legacyMethodToGrant` compat shim. The deprecated field was the *only* path the
live web app used. That inversion caused the Microsoft outage: microsoft was
added as a provider everywhere except the shim's lookup table, so login failed
`grant_type is required` (patched issuer-side in v0.27.1 by adding the case).

**Decision.** Fix the client, not just the shim: the adapter now emits
`grant_type=provider_token` + `provider=<idp>` for provider logins,
`grant_type=otp_internal` for OTP, `grant_type=password` for native password, and
falls back to `method` only for methods without a first-class grant. The mapping
mirrors the issuer's `legacyMethodToGrant` exactly, so downstream behavior is
identical — only the dispatch key moves onto the wire.

**Why this is the real fix.** The issuer v0.27.1 shim patch unblocked prod, but
left the deprecated path load-bearing: at Sunset, removing the shim would take
all web login down. With the SDK on `grant_type`, provider logins no longer
depend on the shim at all, and the issuer can delete it on schedule. The shim
stays until Sunset only for any *other* legacy clients.

**Tradeoff.** Requires a re-vendor into `ui/web` (0.3.4 → 0.3.5) and a UI deploy.
Verified: bff-realmid tests assert the new wire shape (grant_type + provider, no
`method`); the full ui/web suite is green against the re-vendored SDK. See
`issuer/DECISIONS.md` (2026-07-05) for the RCA and root `TODO.md` for the shim
removal at Sunset.

## 2026-07-05 — `web-bff-realmid@0.3.4`: bump forced by a fix that shipped without a version bump

**Symptom.** Microsoft sign-in on prod threw `no microsoft provider configured
for this realm`, even though the base realm's Microsoft provider was correctly
configured (verified against the live BFF endpoint). Google/Firebase worked.

**Root cause.** The BFF's public providers response names the provider field
`type`; the `realmidBffPreset()` `adaptProviders` adapter read `provider`,
mapping Microsoft's provider to `""`. `resolveProvider` — reached **only** by
the OIDC/PKCE `signIn` path (Microsoft; Google/Firebase use the Firebase popup)
— then found no matching row and threw. Latent until the first Microsoft login.

**Why it wasn't caught (the real decision here).** The adapter code was *already
fixed* in `014bf4e` (`p.type ?? p.provider`), but that commit **did not bump the
version** — so the vendored `realm-id-web-bff-realmid-0.3.3.tgz` in `ui/web`,
packed before the fix, still carried the bug. Same version string, two different
contents. The pre-existing adapter test also mocked the *wrong* wire field
(`provider:` instead of `type:`), so it passed against buggy code.

**Decision.** Bump to `0.3.4` (content changed ⇒ version must change — the rule
`014bf4e` broke) to force a re-vendor into `ui/web`, and add a regression test
that uses the **real** wire shape (`type`, no `provider`). Consumers pin these
by tarball filename, so a version bump is the only reliable re-vendor trigger.

**Tradeoff / follow-up.** Vendored tarballs (not npm) mean drift like this is
invisible until someone re-packs. Longer-term fix is publishing `@realm-id/web*`
to npm (already the stated end-state in `ui/web/vendor/README.md`); until then,
"bump on every content change" is the discipline that prevents recurrence.

## 2026-07-04 — Purge partner identifiers + private-repo references from the public SDK repo (working tree + history)

**Problem.** `Realm-ID/sdk` is a **public** GitHub repo (all sibling repos —
`issuer`, `api`, `ui`, `project` — are private). It carried three partner
names, their real production domains, and their internal architecture in
world-readable files:

- An unreferenced customer-named "fit assessment" doc under `web/docs/` that
  described a named partner's private React auth code **and a security
  weakness** (refresh token in `localStorage` / XSS).
- `SPEC.md`, `CHANGELOG.md`, `CLAUDE.md` — partner names in headings and prose.
- Test fixtures (`*.go`/`*.ts`/`*.java`) — real partner domains and Firebase
  project/client IDs as fixture values.
- Published READMEs + `docs/operations.md` + `web/BFF-SPEC.md` — links to the
  **private** `Realm-ID/api` / `Realm-ID/issuer` repos and internal ADR relative
  paths (dead 404s that also leak private repo structure).

**Working-tree scrub.** Partner identifiers → neutral placeholders (a neutral
`example.com` audience, a `demo-app` Firebase project); partner names in prose →
"a partner" / "worked examples"; the fit-assessment doc deleted (unreferenced;
its SDK-mapping value is covered by `docs/quickstart.md` + `integration-guide.md`);
private-repo links → the public `api.realmid.dev` endpoint or `BFF-SPEC.md`.
Verified with `go test ./...` (pass) and `npm test` (113/113).

**History rewrite — decided against the recommendation.** The scrub alone left
the identifiers in git history and, critically, in the **Go module proxy**:
`proxy.golang.org` had already cached every published `go/vX.Y.Z` version, and
those cached zips (with the partner names in test fixtures) are immutable and
**cannot be recalled** by any GitHub rewrite. The owner chose a full
`git filter-repo` rewrite anyway, accepting two known costs: (1) it does **not**
purge the Go-proxy copies, so the honest mitigation remains **notifying the named
partners**; (2) rewriting the `go/` test fixtures changes the module content
hash, so `sum.golang.org` will report a checksum mismatch for previously
published Go versions fetched fresh (cache-miss) after the force-push — existing
consumers should move to a newly cut version. Executed via `--replace-text`
(all partner tokens across all blobs) + `--invert-paths` (remove the doc from
every commit); 48 tags repointed; `main` + tags force-pushed. Pre-rewrite state
bundled to `/tmp/sdk-history-rewrite/sdk-pre-rewrite.bundle` for recovery.

**Scope note — bare ADR numbers kept.** `SPEC.md`/`CHANGELOG.md` still cite ADR
numbers as opaque text; only ADR *hyperlinks/relative-paths into private repos*
were removed. (The public **website** partner guide was rewritten with zero ADR
references — see `website/DECISIONS.md`.)

## 2026-07-01 — `restore()` must send the session bearer; tokenless sessions outlive the access-TTL (web/v0.4.4)

**Symptom.** Reloading `app.realmid.dev` more than ~15 min after the last token
mint signed the user out. A first reload often showed a degraded page
(`network error calling GET /admin/platforms: no current tenant`) while still
"logged in"; a second reload logged out outright. This persisted after the BFF
`/me` self-heal (api v0.15.4) fixed the server half.

**Root cause (client half, `@realm-id/web`).** Two defects in
`packages/core/src/realm.ts`, both around session restore under the BFF /
tokenless-rotation model (where the client holds an opaque, durable session
bearer `rsid_…` that the BFF rotates server-side, and `Authorization: Bearer
rsid_…` is the *only* accepted credential — no cookie):

1. **`restore()` sent a bearerless `/me`.** It called
   `transport.request("GET", /me, { gates })` with no `accessToken`, so no
   `Authorization` header went out. The BFF's `loadSession` returns 401
   `session_missing` ("missing session bearer") for that, so the background
   revalidation *always* failed and `restore()` dropped the session to
   anonymous + cleared storage — racing the app's own authed `/me` (which does
   attach the bearer via `realm.fetch`). That race produced both the transient
   `no current tenant` and the sign-out. The refresh path already attached
   `this.tokens.peek()` (with a comment naming this exact failure); `restore()`
   was simply never given the same treatment.
2. **`readStoredSession` discarded the durable session at the 15m access-TTL.**
   It cleared storage and returned null when the snapshot's `expiresAt` (the
   short-lived access-JWT hint) passed. Under tokenless rotation the stored
   `accessToken` is the *durable* session bearer, not a self-expiring token, so
   discarding it threw away the credential — leaving `restore()` with nothing
   to attach even after fix (1), so a >15m reload still had no bearer.

**Why it wasn't caught.** The existing restore test's mock `/me` returned 200
regardless of the `Authorization` header, so a bearerless `/me` "passed" in the
suite while failing against the real BFF — the same fake-vs-real gap that has
bitten this platform before. The deterministic trigger (a real >15m-expired
session) never ran in CI.

**Decision.**
- `restore()` attaches `accessToken: this.tokens.peek() ?? undefined` so the
  revalidation is authenticated in every mode (correct for classic self-expiring
  bearers too; `undefined` on a genuine cold start keeps the anonymous probe).
- `readStoredSession` skips the `expiresAt` discard **only** when
  `refresh.tokenless` is set — the flag that means "the stored bearer is the
  durable, server-rotated session token." The snapshot is adopted (optimistic
  paint) and `restore()`'s authenticated `/me` becomes the sole authority on
  validity, clearing storage on a real 401. Classic mode is untouched.
- Gated on `tokenless` rather than removing the expiry check outright so
  non-BFF consumers (stored token IS the access token) keep the "don't paint
  state we're about to throw away" behaviour.

**Tests.** Rewrote the restore mock to be BFF-faithful (401 `session_missing`
without an `Authorization` bearer). Two regression tests — `restore()` must
carry the bearer; a tokenless reload >15m after mint keeps the session — both
went red against the pre-fix code, reproducing the prod sign-out, then green.

**Prevention.** SDK tests that model the BFF must reject a bearerless
authenticated call, not accept it. Any authenticated background call the SDK
makes on the user's behalf (restore, poll, revalidate) must attach the session
bearer, mirroring `realm.fetch`. Pairs with api v0.15.4 (`DECISIONS.md` there).

## 2026-06 — session-limit 412 gate: collect the issuer's nested-error siblings

**Symptom.** The UI's `SessionLimitModal` had no `revocation_token`/`active_sessions` to
list sessions — the BFF flattened the 412 to `{code, message}`.

**Root cause (in the SDK, not the BFF).** The issuer nests the gate fields *inside* the
error object (`{error:{code,message,revocation_token,active_sessions}}`), but `sdk/go`
`mapErrorResponse` only collected siblings from the **top level** → `RealmError.Details`
empty → the BFF had nothing to carry.

**Decision.** `sdk/go` `http.go` now collects nested-error siblings; api `MapSDKError`
carries `Details` onto the envelope via `ErrWithDetails`. Unit-tested both sides
(`http_test.go`, `errors_test.go`). The same nested-collection fix also unblocked the
MFA-registration gate payloads. **Shipped** — `sdk/go` first tag `go/v0.17.0`, `api/go.mod`
pins `v0.21.0` (≥ the fix), and `session-limit.spec.ts` is un-skipped (verified 2026-07-04).
