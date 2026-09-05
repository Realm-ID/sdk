# Changelog

All notable changes to the Realm ID SDK monorepo. Each SDK
(`ts/`, `go/`, `java/`) ships independently; cross-cutting items
that affect every SDK at once are recorded under a shared heading.

> **Tag forms — read this before `go get`.** The Go module is a
> subdirectory module (`github.com/Realm-ID/sdk/go`), so its release
> tags MUST use the **slash** form `go/vX.Y.Z` — that is the only form
> the Go toolchain resolves for `go get github.com/Realm-ID/sdk/go@vX.Y.Z`.
> The `go-vX.Y.Z` **hyphen** form that appears in older headings below is
> a legacy human label (a one-off that stopped at `go-v0.10.0`); it is
> **not** a resolvable module version. TS and Java are not subdirectory
> Go modules, so their `ts-vX.Y.Z` / `java-vX.Y.Z` labels are fine as-is.

## go `0.58.1` — doc-only: a collision that cannot happen (2026-09-05)

### Fixed — `IdentityResolvedEvent.UserID`'s doc comment described an impossible failure

The comment told partners that keying a mirror on `UserID` alone "silently
splits or collides humans across orgs". Only the SPLIT is possible: `sub` is
the per-tenant `users` row id, so one human in two orgs has two of them. A
COLLISION is unrepresentable — the issuer's `users` is one global table with
`id UUID PRIMARY KEY` and a row id is never rewritten, so no two principals
can share a `sub`. The comment now names the failure that can occur and says
why the other cannot, so nobody writes de-duplication they will never need.

**No behaviour change; this is a comment.** It is a release only because the
Go module tag IS the release: `go/v0.58.0` is immutable and already resolved
by the proxy, so any change under `go/` — a comment included — must answer to
a new version rather than re-point an old one. `scripts/tag-hygiene.sh
unreleased-go` is what makes that a build failure instead of a convention.

The same correction lands in `ts/src/identity-resolved.ts`,
`java/.../IdentityResolvedEvent.java`, `SPEC.md` §4.1.7 and
`docs/design/pre-mint-hook.md` with no version bump — neither of those
languages publishes from an immutable tag.

## go `0.58.0` — `OnIdentityResolved`, the seam before the derived claims (2026-09-05)

### Added — `Config.OnIdentityResolved`

A partner resolving their ADR-097 `scope` claim in `Config.Scopes` reads their
own local user row, and that row is written by their reconciler AFTER the
session exists. A new user's FIRST login therefore resolved against a row that
did not exist and was minted scope-less — which every gate reads as "no granted
authority" — and the only repair was an extra `/auth/token` round trip on every
login, forever. They could not seed the row inside `Scopes`: side-effect freedom
is a written contract there, backed by a real three-attempt retry loop, so their
write would have run up to three times per mint.

`Config.OnIdentityResolved` is the side-effecting twin of those two pure,
retried resolvers. It fires once per DERIVED-CLAIMS RESOLUTION, with the settled
`(user, tenant)`, immediately before `ProductRoles` and `Scopes` are resolved:
`Login`, `CompleteLogin`, `OTPLogin`, `PasswordLogin`, `MFAVerify`
(`MFAVerifyOTP` through it) — **and refresh**. In a BFF deployment the refresh
route IS the tenant-choice route (the middleware requires `tenant_id` on it and
has no separate choice route), so a login-only hook would have missed the moment
a new `(user, tenant)` pair first appears. `if ev.Flow == FlowRefresh { return
nil }` opts out.

**Not "once per authentication", and it says so.** A multi-tenant login settles
no tenant and fires nothing; the choice fires it, and a later tenant SWITCH
fires it again for the new tenant. It does not fire on `Auth.Token` called
directly (the raw primitive every lane above routes through) and it CANNOT fire
on the credential-bootstrapped lanes, which produce no user and no tenant.

**Configured on `Config`, deliberately NOT on `MiddlewareOptions`** — the seam
is `mintProductRoles` + `enrichRefreshMint`, reached from every
session-producing lane, so a direct client that never touches the middleware
gets it for free and there is no second code path to drift. **No middleware file
changed.**

**A non-nil error REFUSES THE MINT, unconditionally, with no fail-open knob.**
This is not new authority: a failing `Config.Scopes` already fails every login
on the realm today. Minting past a failed seed would hand back a token whose
`scope` was resolved against a missing or stale row — a confidently wrong
authority claim our logs record as a clean 200. Best-effort is one line
(`return nil`), the idiom `OnAuthSuccess` already prescribes; a knob would only
be a second way to say it, and adding one later is additive while removing one
is breaking.

**It cannot fail an AUTHENTICATION — only the DELIVERY of a session.** On the
login lanes the error rides `*LoginMintError`, which carries the intact session
and its refresh token (the ADR-102 OQ8 recovery anchor). Through the middleware
no cookie is written but the issuer-side session is live and orphaned until it
expires. On refresh the hook necessarily runs after the first `/auth/token`, so
the presented refresh token has already rotated and the error is an
UNRECOVERABLE LOGOUT rather than a retryable failure. All three are already true
of a `*ScopesError` today; they are now written down.

**Not retried — so it must be idempotent. Upsert, do not insert.** The retry is
the user's (they log in again), and a tenant switch fires it a second time. No
SDK-side "already fired" memo: that needs an identity key, a TTL and an eviction
policy, and it would silently stop firing after a partner restored their
database from a backup. No synthetic deadline and no goroutine race either — the
SDK cannot bound `ScopesHandler` today, so bounding only the new hook would be
theatre, and abandoning a handler leaks it while its write lands after the error
was returned. The caller's context deadline is the bound.

New: `IdentityResolvedHandler`, `IdentityResolvedEvent`, `IdentityResolvedError`,
and the `AuthFlow` values `FlowOTP`, `FlowPassword`, `FlowTenantChoice`. The
event carries no tokens by design — the token in hand at that instant is the
PRE-derived-claims one, so a hook reading it would see absent-scope and conclude
"no granted authority", the exact misreading this seam exists to prevent — and
mutating it is inert, because a hook that could rewrite the tenant would
redirect the resolution away from what the issuer authenticated. `UserID` is the
JWT `sub`, which is a MEMBERSHIP and not a person: key your mirror on
`(TenantID, UserID)`.

### Changed — the refresh subject-peek no longer degrades silently

`enrichRefreshMint`'s short-circuit now consults the hook as well as the two
resolvers, so a hook-only consumer is not silently skipped on refresh. And when
the freshly-minted access token's `sub` is unreadable, the refresh is REFUSED
instead of degrading — **only when `OnIdentityResolved` is set**. The hook's
contract is "identity is known"; silently not firing is precisely the failure
the partner reported. Resolver-only consumers keep today's degrade path exactly.
This is the only behaviour change in the release and it reaches zero existing
consumers — nobody can have configured a handler that did not exist yet.

### Tests

`TestIdentityResolvedRunsBeforeScopeResolution` is the one that matters, and it
is CAUSAL rather than order-logging: the hook writes into a map, `Scopes`
returns whatever it finds in that map, and the assertion is on the `scope` the
mint carried. Confirmed RED first (build failure, then — with the fire site
moved below `resolveScopes` — `scope on the mint = <nil>`). Until this file NO
Go test configured `Scopes:` and a hook on one realm; they lived in disjoint
universes, so their relative order was untested in BOTH directions, which is how
this shipped. `TestEveryResolverCallSiteAlsoFiresTheHook` extends the AST lane
walk so no future function may resolve the derived claims without announcing the
identity first — but it proves CO-OCCURRENCE, NOT ORDER (it stayed green under
the mutation above), so the two are complements and neither substitutes for the
other. Plus lane coverage for all five login lanes and refresh, once-per-tenant,
the mint refusal and its `LoginMintError` anchor, exactly-one-fire-on-failure,
mutation-inertness, the peek-failure branch in both configurations, and
`TestAuthFlowValuesAreDistinct` (the three new lane constants are declared
relative to the last one in `middleware.go`, so a constant appended there would
collide).

**Non-breaking.** `Config` gains a field, which is additive for every keyed
struct literal; an unkeyed `Config{...}` composite literal would break, but that
is neither idiomatic nor used anywhere here, and it was already true of the last
several fields added to this struct.

## go `0.57.2` — two role-template seat-check sentinels (2026-09-05)

Issuer v0.121.0 added `role_template_seated` (409) and
`role_template_seat_check_failed` (503) on `PATCH`/`DELETE
/platforms/{id}/role-templates/{templateId}`. Neither joins the general
`ErrorCode` taxonomy — that family (`role_template_exists`,
`role_authoring_retired`, etc.) never has, in any of the three SDKs. Instead
`roletemplates.go` gets two new sentinels, `ErrRoleTemplateSeated` and
`ErrRoleTemplateSeatCheckFailed`, mapped the same way as their siblings.

**Not interchangeable.** `role_template_seated` is a recoverable conflict —
retry the same call with `?override_seated=true` (audited). Do NOT read
`role_template_seat_check_failed` the same way: the seat count itself could
not be taken, so no parameter rescues it and a retry loop around it can never
succeed. See `sdk/DECISIONS.md` 2026-09-05 for why the general taxonomy was
the wrong home for this pair.

`TestRoleTemplates_ErrorsMapToSentinels` extended with both codes (confirmed
red first — `undefined: ErrRoleTemplateSeated`), full suite green, `go vet`
clean. `0.57.1` was already tagged, so this PR bumps `const Version` per the
"first `go/` change after a release" rule.

### Added (same-day follow-up, owner ruling) — `RoleTemplateWriteOpts.OverrideSeated`

An SDK must not report an error whose stated remedy is unreachable through
it: `role_template_seated` names `?override_seated=true` as its remedy, and
until this addition nothing in the Go SDK could send it. `Update` and
`Delete` both gained a trailing `opts ...RoleTemplateWriteOpts` — the same
variadic-opts convention `RolesClient.Delete` already uses for `migrate_to`
— non-breaking, since a trailing variadic accepts zero arguments. Sent ONLY
as `override_seated=true`; the issuer accepts no other value as meaningful,
so an explicit `false` is omitted exactly like an unset default — never
serialized as `override_seated=false`. Does **not** rescue
`ErrRoleTemplateSeatCheckFailed` (503) — that refusal stays unconditional,
and every doc comment says so beside the flag. Tests confirmed red first
(build failure before the type/param existed), full suite green.

## go `0.57.1` — the changelog entry `0.57.0` shipped without (2026-09-04)

**No code change. `0.57.0` and `0.57.1` are the same module**, byte-for-byte
apart from `const Version` and this heading.

`go/v0.57.0` was pushed before its changelog entries existed, so
`changelog-hygiene.sh` refused the release — correctly. The Go module proxy
serves a tag directly, which makes a `go/v*` tag immutable the moment anything
fetches it, and `v0.57.0` was already live (`proxy.golang.org` answers 200). So
the tag cannot be re-pointed and the gate on it can never go green.

The documented recovery is the next patch version, and this is it. `v0.57.0`
stays published and works; it is simply the version whose release verification
failed. **Prefer `v0.57.1`.**

The ts/java/web tags were re-cut instead, which is sanctioned and was safe here
for a reason worth stating: their gate runs BEFORE the publisher, so npm and
Maven had seen nothing (verified against both registries — npm still on
`0.48.0`, Maven on `0.45.0`). Go is the odd one out precisely because the tag
IS the release.

## go `0.57.0` · ts `0.50.0` · java `0.47.0` — Java gets ADR-041's revocation cache, and two codes stop being invisible (2026-09-04)

go `0.57.0` · ts `0.50.0` · java `0.47.0` · `@realm-id/web-admin` `0.17.0`
(it bundles `@realm-id/sdk`, so it has to carry the `last_owner` code).
Three fixes found while building ADR-107 and while answering a partner; none of
them is ADR-107 work, and they ship in the same release as it.

### Added — `RevocationCache` in Java

go and ts have carried the ADR-041 jti denylist since that ADR. **Java had no
equivalent at all**, so a Java partner had no stop-the-bleed between "the user
clicked logout" and the access token's stateless natural expiry — up to
`access_ttl_seconds`, 900s by default — and nothing in the API said so.

The absence was invisible for the usual reasons: nothing failed, no interface
was missing from anywhere anyone looked, and `TokensClient.isRevoked` sits next
door doing a different job, which is why the capability read as present at a
glance. It surfaced only because ADR-107's own D2 rationale asserted that
widening this interface "breaks ts and Java at runtime, silently" — an argument
about a thing that was not there.

`dev.realmid.sdk.revocation.{RevocationCache, MemRevocationCache}`, consulted by
the verifier after signature and claim checks and BEFORE the ADR-107 authority
check (a revoked token needs no further questions asked of it). Fails closed on
a cache error. `Realm.builder().revocation(...)`, and `logout` pushes the access
token's jti when `LogoutRequest.accessToken` is set — best-effort by design,
since the server-side refresh revocation is the load-bearing operation and has
already happened.

**The tests assert the CONSULTATION, not the cache**, and that was verified by
mutation: stubbing the verifier's check to `false` makes `revokedJtiIsRejected`
and `revocationCacheOutageFailsClosed` both fail. A published interface the
verifier never reads would be worse than the honest absence it replaces, because
it would read as protection.

### Fixed — `last_owner` was promised by doc comments and declared by nothing

The issuer returns `409 last_owner` on BOTH owner-protection paths (change the
owner's role; deactivate the owner). Two SDK doc comments named the code. **No
taxonomy declared it**, so `mapErrorResponse` fell back to the status and every
caller in every language received a generic `conflict`.

Found because a partner reported their handler "had no `last_owner` case" — the
SDK had never given them one. A doc comment describing a code the SDK then
flattens is worse than silence: you write the branch, test it against a mock,
and it never fires in production.

`scripts/taxonomy-parity.py` structurally cannot catch this class — it checks
the three languages against each other, and all three were equally missing it.
Agreement is exactly what a shared oversight looks like, which is what that
gate's own header already says.

### Documented — three ways to hold a correct API wrong

All reported by one integrator, all cases where the code does what it says and
the documentation describes a safety property the caller is not getting:

- **`LivePermissionResolver` must not derive its answer from the token's own
  claims.** A resolver returning `permsByRole[claims.role]` satisfies the
  two-operand contract while making the live operand a function of the stale
  one — live with respect to what a ROLE can do, stale with respect to WHICH
  role the person holds.
- **`capAllows` is a ONE-operand check on human sessions.** `permissions_cap` is
  minted in exactly one place in the issuer, so a non-key session never carries
  one and the cap contributes nothing.
- **An ADR-097 compatibility ramp keyed on "is `scope` empty" is a silent
  authority-model switch**, and it is dead code until the day it decides
  everything. The SDK's own gate fails closed; the ramp is what degrades.

## go `0.57.0` · ts `0.50.0` · java `0.47.0` · web `0.7.0` — logout, demotion and promotion propagate inside the SDK (ADR-107, 2026-09-04)

Cross-cutting. **Ships in the same release as the entry above** — go `0.57.0` ·
ts `0.50.0` · java `0.47.0` · `@realm-id/web` `0.7.0` · `@realm-id/web-react`
`0.5.1` · `@realm-id/web-admin` `0.17.0`. (`0.56.0`/`0.49.0`/`0.46.0` were
committed while this was being built and never tagged; those numbers do not
exist as releases.) All four surfaces ship together — a partial roll puts a
code on the wire that some clients read as a hard 401.
**Nothing in the issuer changes.** Spec §3.1 + new §5.3.

Builds on the `Unreleased` entry below, which is its stated prerequisite: for an
ADR-097/102 partner, a forced refresh that does not re-resolve `scope` and
`product_roles` returns a token exactly as stale as the one it replaced.

### Added — `AuthorityCache`, a SECOND cache beside the jti denylist

- `RevocationCache` is a **jti denylist**, and that is the whole of what it can
  express. It serves logout for one reason: the user presents their own token,
  so the SDK holds the jti when it needs it. An admin demoting a colleague holds
  neither that colleague's token nor its jti, and there is no `user → live jtis`
  index — so demotion was **structurally inexpressible**, not merely missing.
- `AuthorityCache` is keyed by `sub` and stores a `notBefore` **timestamp**. A
  boolean could not self-heal: it would reject the REFRESHED token too, locking
  the user out for the entry's whole TTL and turning a demotion into an outage.
- A **separate interface**, not a widened one. Partners run their own backends
  behind `RevocationCache`; adding a method breaks Go at compile time (loud) and
  ts/Java at runtime, silently — a duck-typed object just lacks the method and
  demotion never fires, with nothing to observe.
- `MemAuthorityCache` ships as the single-process default. **Multi-replica
  partners must supply a shared backend**; a marker written on one replica is
  invisible to the others, and the SDK cannot detect the second replica to warn.
- Opt-in everywhere. Unset → the verifier behaves exactly as it did before.

### Added — `notifyAuthorityChanged`, the one method a partner calls

- `realm.notifyAuthorityChanged({subject, intent})` in all three server SDKs.
  The SDK owns everything after it: storage, TTLs, the check, the wire code and
  the client-side retry cap.
- `subject` is the `sub` claim — **the per-membership users-row id, not a
  person**. Demoting someone in org A deliberately leaves their org B token
  alone. A partner passing an identity id silently propagates nothing.
- `intent` is required and never inferred. Demotion does NOT evict the session,
  so a method that guessed would eventually guess "log them out" on a routine
  role edit. Signing someone out stays `sessions.revokeUser` (ADR-080).
- Calling it with **no cache configured is an error, not a no-op** — silence
  there means a partner believes demotion is propagating while nothing is
  stored.

### Added — `token_stale`, a new 401 in the taxonomy

- Emitted by `verify()` and by nothing else; **no issuer handler produces it.**
- Distinct from `unauthorized` for the same reason `refresh_invalid` is: a
  client that collapses every 401 into "sign the user out" would sign people out
  on **promotion** — on a grant that just widened their access.
- The 401 status is set at the throw site, so a partner verifying by hand (no
  SDK middleware in the path) still gets the status the contract promises.
- `IsTokenStale` / `isTokenStale` / `ErrorCode.TOKEN_STALE`. Registered in all
  three taxonomies in the same change; `scripts/taxonomy-parity.py` is the gate.

### Added — the refresh is capped at ONCE per token (the loop-breaker)

- The real hazard was never the 900s window. Stamp `notBefore` from the
  partner's clock, compare it to an `iat` from the issuer's, and two seconds of
  forward skew makes every freshly-minted token stale: refresh, fail, refresh,
  from every replica, aimed at the mint endpoint.
- Two guards. The marker is stamped at `now − 30s`, never bare `now` — erring
  early costs one harmless extra refresh and can never place the marker in the
  issuer's future. And `TokenManager.handleStale` refuses to refresh a second
  time for a token that a forced refresh itself produced.
- `@realm-id/web` carries the same cap in `realm.fetch`, per tenant.

### Changed — the browser SDK no longer signs users out on a `token_stale` 401

- `classifyHttpStatus` reads `token_stale` off the body **by name**. It is
  deliberately not a blanket "trust the body's code" rule — `.code` stays a
  classification and `.body.code` stays the fact — but this one code cannot be
  inferred from a 401 whose message is prose.
- `restore()` no longer drops the session to anonymous on it. The session
  continues; only the access token is replaced.

### Stated limit — out-of-band changes (ADR-107 D14)

A role edited from the RealmID console, the CLI, or a partner back-office that
does not call `notifyAuthorityChanged` stays stale for up to the realm's
`access_ttl_seconds` — **900s when unset**, and `0` from
`GET /platforms/{id}/config` means unset, not zero. That is the accepted cost of
a partner-local cache, and it is the number to quote publicly, not the ~0 on
notified paths.

### Note — Java never had `RevocationCache` at all

Measured, not assumed: there is no `RevocationCache` anywhere in
`java/src/main`. So ADR-107 D2's "widening breaks ts/Java silently at runtime"
is **vacuous for Java** — there was nothing to widen. The separate interface
still stands on its own merits (two keys, two lifetimes, two questions), but the
argument as written over-claims. Filed in `TODO.md`: Java partners have no
stop-the-bleed on logout either, which is a real gap ADR-107 does not close.

## Unreleased — every session-producing lane resolves the derived claims (2026-09-03)

Cross-cutting: all three SDKs, same change. **Prerequisite for ADR-107.**

⚠️ **This is worse than "a lane missing a claim", and the ADR-107 entry above is
the other half of the same issue.** A partner migrating onto ADR-097 keeps their
pre-cutover authorization path and ramps between the two on whether `scope` is
populated. A token minted with no `scope` therefore does not merely lose the
claim — it **routes every request onto the legacy decider**, a branch that is
dead code in normal operation and so is the branch nobody tests. One integrator
found their ramp landed on a resolver keyed off the token's own `role`, i.e. a
stale one. If you run a ramp, treat an empty `scope` as an incident signal
rather than a fallback condition (partner guide §4.2).

### Fixed — two lanes handed back a token with no `product_roles` and no `scope`

- **`otpLogin` and `mfaVerify`** (and `mfaVerifyOtp`, which delegates to it)
  returned the raw session without running the derived-claims mint. For an
  ADR-097 partner that token reads as **no granted authority**, so their own
  gate denies the holder everywhere — on the MFA lane, immediately after the
  user passes a second factor. `login`, `completeLogin` and `passwordLogin`
  were unaffected.
- `mfaVerify` also did none of the tenant-id / user-id normalisation the other
  lanes do, so it had no user id to resolve the handlers against.

### Added — the lane set is derived, not written down

- `go/derived_claims_lanes_test.go` computes the subject list from the package
  AST: every function returning a `*Session` must reach `mintProductRoles`.
  A new lane fails the guard on the day it is written.
- The prose list it replaces (*"three call sites — Login, CompleteLogin,
  PasswordLogin"*) is how both lanes shipped uncovered, and is deleted rather
  than corrected. The partner report that prompted this named ONE of the two;
  the parser found both.
- Behavioural mirrors in ts (`derived-claims-lanes.test.ts`) and java
  (`DerivedClaimsLanesTest`), one test per lane.

## go `0.55.0` · ts `0.48.0` · java `0.45.0` — the pagination envelope (2026-09-03)

Cross-cutting: all three SDKs, same change.

### Added — the pagination envelope is no longer discarded, and two new error codes

- **Four list methods returned a bare array and threw the envelope away**:
  `sources.list`, `serviceAccounts.list`, `userApiKeys.list` and
  `apiKeys.list`. They now return the pager, so a caller can page AND detect
  truncation. Every field the issuer's S4/S5/S6 releases added was previously
  discarded before any caller could see it.
- `has_more` is the terminator, **ahead of** `next_cursor`. **Absent is NOT
  false** — it is derived from `next_cursor`, which is correct for every
  endpoint predating the field. Re-encoding pins `has_more: false` as an
  explicit `false`, not a dropped key.
- **New error codes `invalid_cursor` and `invalid_limit`** (issuer `v0.118.x`
  rejects malformed `?cursor=`/`?limit=` with a `400` instead of absorbing it).
  Registered in the taxonomy AND covered by a test asserting the code ARRIVES
  on a decoded error — a registry proves the constant exists, only that proves
  a caller can branch on it.
- Guarded by a **decode → RE-ENCODE round-trip test**. A decode-only assertion
  passes whether or not a field is carried onward, which is exactly how
  `go/v0.53.0` silently deleted `credential_methods`.
- An unset `limit` is OMITTED from the query string rather than sent as
  `limit=0`, which the issuer now rejects. Pinned by a test on the serialised
  URL, not on the intent of the code.

⚠️ **Version numbers were forced, not chosen.** npm already served
`@realm-id/sdk 0.47.0`, Maven already served `0.44.0`, and `go/v0.54.0` was
already published — each with DIFFERENT content from the working tree. Re-using
any of them would have shipped stale bytes under a live version. The same trap
had just been hit inside `web-admin`, where re-packing `0.14.0` left the STALE
bundle installed through `npm install`, `--force` and `rm -rf node_modules`,
because the lockfile pins an `integrity` hash per filename. **"Never published"
is not an exemption.**

`go/realmid.go`'s `const Version` moves with the tag: `go/v0.51.0` once shipped
a `Version` that lied.

## Pagination input error codes — go · ts · java · web-admin `0.15.0` (2026-09-03)

- **`invalid_cursor` and `invalid_limit` added to all three error taxonomies**
  (both `400`). The issuer now refuses malformed pagination input instead of
  absorbing it. Two codes because the remedy differs: `invalid_cursor` means
  restart the walk, `invalid_limit` means fix your constant. Unregistered, they
  would surface as a bare `bad_request` and callers could not branch — the
  `go/v0.52.0` failure. Each language has a test asserting the code ARRIVES,
  not just that the constant exists.
- **Wire check on the pagers shipped earlier today**: an unset `limit`/`cursor`
  is OMITTED from the query string in Go, TS, Java and web-admin — verified
  against the serialised URL, with tests now pinning it per language across all
  four converted methods. `limit=0` would have `400`d every list call.
- `@realm-id/web-admin` `0.14.0` → `0.15.0` — a new version because re-packing
  `0.14.0` did NOT reach the consumer (npm honours the lockfile integrity even
  for an unpublished file: dependency). `0.14.0` was never published.

## Pagination envelope reaches the caller — go · ts · java · web-admin `0.14.0` (2026-09-03)

**Breaking, and deliberately so** — four list methods returned a bare array and
now return the same pager every other paginated list has returned for releases.
Unversioned for `ts`/`go`/`java`: committed, not published.

- **`sources.list`, `serviceAccounts.list`, `userApiKeys.list`, `apiKeys.list`
  return `Paginated<T>`** (Go `*Paginated[T]`, TS `Paginated<T>`, Java
  `Paginated<T>`), not `[]T`. They discarded `next_cursor`/`has_more`/`total`
  before any caller saw them, so a caller could neither page nor detect
  truncation — every field the three issuer releases beneath them added was
  invisible. `apiKeys.list` was found by sweep, not reported; its own doc
  comment already named the envelope it was throwing away.
  - Go: `realm.Sources.List(ctx).All(ctx)` / `.Page(ctx, &PageOpts{Limit: 50})`
  - TS: `for await (const s of realm.sources.list())` / `.page({ limit: 50 })`
  - Java: `realm.sources().list().stream()` / `.page(PageOpts.withLimit(50))`
- **`has_more` on the page envelope**, in all three languages. It is the
  truncation signal (not derivable from `items`) AND the page walk's terminator,
  ahead of `next_cursor`. An ABSENT `has_more` is derived from `next_cursor`,
  never read as `false`.
- **`writePage` (ts) / `PageWriter` (java) / `Page` JSON tags (go)** — a public
  re-encoder, so a consumer that decodes a page and re-emits it has one correct
  way to do it. Each SDK gained a decode → re-encode round-trip test.
- **Removed**: the flat-array / `{api_keys}` tolerances in the user-api-key and
  api-key list decoders. SPEC §7 locks the wire; a bad shape is now a
  `server_error` rather than an empty list.
- **`@realm-id/web-admin` `0.13.0` → `0.14.0`** — its package-local
  `ApiKeysClient.list` had the same defect and is fixed the same way; the
  package now re-exports `Paginated`/`Page`/`PageOpts`/`readPage`/`writePage`.
- **Doc comments** that promised "every source / service account / key" are
  corrected — three issuer releases had made them false.
- `SPEC.md` §7 documents all of the above. Go: `ServiceAccountList` is
  deprecated but kept.

## Derived claims were resolved on LOGIN LANES ONLY — go `0.54.0` · ts `0.47.0` · java `0.44.0` (2026-09-01)

**Fixes a live defect and unblocks an ADR-097 cutover.** `product_roles` and
`scope` are resolved per mint — but nothing resolved them on a REFRESH, so a
BFF-fronted session carried them for one access-TTL and then lost them for the
rest of its life.

- `mintProductRoles` had exactly three call sites — `Login`, `CompleteLogin`,
  `PasswordLogin` — and all three are login lanes. The middleware's refresh
  minted with `{RefreshToken, TenantID, CustomClaims}` alone, and `Token`
  forwards only what it is handed.
- **`product_roles` was silently dropped on every refresh.** A partner who
  adopted ADR-102 saw the claim at login and lost it one TTL later. Our own
  `product_roles.go` promised the opposite in writing the whole time: *"It runs
  on EVERY mint, refresh included, and nothing caches."*
- **`scope` had the same hole with a sharper edge.** The issuer never stores
  `scope` on a session — deliberately, so it cannot go stale — so an unrequested
  claim is an ABSENT one, and `ScopesFrom` reads absence as no granted
  authority. A `ScopePolicy` gate therefore begins denying everything one
  access-TTL into every session.

**Shipped in all three SDKs** — go `0.54.0`, ts `0.47.0`, java `0.44.0`. A
partial port would be worse than none: the claim this seam makes is "resolved at
every mint", and a partner on the unported language would read that promise and
get the old behaviour.

**New:** `Config.Scopes` (`ScopesHandler`) — `config.scopes` in ts,
`Realm.Builder.scopes(...)` in java — the `scope` twin of
`Config.ProductRoles` — same signature, same retry budget, same side-effect-free
contract, same "empty result mints no claim" rule. Use it, not
`TokenRequest.Scope`, for anything that must reach human sessions: a per-call
field only covers mints a partner writes by hand, and in a BFF deployment the
middleware builds the request itself.

**Behaviour change worth knowing:** a refresh now costs a SECOND `/auth/token`
round trip — but only when a handler is configured. The refresh lane has no user
id until a token comes back (the subject lives in the access token), so the order
is mint → read the subject locally → resolve → re-mint. Consumers who adopt
neither handler still mint exactly once, and a test asserts the COUNT so the
extra call cannot creep in unnoticed.

⚠️ **The nil/empty rules across the three claims are NOT uniform, and that is
deliberate.** `product_roles` and `scope` key on EMPTINESS (nil and empty both
mint no claim); `role_permissions` keys on NIL, because an empty non-nil list is
a real instruction the issuer answers with a `403`. Do not harmonise them.

**Java** ports the same seam: `Realm.Builder.scopes(ScopesHandler)`,
`ScopesException` (deliberately not a `RealmException`, mirroring
`ProductRolesException`), and `AuthClient.enrichRefreshMint` wired into
`RealmFilter.handleRefresh`. Additive only — `AuthClient` gains a 5-argument
constructor and keeps the old ones, and no record component changed. Java's
`TokenManager` is left alone for the same reason Go's is: it is the
single-identity daemon lane, not the human-session lane the middleware fronts.

## `credential_methods` was being dropped by the SDKs — go `0.53.1` · ts `0.46.1` · java `0.43.1` (2026-09-01)

### Fixed — the discovery response no longer DELETES `credential_methods`

`IdentityProvidersResponse` had no field for it, in all three SDKs. The
reference BFF does not read discovery — it DECODES the issuer's response into
that type and RE-SERIALISES it to the browser — so the field was dropped in
transit, silently, with no error at any layer.

⚠️ **The effect was that ADR-103/104 credential sign-in was unreachable from
any BFF-fronted console**, which is precisely the failure `credential_methods`
was designed to prevent. The issuer advertised it correctly, `@realm-id/web`
mapped it, `LoginPage` rendered from it — and the SDK in the middle deleted it.

Proven end-to-end against a live stack before and after: straight from the
issuer the response carries `credential_methods: ["password"]`; through the BFF
it was ABSENT.

Every layer's own tests passed over this. The issuer's integration suite
asserts the issuer EMITS it; the console's unit tests assert the screen renders
GIVEN it; nothing asserted it SURVIVES the hop between them. The new guard is a
decode → re-encode round trip rather than a decode-only assertion, because
reading a field back off a struct you just populated passes whether or not the
field is carried onward. Mutation-verified: tagging the field `json:"-"` turns
it red.

Absent still means "the server did not say", never "none" — a second test
asserts an omitted field is not re-emitted as an empty list.

## ADR-102/103/104/105 — go `0.53.0` · ts `0.46.0` · java `0.43.0` · `web` `0.6.0` · `web-admin` `0.13.0` (2026-09-01)

### BREAKING — `login` MINTS now (ADR-102 D10)

Once the tenant is settled, `login` follows `/auth/login` with a `/auth/token`
mint, and the new `productRoles` handler runs there.

- **Single tenant** → mints immediately; one call, as today.
- **Several tenants** → does NOT mint. The tenant list and the refresh token come
  back; your app presents the choice and calls `completeLogin` on selection.
- ⚠️ **Do NOT settle the multi-tenant branch with `selectTenant`.** Its
  `tenants[0]` fallback would mint for an ARBITRARY tenant and resolve THAT
  tenant's roles — a silent wrong answer, not an error.
- **The `412 mfa_required` gate now surfaces from `login`**, where it previously
  surfaced from your own `token()` call. That is the visible half of the change.
- A CHANGED entry point rather than a new one, deliberately: a `loginAndMint`
  would have been non-breaking and would have left the default wrong — every
  consumer who never knew to re-mint keeps the role-blind token.
- **The session `login` created is NOT discarded when the mint fails.** It is the
  recovery anchor: a handler failure is often tenant-specific, so the user can
  choose a different org and mint without re-authenticating.
- **No handler + an access token already in hand costs NO extra round trip**, so
  consumers who never adopt the claim pay nothing.

### Added — `product_roles`, the partner's role NAME on the token (ADR-102)

- A `productRoles` handler `(tenantId, userId) -> string[]`, wired where each
  language wires a realm-level hook (Go a `Config` field, TS a config property,
  Java a `Realm.Builder` method).
- ⚠️ **SIDE-EFFECT FREEDOM IS A CONTRACT.** The SDK calls it an unspecified
  number of times per mint (it retries), so it MUST NOT write, bill, audit or
  emit. A partner logging "role resolved" inside it will see triple entries.
- **No handler → claim omitted, no error.** **Empty or nil → claim omitted, not
  `[]`**: absent and empty must mean the same thing, since every token issued
  before ADR-102 has no claim at all.
- **An error RETRIES (3 attempts, ~50ms then ~150ms) then REFUSES the mint.**
  Minting anyway would say "this principal has no product roles", which is
  indistinguishable from the truth for a principal who genuinely has none — a
  silent under-grant that surfaces as a 403 storm in YOUR product with a 200 in
  our logs. The failure is a distinct SDK error wrapping yours, never a
  `RealmError`: your outage and ours are different incidents.
- It runs on EVERY mint, refresh included. Nothing caches — that freshness is the
  whole advantage over `customClaims`.
- ⚠️ `scope` carries AUTHORITY; this carries a NAME. Do not branch authorization
  on it, and do not confuse it with the `role` claim, which is RealmID's OWN
  vocabulary and a trusted authorization lookup key on the direct-bearer lane.

### Added — cross-language parity that D10 depends on

`needsTenantChoice`, `selectTenant` and `TenantRef.mfaRequired` existed **only in
Go**. A hand-mirrored surface with a hole in it is how the hole survived; D10's
multi-tenant branch depends on all three, so closing the gap was a prerequisite
rather than a tidy-up.

### BREAKING — user API keys are bound to ONE org (ADR-105)

- `orgScope` / `org_scope` and `orgIDs` / `org_ids` are **removed** from the
  write payload, the row shape and the exported types. The row carries `orgId`:
  the minting principal's own tenant, never client-supplied.
- `org_scope: "all"` (every org in the realm the holder belongs to, forward
  inclusive) is deleted along with the realm knobs that gated it.
- A caller needing N orgs mints N keys — strictly better, because revoking one
  then revokes one.
- Measured before deciding: **prod held 0 `user_api_keys` rows**. Zero rows is
  not zero surface, though — the types break.
- ⚠️ The empty-intersection refusal is now **unconditional**: the narrowing used
  to be per-org and the error named which, but a key has one org now and there
  is no "try another org" recovery to point at.

### Added — phone login parity (ADR-103)

- `deliveryMode` accepts `"email"` and `"sms"` alongside `"view_bff"`, with
  constants in all three languages.
- ⚠️ For `purpose=login` the mode decides **who may be authenticated**, not
  merely how the code travels: `view_bff` is read by the PARTNER, so it
  authenticates `kind=service` subjects only; `sms` is read by the SUBJECT, so it
  authenticates any kind; `email` is refused.
- No fallback between the RI-delivered modes.

### Added — native username/password login (ADR-104)

- `passwordLogin` / `PasswordLogin`, taking `identifier` + `presented` +
  optional `tenantId`.
- `identifier` may be an email, an E.164 phone, or a **username**, classified
  ONCE by the issuer.
- ⚠️ **`tenantId` is load-bearing for a username.** Usernames are unique per
  TENANT, not per realm. Explicit wins over the host-derived tenant; neither
  yielding one is `400 tenant_required`, a NAMED code rather than a credential
  failure.
- `403 password_must_change` is NOT collapsed into `invalid_credentials`: the
  password was correct, but an admin set it, so it is an assertion rather than a
  proof.

Spec `0.37.0` → `0.38.0`. Rationale: `DECISIONS.md`, 2026-08-31.

## go `0.52.1` — the four new error codes were never registered in Go (2026-08-31)

No API change. `0.52.0` declared `ErrPermissionsRequired`, `ErrUnknownPermission`,
`ErrPermissionsExceedGrantor` and `ErrInstallGrantsNothing` and mapped them in
`mapIntegrationErr`, but never added the four strings to `go/errors.go`'s
taxonomy — the const block and `knownCodes`. ts and Java declared all four.

**What that actually cost, stated precisely rather than repeating the release
note's own claim.** The sentinels DO fire in `0.52.0`: `specificCode` reads the
envelope siblings before `re.Code`, so `errors.Is(err, ErrPermissionsRequired)`
matches. What is wrong is `RealmError.Code` — unregistered, the specific string
never lands there, so a Go caller branching on `.Code` sees `bad_request` /
`forbidden` where a ts or Java caller sees `permissions_required`. A
cross-language divergence in the one field callers branch on.

**`publish-maven` became idempotent in the same commit, for a reason that turned
out to be wrong.** The stated justification was that re-pushing a release tag
would fail on a duplicate upload and leave a permanently red run. Measured: it
does not. The `java-v0.42.0` re-cut ran the step unguarded and went GREEN, and
every file on Central kept its original timestamp — Central accepted nothing and
rejected nothing. The guard is kept because it makes that no-op explicit rather
than implicit, not because it prevents a failure.

**Caught by the parity gate, which was RED on `main` before the release and did
not stop it.** `scripts/taxonomy-parity.py` reported the drift on the install-fix
commit itself. Nothing consults CI on the way to a tag, so `go/v0.52.0` shipped
over a red gate that was naming this exact defect. That is the second time in two
days a red ancestor reached a release.

Fixed forward — `go/v0.52.0` is immutable and the proxy has cached it.

⚠️ The registration lives in **THREE** hand-maintained lists, and adding a code
to two of them leaves the build broken in a way only the third reports: the
const block, `knownCodes`, and `declared` in `errors_taxonomy_test.go`. The test
compares its own length against `knownCodes` precisely so a two-of-three edit
cannot pass.

## BREAKING — `integrations.install()` was sending a field the issuer retired — go `0.52.0` · ts `0.45.0` · java `0.42.0` · `web-admin` `0.12.0` (2026-08-31)

**This call has been returning `400 permissions_required` in production.** Not a
deprecation, not drift — a broken call, in every language, for as long as
ADR-101 D7 has been live.

The issuer replaced the install's `role_id` with a STATED `permissions` list:
the install says what the brokered principal may do, rather than naming a role
and inheriting whatever that role happens to grant today. The SDKs kept sending
`role_id`.

### Why it shipped, and why nothing caught it

**The tests asserted the old wire shape.** `ts/src/integrations.test.ts` asserted
the body was `{integration_id, role_id}`; the Go test asserted the same. They
stayed green for the entire period the call was failing, because they pinned the
implementation rather than the effect. A test that asserts what the code does
cannot notice that what it does is wrong.

The new tests assert `permissions` IS sent **and that `role_id` is ABSENT**.
Asserting only the first would still pass for a client sending both.

### Changed — all three languages

- `InstallRequest`: `permissions: string[]` replaces `role_id`. Required and
  non-empty — an install granting nothing can authorise no call, and ADR-100's
  lesson is that an empty authority field acquires a meaning nobody chose.
- `Installation` / `InstallResult`: carry `permissions`; **`role_id` and
  `role_name` are gone from the response too.**
- **java:** `InstallRequest`, `InstallResult` and `Installation` are records, so
  positional constructor arity changes.

### Error codes — three of these had no sentinel in any SDK

`permissions_required` (400), `unknown_permission` (400),
`permissions_exceed_grantor` (403), and `install_grants_nothing` (403).

⚠️ **`install_grants_nothing` is raised at MINT, not install** — the
installation row states no permissions, so the token would authorise nothing.
The docs had it filed under `install`. It is now mapped in all three languages;
previously a caller had to string-match it.

Registering the codes was load-bearing, not cosmetic: an unregistered code
collapses to `bad_request`/`forbidden`, so the sentinels would have existed
while never matching — the same defect ADR-101's own `role_owner_only` hit.

`role_not_service_typed` / `role_not_installable` are **retained but DEAD**: the
issuer emits neither since ADR-101 D7. Kept so existing matches still compile;
removing an exported symbol would be a second breaking change for no benefit.

### `web-admin` needs the re-vendor, not just the ts fix

`@realm-id/web-admin` bundles its own copy of `@realm-id/sdk`, so it shipped the
broken `install()` too — and its wiring test passed precisely BECAUSE it resolved
against the stale vendored copy. Fixed and re-vendored here. If you consume
`web-admin`, the ts fix alone does not reach you.

## go `0.51.1` — `const Version` catches up with the tag (2026-08-30)

No behaviour change. `go/v0.51.0` shipped with `const Version = "0.50.0"` still
in `go/realmid.go`: the code was right, the self-reported version was a release
behind.

**Do not use `0.51.0`** if you read `realmid.Version` — partners report their pin
from that const, and a wrong value there becomes a wrong row in the register used
to decide whether a breaking issuer change is safe to ship. `0.51.0` is not
withdrawn (a published module version is immutable and the proxy has it), it just
under-reports itself by one release.

**Caught by two separate guards, both of which fired before any damage:** CI's
"go/ has not changed under a released version" on the main push, and
"Verify the Go SDK release tag" on the tag. The tag was cut without reading the
first one — the guards worked, the human step between them did not.

## ADR-101 D1's write side: the role VOCABULARY — go `0.51.0` · ts `0.44.0` · java `0.41.0` · `web-admin` `0.11.0` (2026-08-30)

Spec `0.36.0` → `0.37.0`.

### Added — all three languages

- **`roleTemplates` / `RoleTemplates` / `roleTemplates()`** — RealmID's role
  VOCABULARY. Distinct from the roles client, and the distinction is the whole
  ADR: a ROLE belongs to one realm and has holders, a TEMPLATE is the recipe a
  role is stamped from. Base-realm-gated, so a partner realm gets
  `role_authoring_retired` on every verb; it is in the SDK because RealmID's own
  console is an SDK consumer like any other.
- `list` / `create` / `update` / `delete`, with the two counts the surface
  exists to carry: `realms_stamped` (a floor template FANS OUT to realms that
  already exist — the difference between "exists for future realms" and
  "reached the estate") and `drifted_realms` (an edit does NOT propagate, so it
  creates drift by design).
  **`-1` on either means the count could not be TAKEN and must not be read as
  "none".** Java exposes `driftUnknown()` / `orphanCountUnknown()` so that
  distinction survives into a boolean.

### Fixed — go

- **`role_authoring_retired` had NO sentinel in any SDK**, though the issuer has
  returned it from the four role-authoring routes since `v0.113.0`. Every caller
  hitting it on a partner realm got an unmapped 403 and had to string-match.
  Now `ErrRoleAuthoringRetired`, mapped on the roles surface as well as the
  templates one — that is where a partner actually meets it.
- `mapRoleErr` now reads the code with `specificCode` (BOTH envelope levels)
  rather than `detailCode` (siblings only). A registered code lands in
  `RealmError.Code` and is NOT copied into the siblings, so the old reader would
  have stopped matching the day any of these codes was registered.

### Note

An unset field in a patch is OMITTED from the request body in all three
languages, never sent as null: absent preserves the stored value, whereas a null
would be a decision the caller never made. Asserted per language.

## ADR-101 + the SDK dogfooding wave — go `0.50.0` · ts `0.43.0` · java `0.40.0` · `@realm-id/web` `0.5.0` · `web-admin` `0.10.0` (2026-08-30)

### docs — partner-facing writeup of the dogfooding wave (2026-08-30)

No code change; no version bump in any package.

- `docs/partner-integration-guide.md` **§6.6 "Shared logic the SDKs now carry"** —
  the surfaces waves 1–2 added, as a partner sees them: the role predicates in
  all three runtimes (`confersAuthority`, `isRoleAssignableTo`, `isRoleSeatable`)
  with the "issuer wins / not a security control" framing; the three error-body
  shapes and the readers for them (`ParseErrorEnvelope`, `StatedErrorCode`,
  `unwrapData`, `parseErrorEnvelope`); `ProxyStatus` and its three non-obvious
  rules; `ParseClaimsUnverified` with its unverified warning; the `MFARule`
  model (`RequireFresh` / `MaxAge` / `WhenJSONField` / `WhenJSONValues`);
  `withStepUpRetry`, `createMemberships`, `createRevocationSessions`,
  `realm.providers`; and `admin.ssoDomains` / `admin.federationBindings` /
  `admin.tenants.transferOwner`.
- `docs/partner-integration-guide.md` **§6.7 "Running your own BFF:
  refresh-token rotation"** — the one-time-refresh-token reuse-revocation trap
  and the five rules that answer it (SETNX single-flight, poll-don't-mint,
  in-lock debounce, detach the mint+persist from the request context, persist
  everything the mint returns), plus the tenant-switch variant. Documented
  pattern, not shipped code — see `DECISIONS.md`.
- **Staff-only surfaces are now labelled as such** in §6.6 and beside
  `SPEC.md` §7.5: the ADR-048 aggregates and `PlatformNotesClient` can only
  return `403` to a partner realm.
- `web/BFF-SPEC.md` — new **"Relaying an upstream error: preserve BOTH envelope
  levels"** under § Conventions (normative); a new **"Refresh-token rotation
  inside the BFF"** pointer at §6.7; and § Reference implementation now states
  that the six deviations are a known boundary defect with an ADR pending,
  rather than a design.
- `TODO.md` — new **§ Known contract debt** carrying the reference-BFF
  convergence item; the BFF-SPEC error-relay item is marked done.

### `go/` — SDK dogfooding, wave 1a (2026-08-30)

Additive; nothing existing changes shape. These are the surfaces a partner BFF
had to hand-roll because the SDK exposed only the typed-client path — lifted
from the reference BFF (`Realm-ID/api`), which had written each of them at
least once.

- **`ConfersAuthority(perms []string) bool` + `(*RoleObject).ConfersAuthority()`**
  — ADR-101 D6. Does this role grant anything whose ACTION is not `read`?
  Derived from the grants, never from the name "admin"; a malformed permission
  string fails CLOSED. Use it to keep a role picker from offering a choice whose
  every save answers `403 role_owner_only`.
- **`ConfersAuthorityWithCatalog(perms []string, catalog []Permission) bool`** —
  the same question resolved against the SERVED ADR-074 catalog
  (`RolesClient.ListPermissions`), so the answer is identical to the issuer's
  key for key: a permission ABSENT from the catalog confers, whatever its action
  reads as. An empty catalog falls back to the parse form. Parity with ts
  (`opts.catalog`) and java (`confersAuthority(permissions, catalog)`).
- **`IsRoleAssignableTo(role *RoleObject, kind string) bool` +
  `RolesAssignableTo([]RoleObject, kind) []RoleObject`** — ADR-081, with
  `PrincipalHuman` / `PrincipalService`. System-unassignable names, disabled
  roles, the declared `assignable_to` (empty means ANY on read), and the §2.3
  human-only floor for service principals (which `is_system` roles are exempt
  from, per ADR-091). **No per-role MFA check** — ADR-101 retired
  `required_mfa_methods`. Both predicates are compared against
  `issuer/internal/realmrole/` by a drift test; the issuer wins.
- **`ParseClaimsUnverified(token string) (*Claims, error)`** — a
  provenance-safe, UNVERIFIED read of an issuer-minted token's payload, for a
  BFF holding sealed tokens (ADR-060). Fails to a nil result on any malformed
  input. Read the doc comment before using it: it is not a verifier.
- **`ParseErrorEnvelope(body []byte, status int) *RealmError`** — reads either
  issuer error-envelope shape (coded, and the code-less GoFr-middleware 401) off
  a raw response body, preserving envelope siblings and never leaking the raw
  bytes into the message.
- **`ProxyStatus(err) (status int, code string, details map[string]any)`** —
  classifies an SDK error for relay by a BFF. Preserves `Details` so gate
  payloads (`revocation_token`, `mfa_challenge_token`) survive the proxy;
  timeout → `504 upstream_timeout`; unclassifiable → `502`. Framework wrapping
  stays the caller's job.
- **`MFARule` grows `Method`, `WhenJSONField` and `WhenJSONValues`**, plus
  `MFARequireFreshWindow`, `MFARule.EffectiveMaxAge(default)` and
  `ValidateMFARules([]MFARule) error`. Rule paths now accept `{placeholder}`
  segments (exactly one non-empty segment) alongside the existing `*` / `**`
  globs, method matching is case-insensitive, and the first matching rule wins.
  JSON narrowing lets one policy cover the irreversible variant of an endpoint
  that is two operations without gating the other. The middleware buffers the
  request body ONLY when some rule declares a condition, and restores it. The
  route list stays partner-owned data (ADR-096 D2).

### `go/` + `ts/` + `java/` — an unrecognised error code no longer vanishes (2026-08-30)

Bug fix, all three SDKs. A `code` outside each SDK's canonical error-code union
was dropped on the NESTED envelope shape, so ADR-101's own 403 —
`role_owner_only`, the code this release introduces — reached a caller as an
undifferentiated `forbidden`.

- **go**: `ParseErrorEnvelope` / the typed-client path now preserve a
  non-canonical stated `code` in `Details["code"]`, on BOTH shapes, as the doc
  comment already promised. A canonical code still lands on `Code` alone. A
  top-level `code` keeps precedence over a nested one. The nested branch also
  falls back to a legacy `{"error":{"error":"<msg>"}}` string for the message.
- **ts**: `parseErrorEnvelope` gains the same nested legacy-`error`-string
  message fallback. Unknown-code preservation (`details.server_code`) was
  ALREADY correct here and is unchanged.
- **java**: `HttpTransport.mapErrorResponse` preserves an unmapped code under
  `details["server_code"]` (the key `ts` already ships) on both shapes, gains
  the nested legacy-`error`-string message fallback, and its flat branch is no
  longer gated on a present `code` — a code-less GoFr middleware 401 lost its
  message entirely.

Also new in `go/`: `StatedErrorCode(body []byte) string` — the code a body
LITERALLY states, in either shape, narrowed by nothing. `ParseErrorEnvelope`
narrows on purpose, which is what a client wants; a PROXY needs to know whether
the upstream stated a code at all, and cannot get that from `Code` (a stated
`forbidden` and a bare 403 are the same value there). The reference BFF carried
its own body re-reader for exactly this until now.

No wire shape changes and nothing existing is renamed. `Details`/`details` gains
a key it previously lacked on refusals whose code the union does not name.

### `go/` + `ts/` + `java/` + `@realm-id/web` — one error contract across the three SDKs (2026-08-30)

Settles the two cross-language divergences the envelope fix above left open, both
before publication, because both are breaking to change once a partner consumes
them. **SPEC.md gains §3.3 and an amendment to §3.2** so this is written down
rather than re-derived.

- **The preserved error code's key is `details.server_code` in ALL THREE SDKs.**
  It was `Details["code"]` in go and `server_code` in ts/java, so a branch ported
  between SDKs read an absent key and silently fell back to the generic status
  code. **go moved**: `SPEC.md` named neither key, `server_code` is already read
  by shipped consumers (`@realm-id/web-admin`'s `isCode`, `@realm-id/web`'s
  `membershipActionCode`, two console screens), and the go write had never been
  released — it is the entry directly above this one. `detailCode` reads
  `server_code` first and still falls back to a verbatim `code` sibling.
  **Supersedes the "preserved in `Details["code"]`" line in the entry above.**
- **Nested gate payloads no longer vanish in ts and java.** On
  `{"error":{…}}` both collected only the siblings BESIDE `error`, while the
  ISSUER nests them inside it: GoFr's `createErrorResponse` merges every key an
  error's `Response()` map adds into ONE object rendered under `error`, so
  `mfa_challenge_token`, `methods`, `reason`, `max_age_seconds`,
  `revocation_token` and `active_sessions` all arrive nested. A ts or java
  partner driving a step-up or session-limit gate against the issuer got an
  **empty `details` map** — a challenge with no token to answer it. go always
  collected both levels. Both levels are now swept into one flat `details`, a
  nested key wins a name collision, and the envelope's own `code`/`message`/
  `error` are never copied in. **This was live, not theoretical.**
- **`@realm-id/web` — `withStepUpRetry` reads the nested form too.** Its
  `parseStepUp` hand-reads the 412 rather than going through
  `parseErrorEnvelope`, and read only the top level: against the issuer's own
  gate it classified the challenge correctly and then handed the prompt an
  EMPTY `challengeToken`. Same precedence as everywhere else.
- **`@realm-id/web` — `parseErrorEnvelope` catches up with `@realm-id/sdk`**: the
  nested-sibling sweep AND the nested legacy-`{"error":{"error":"<msg>"}}`
  message fallback it did not receive on 2026-08-30. Its parity gate stayed
  green through both because the FIXTURE TABLE is hand-maintained and carried no
  nested-payload or legacy-message body; five fixtures were added and the gate
  goes red on either regression.
- **ts flat branch collects its siblings.** `{"error":"<msg>","code":…, …}` threw
  the rest away; go's flat branch never did.

Behaviour-affecting for `go` callers reading `Details["code"]` for a
non-canonical code — that read was never released. Otherwise additive: `details`
gains keys on refusals that previously dropped them.


**BREAKING.** A partner can no longer author a role, and three per-role fields
are gone from the wire.

- **The role→scope map ships** — the half of ADR-100 D9 that had been described
  but not built. `ScopePolicy` was already the route→scope half; this is the
  other one: given the roles a user holds in YOUR product, what scopes should
  their token carry. Go `RoleScopes.ScopesFor`, ts `scopesForRoles`, java
  `RoleScopes.scopesForRoles`, each with a `Validate` for startup and a sorted,
  de-duplicated result because the output is compared, logged and sent on the
  wire.

  Both maps live in the PARTNER'S repo. That is what makes "adding a product
  role never touches RealmID" the paved path rather than merely possible.

  ⚠️ "Role" here means YOUR role, not `realm_roles`. The two are unrelated:
  `realm_roles` is RealmID's own administrative vocabulary (what a user may do
  TO REALMID); a scope governs what a user may do inside your product.

- **`required_mfa_methods` and `can_invite_roles` are REMOVED** from the role
  object and from the create/patch bodies in all three languages. The columns
  behind them are gone: zero realms ever configured an MFA floor, and the
  invitation scope bounded one of four seating paths while ADR-101 D6 now bounds
  all four. Dropped rather than kept as permanently-empty arrays — a field that
  is always `[]` reads as a capability that exists and is unused.

- **Role authoring is base-realm-only.** `roles.create` / `update` / `delete` /
  `rename` answer `403 role_authoring_retired` for every realm but RealmID's
  own. `roles.list` and `disable`/`enable` are unchanged and still open to every
  realm owner — disabling is not authoring, and within the new set `admin` is
  the only disable-able role.

- **`RoleAdmin` joins the Go system-role constants** and `viewer` is gone. A
  realm may DISABLE `admin`, so these constants are not a promise that every
  name resolves in every realm; `roles.list` remains the honest way to learn
  what a realm offers.

- **java:** `RoleCreate` and `RolePatch` lose two record components each, so
  their positional constructors change arity. `RolePatch.onlyRequiredMfaMethods`
  and `onlyCanInviteRoles` are deleted.

## ADR-097 mint half — `scope` on the token request — go `0.49.0` · ts `0.42.0` · java `0.39.0` (2026-08-28)

**The enforcement half of ADR-097 shipped in all three SDKs. The mint half
shipped in none of them.** `scopesFrom` / `scopeAllows` / `ScopePolicy` /
`ScopeFilter` have been evaluating a `scope` claim since go `0.47.0` — and no
SDK could put that claim on the wire. The issuer accepted `scope` on
`POST /auth/token` the whole time and it is documented in swagger, so
`ScopePolicy` was reachable only by a partner who bypassed the SDK and
hand-rolled the mint call. Reported by an integrator, not caught by us.

- **`TokenRequest.scope`** — go `Scope []string`, ts `scope?: string[]`, java
  `TokenRequest.withScope(List<String>)`. Joined into the wire's single
  space-delimited string (RFC 6749 §3.3) and sent as `scope` on
  `POST /auth/token`.
- **A LIST, not the wire string, in every language, on purpose.** A space
  inside one entry is not a parse error on the wire — it SPLITS one scope into
  two and mints authority the caller never asked for. So an entry outside the
  RFC 6749 §3.3 scope-token charset (printable ASCII minus SPACE, `"` and `\`)
  is refused CLIENT-SIDE, before the request leaves: go `ErrInvalidScope`, ts
  and java a `bad_request`. Refusing early also matters because a mint that
  fails partway would still have spent and rotated the refresh token.
- **Empty and absent are the same request**, which is the INVERSE of
  `rolePermissions` and deliberate: the issuer trims and treats `""` as absent,
  so `"scope": ""` could not mean anything. An empty `rolePermissions` IS a real
  instruction, which is why that one is null-keyed and this one is not.
- **The per-realm bounds are NOT checked client-side.**
  `max_permission_strings` / `max_permission_string_len` are realm
  configuration, and a local copy would drift into refusing what the server
  accepts. The charset is fixed by RFC and cannot.
- Accepted on `/auth/token` only, never `/auth/login`, and it cannot ride in
  `customClaims` (`scope` is a reserved claim key). Refused outright on a
  service-class refresh (`400 scope_not_supported`).
- **`SPEC.md` §4.2 now documents the field**, which it never did.

Also in this release, both found while answering the same report:

- **Four changelog headings named versions that were never tagged** — go
  `0.45.0`/`0.46.0`, ts `0.37.0`–`0.39.0`, java `0.35.0`/`0.36.0`. See the note
  below; the entries themselves are corrected in place.
- **`SPEC.md`'s header was pinned to the same phantom train** (`go/v0.46.0` ·
  `ts-v0.38.0` · `java-v0.36.0`) and now names tags that exist.
- **The ts test script was a hand-maintained list of 30 filenames**, so a new
  test file was silently never run. It is a filesystem glob now.

### On the phantom versions

A version number in this changelog is a **promise a partner plans against**, and
four entries here named tags that do not exist — an integrator hit three 404s
following them. The content was never withdrawn or renamed; it rolled into the
next tag that actually shipped, because the release train wrote the entry with
the version it INTENDED to cut and then cut a different one.

Corrected mapping, each verified against the tags rather than inferred:

```
go:   v0.44.0 [0.45.0, 0.46.0 NEVER TAGGED] v0.47.0 v0.47.1 v0.48.0
ts:   v0.36.0 [0.37.0, 0.38.0, 0.39.0 NEVER TAGGED] v0.40.0 v0.41.0
java: v0.34.0 [0.35.0, 0.36.0 NEVER TAGGED] v0.37.0 v0.38.0
```

**Write the heading from `git tag`, not from the version you meant to cut.**

## ADR-100: a key's authority is stated, never inferred — ts `0.41.0` · go `0.48.0` · java `0.38.0` · web-admin `0.9.0` (2026-08-27)

**BREAKING in all four, and unreleased — no tag is cut by this work.** Issuer
side lands separately and LAST (ADR-100 D19); new clients are correct against
the old issuer, which ignores unknown fields and already treats an empty stored
cap as uncapped, so there is no broken interval and no dual-accept release.

- **`uncapped` is required on the user-API-key write schema, and unconditional
  on the wire.** Before this, the body every client produced when nothing was
  selected — `{"label": "x"}` — minted a key carrying the holder's FULL
  authority, and on a `realmid`-audience key that is RealmID admin authority.
  The same shape was also the only way to ask for an unrestricted key on
  purpose, so the server could not refuse the accident without refusing the
  intent. Naming the state separates them. Each SDK expresses "I did not say" in
  its own idiom and lets it fail loudly: TS coerces, Go sends a pointer with no
  `omitempty` so nil travels as JSON `null`, and Java simply deletes
  `UserAPIKeyCreate.of(label)` so the four-null call no longer compiles.
- **`update` — one write schema, shared with `create`, on `PUT`.** It **resets
  what it omits**; read-then-write.
- **`role_permissions` on login and refresh.** The partner's own role→permission
  list, narrowing a key-derived token's `permissions_cap` claim per org.
  Optional, and it can only narrow — the claim is `stored_cap ∩ supplied`.
- **`scopes.remove` is DELETED** (TS + web-admin; go/java never had it).
  Retiring a scope is self-healing now that the partner supplies
  `role_permissions` at mint. `scopes.rename` is untouched.

## gofmt only — go `0.47.1` (2026-08-26)

**Cosmetic, no API or behaviour change.** `go/scope.go` carried a trailing
blank line that failed CI's `gofmt` step; `go/v0.47.0` was cut from that
commit, so formatting it changed `go/` after publication.

The version bump is not optional and the CI message says why: two different
trees would otherwise answer to one version, and re-pointing `go/v0.47.0` to
pick it up breaks every consumer holding the old hash in `go.sum` with
`checksum mismatch` — the 2026-07-05 incident. So the fix ships forward as a
patch rather than by moving a published tag.

## ADR-097 — SDK-enforced route authorization — go `0.47.0` · ts `0.40.0` · java `0.37.0` (2026-08-24)

> **Heading corrected 2026-08-28.** This read ts `0.39.0`, a version that was
> never tagged. The TypeScript work shipped in `ts-v0.40.0`. See the phantom-
> version note below.

**A partner adding an endpoint to their own product no longer has to update
configuration inside RealmID.** RealmID stores identity and attestation; YOUR
repo owns the route → scope and role → scope maps; the SDK is the gate. SPEC
§11.

**The hole this closes.** `capAllows` was the ONLY authorization primitive in any
of the three SDKs, and it covers the API-key path alone. A partner protecting a
route for an ordinary signed-in user hand-rolled it — so the safety property
`capAllows`'s two-operand signature was designed to guarantee held on the key
path and nowhere else.

**Three layers.**

1. `ScopeAllows` / `scopeAllows` / `Scopes.scopeAllows` — a pure predicate over
   the `scope` claim. No I/O.
2. `ScopePolicy` — route → required scopes. **Denies by default**; a route is
   made public by SAYING so, never by forgetting.
3. Adapters — Go `net/http`, TS Express + Fastify, Java servlet `Filter`.

Layer 3 is a handful of lines BECAUSE layer 1 is a predicate over one claim with
no I/O — the payoff of RealmID intersecting `scope ∩ permissions_cap` at mint.
Had the issuer emitted both operands, every adapter would carry policy.

**`scope` is a space-delimited STRING** (RFC 9068 §2.2.3 → RFC 8693 §4.2 → RFC
6749 §3.3), not an array. `Claims.scope` and `Claims.token_class` are declared
in ts; Go and Java read them through the helpers.

**Two models now coexist, and the SPEC says which to use when** — otherwise you
mix them and get the worst of both. Token scope: no per-request I/O, revocation
lag equal to the realm's `access_ttl_seconds`. `capAllows`: a live read per
check, zero lag. **Token scope by default; `capAllows` where a stale grant is
unacceptable** — money movement, permission administration, data export.
`capAllows` is NOT deprecated.

**No Gin / Echo / Fiber / Spring-native adapter, deliberately.** These SDKs take
zero external dependencies (Java's only web dependency is a `compileOnly`
servlet API, which is why a servlet `Filter` works unchanged in Spring Boot).
Importing a framework would put it in every partner's tree including those who
do not use it. SPEC §11.5 carries the three-line snippet for any framework.

**The 403 does not name the missing scopes.** Telling an unauthorized caller
which permissions they lack is a map of your authority model, handed out for
free. The names reach YOUR server through the denial hook.

**Seven error codes added to the §3.1 taxonomy** in all three languages:
`invalid_scope`, `too_many_scopes`, `scope_too_long`, `scope_not_supported`,
`reserved_claim_key`, `realmid_audience_immutable`, `invalid_rename`.
`insufficient_scope` — the 403 the SDK gate emits — is deliberately NOT in the
taxonomy: no issuer handler produces it, and an entry with no producer is the
`not_service` phantom this taxonomy already carries one of.

**Java makes one mistake unrepresentable that the other two only validate.**
`ScopeRule`'s factories mean a public rule cannot carry scopes at all — a
compile error there, a startup diagnostic elsewhere. Pinned by
`publicRuleCannotAlsoCarryScopes`, so if a constructor is ever widened the
validator's branch stops being belt-and-braces and the test says so.

Every guard mutation-verified in all three languages: default-allow and
vacuous-true-on-empty-requirement each go red on the case that names them.

## BREAKING — the error taxonomy was eight codes out of sync — go `0.47.0` · ts `0.40.0` · java `0.37.0` (2026-08-24)

> **Heading corrected 2026-08-28.** This read go `0.46.0` · ts `0.38.0` · java
> `0.36.0`. **None of those three tags exist.** The work shipped in `go/v0.47.0`
> / `ts-v0.40.0` / `java-v0.37.0` — verified: `platform_not_found` is absent at
> `go/v0.44.0`, `ts-v0.36.0` and `java-v0.34.0` and present at each of the three
> corrected tags.

**`platform_not_found` is registered in all three languages.** The issuer
answers it on every by-id platform route (16 call sites); until now it fell
back to the 404 mapping and every caller saw a generic `not_found`.
**BREAKING for anyone matching `not_found` on a platform route** — despite being
purely additive to a union. The migration is to match both, already the idiom
for the sibling codes: `case "platform_not_found": case "not_found":`. An
existing ts test asserted the old normalized code and is the visible half of the
change. The 404 still never distinguishes "not yours" from "never existed"
(issuer `v0.78.0` oracle rule): a security property no taxonomy change may
erode.

**The item said the three taxonomies were consistent. They were not.** Measured:
Go was missing **six** codes ts and Java had carried since ADR-071/072
(`handle_taken`, `invalid_role`, `method_violates_kind`,
`service_account_not_found`, `source_not_found`, `user_not_found`), and ts and
Java were both missing `mfa_registration_required`, which Go has had since
ADR-061. Every one of them silently normalized in the language that lacked it.
**Consistency was never evidence of intent** — the three lists are
hand-maintained from one SPEC, so a single omission propagates identically to
all three and agreement is exactly what a shared oversight looks like.

**`not_service` is NOT propagated to Go**, deliberately: no issuer handler emits
it (its only near-match is the distinct `role_not_service_typed`). A code with
no producer is a phantom, and propagating it would spread one. Carried as a
reviewed exception in the parity gate, with the reason attached.

**Registering a code BROKE two Go sentinel mappers, and an existing test caught
it.** A registered code lands in `RealmError.Code` and is never copied into the
envelope siblings; an unregistered one only survives in the siblings. So
`mapServiceAccountErr` and `mapSourceErr`, which read only the siblings via
`detailCode`, stopped matching the day their codes became canonical — silently:
the call returns a bare `*RealmError` and `errors.Is(err, ErrSourceNotFound)`
just goes false at every call site. `integrations.go` had already hit this and
fixed it inline; that fix is now the named, shared `specificCode` helper.

**`scripts/taxonomy-parity.py`** is the gate, in its own CI job because the
drift is invisible from inside any single language's suite — each list is
individually self-consistent. It reads all three sources, checks Go's
`knownCodes` map against Go's own const block (a second hand-maintained list in
one file), and refuses to pass when it parses implausibly few codes, so a regex
that stops matching cannot report parity across three empty sets. Five mutations
run; one of them found that the ts anchor matched `ErrorCodeX` as a prefix and
kept parsing a renamed union.

## A release cannot publish without a changelog entry — tooling only (2026-08-24)

No SDK version changes. `scripts/changelog-hygiene.sh` is a pre-publish gate,
wired into `publish-npm.yml`, `publish-maven.yml` and `verify-go-release.yml`:
the version a workflow is about to publish must have a matching `## <version>`
heading in that package's changelog, or the job fails before anything reaches a
registry.

**Why now.** Three packages lost history to the same silence — `ts` `0.29.0`–
`0.35.0` (seven releases), `web-admin` `0.8.13`–`0.8.17`, `java` `java-v0.34.0`.
Backfilling entries fixes none of that; the next release skips again. Backfills
stay open in `TODO.md`, the gap just cannot grow.

**Writing it found the fault one degree worse.** `@realm-id/web`,
`@realm-id/web-react` and `@realm-id/web-bff-realmid` had **no `CHANGELOG.md`
at all**, across fourteen published versions between them — a missing file never
looks wrong, where a missing entry at least leaves a hole between two version
numbers. All three are seeded, starting at their current version and saying so;
nothing is reconstructed from commit subjects and presented as history.

**And it found two packages the publish workflow does not publish.** The gate
derives its subjects from `ts/` + `web/packages/*` rather than a list, which
immediately turned up `@realm-id/web-firebase` and `@realm-id/web-google` —
non-private, versioned `0.4.0`, and **404 on `registry.npmjs.org` across every
version**. They are superseded by `realm.signIn()` in the core package. Both are
now `"private": true`, so "not published" is a fact in the package instead of
the absence of a name from a `for` loop in the workflow. `web/README.md`, which
told partners to install exactly one of them, is corrected against the registry.

**The gate's own zero-subject guard was broken, and a mutation caught it.** With
the derivation returning nothing, `set -u` aborted on the empty array before the
"inspected 0 packages" check could run — exit 1, no diagnosis, in precisely the
case the check exists for. Moved above the loop; both empty cases now exit 2.
Seven mutations run in total, each caught by the check aimed at it.

## BFF mode refuses a tokenless on-behalf-of id — go `0.47.0` · java `0.37.0` (2026-08-21)

> **Heading corrected 2026-08-28.** This read go `0.45.0` · java `0.35.0`,
> neither of which was tagged. Rolled into `go/v0.47.0` / `java-v0.37.0`.

An `X-On-Behalf-Of-User` id with no `X-User-Token` beside it has been refused by
the issuer since v0.66.0 (`401 x_user_token_required`): the id was an
unauthenticated user id any platform-key holder could use to act as any user in
the realm. Go's and Java's BFF mode sent exactly that, so the mode was dead
against any current issuer unless the caller separately supplied a user token
(Go `WithUserToken(ctx, …)`, Java `realm.withUserToken(jwt)`).

Both SDKs now refuse such a call LOCALLY, naming the remedy — the server's 401
cannot say which call site forgot the token. **Scoped to the routes where the id
asserts an identity** (sessions, MFA self-service): on the OTP routes the same
header is a domain parameter — the OTP subject — and requiring a token there
would break calls the issuer accepts.

TS needed no change: `realm.withUserToken(jwt)` (ts `0.33.0`) already sends the
shape the issuer accepts. The long-standing "TS lacks BFF mode" TODO is closed
by measurement — it asked for the mode that does not work.

## A device label the transport cannot carry — go `0.47.0` · ts `0.40.0` · java `0.37.0` (2026-08-21)

> **Heading corrected 2026-08-28.** This read go `0.45.0` · ts `0.37.0` · java
> `0.35.0`, none of which was tagged. Rolled into `go/v0.47.0` / `ts-v0.40.0` /
> `java-v0.37.0`.

Cross-cutting fix to the ADR-062 device label, in all three SDKs at once.

"Send the value raw; the issuer sanitizes it" is the rule the SPEC and all three
clients carried, and it is wrong for exactly the input sanitizing exists for. A
label containing a C0 control never reached the server: undici throws
`Headers.append: … is an invalid header value`, the JDK's
`HttpRequest.Builder.header` refuses it, and Go's `net/http` fails the request
with `invalid header field value` — so the whole login died with an error naming
the network rather than the argument. Go had shipped this since ADR-062; nothing
had ever sent it a control character.

Each SDK now strips what an HTTP field value cannot carry (C0 controls + DEL)
and sends nothing at all when the result is empty — an empty header reads
server-side as a supplied label. The **120-character cap stays server-side**:
that is policy, and a client-side copy drifts the day either end changes. The
stripped value is byte-identical to what `sanitizeDeviceName` would have stored.

Found by the new `tests/sdk-e2e` suite (umbrella repo), which drives the TS and
Java clients against a live issuer. Its first run also found that TS's
`listSessions` decoded an envelope no issuer emits — see `ts/CHANGELOG.md`
`0.37.0` and `DECISIONS.md` 2026-08-21.

## `me.acceptInvitation` — the mirror of reject (ADR-095 D5) — go `0.44.0` · ts `0.35.0` · java `0.34.0` (2026-08-03)

`POST /me/invitations/{tenantId}/accept`, added to all three SDKs. Accepts a
**pending** invitation: the lifecycle row is stamped `accepted` and the
membership becomes `active`. Returns the same `{tenantId, status}` envelope as
`rejectInvitation` and `leave`, and takes no request body — the path and the
session say everything.

Why it exists: a realm on `invitation_acceptance: "explicit"` (ADR-095 D2, issuer
`v0.82.0`) no longer activates an invitation implicitly at login, so a decline
path with no matching accept path would leave an invitee able to say no and
unable to say yes. On the default `"auto"` mode the call still works — it settles
a row the invitee's next sign-in would have settled anyway.

- **go** — `MeClient.AcceptInvitation(ctx, MembershipRequest) (*MembershipResult, error)`.
- **ts** — `realm.me.acceptInvitation({ tenantId })`.
- **java** — `realm.me().acceptInvitation(tenantId, auth)`.

Errors keep their specific codes rather than collapsing into a generic 409:
`not_invited` (already an active member) and `not_pending` (already answered,
revoked or expired) have different remedies, and only the code tells them apart.
`404` deliberately does not distinguish "no such tenant" from "not yours".

Additive in every language — no existing signature changed. SPEC §6.15 documents
the write order (lifecycle row **before** membership activation), which is the
concurrency control: activating the membership first would let an invitation
rejected in a simultaneous request still grant access. Spec version 0.20.0 →
0.21.0.

## BREAKING — `allowedDomains` removed from tenant create (ADR-094 R3) — go `0.43.0` · ts `0.34.0` · java `0.33.0` · web-admin `0.8.17` (2026-08-02)

`tenants.allowed_domains` no longer exists server-side (issuer `v0.77.0`,
migration `1785888000`). Removed from every SDK in lockstep:

- **go** — `TenantCreate.AllowedDomains` deleted.
- **ts** — `TenantCreate.allowedDomains` deleted; the create body no longer
  sends `allowed_domains`.
- **java** — `TenantCreate`'s `allowedDomains` component deleted, along with the
  `of(displayName, allowedDomains, owner)` overload. **Source-incompatible**:
  a caller using that overload or the 6-arg canonical constructor must update.
- **web-admin** — `Tenant.allowed_domains` deleted. Left in place it would have
  been worse than stale: the field is typed `string[]`, so `t.allowed_domains.length`
  would keep typechecking and throw on `undefined` against a `v0.77.0` issuer.

Domains that auto-provision are `tenant_domains` grants, claimed and proven
through the domains API. A settable allowlist required no proof of control,
which is what let a domain confer access nobody had demonstrated. Note for
migrations: a bulk-imported org therefore starts with its domains **inert** —
there is no bulk-approve path, by design (ADR-094 §Consequences).

`updateConfig` no longer honours `allowedDomains`; the server returns
`400 unknown_config_key`. SPEC §6.1 updated; spec version 0.17.0 → 0.18.0.

## `withUserToken` — on-behalf-of reaches the TYPED surface — ts `0.33.0` · java `0.32.0` (2026-08-02)

Additive. No existing method, signature or default changed; a caller that never
calls `withUserToken` sends exactly the bytes it sent before.

A partner BFF acting for a signed-in user must forward that user's verified
access JWT as `X-User-Token` beside the platform bearer (§4, ADR-056) — the
bare `X-On-Behalf-Of-User` id stopped being an identity in issuer v0.66.0. Go
has had this on every typed method since ADR-056 via a context value; **TS and
Java could only send the header on `realm.me.*`**, so a partner calling
`tenants.list()` on a user's behalf had to drop to raw HTTP. That gap blocks
flow 1 of ADR-094 (per-org domain SSO), where an org admin claims a domain
through their platform's own UI.

- **`realm.withUserToken(accessJWT)`** (TS + Java) returns a **derived** realm
  whose every call carries the header. The platform token stays the wire
  bearer — the user JWT is additive, never a replacement.
- **No typed-method signature changed.** The whole resource bundle is rebuilt
  around one derived transport, which is how the header reaches ~104 methods
  per language without touching them.
- **Derivation, not a setter.** A settable field on a long-lived realm handle
  would let one request's user leak into the next; TS and Java have no ambient
  request context to hang it on, and a Java `ThreadLocal` is fragile under
  virtual threads. The parent's platform-token cache, verifier and JWKS cache
  are SHARED, so deriving per request is cheap.
- **A per-call user token still wins**, and the header is now sent **exactly
  once**. Header names are case-insensitive: the previous merge would have put
  both `x-user-token` and `X-User-Token` on the wire (fetch joins them with a
  comma; `HttpRequest.Builder.header()` appends), handing the issuer a token it
  cannot parse. Per-call header names are lower-cased on the way in.
- Java refuses `withUserToken(null)`/`("")` rather than handing back a handle
  that looks user-scoped and silently calls as the bare platform credential.

SPEC § "Verified on-behalf-of" now carries the per-SDK table and the
send-it-once rule. ts 190 tests pass; java 185 pass.

## Membership self-service + the single-tenant picker (ADR-092) — go `0.42.0` · ts `0.32.0` · java `0.31.0` (2026-07-30)

Purely additive typing of an issuer contract that is already live. No existing
field, method or signature changed; older clients keep compiling.

- **`realm.me.*` / `Realm.Me` / `realm.me()`** — `chooseTenant` (`POST
  /me/tenant-choice`), `rejectInvitation` (`POST
  /me/invitations/{tenantId}/reject`), `leave` (`POST
  /me/memberships/{tenantId}/leave`). Authorized by the END USER: direct
  (`userBearer`) or BFF (`userToken` → `X-User-Token` beside the platform
  bearer). No user-id mode — a bare `X-On-Behalf-Of-User` stopped being an
  identity in issuer v0.66.0.
- **Login response** gains `tenantChoiceRequired` + `tenantChoices[]`
  (`{ tenantId, displayName, isOwner }`). The login still SUCCEEDS and still
  returns tokens; the picker is a reconciliation prompt, not an auth failure.
  `isOwner` marks a membership that cannot be given up.
- **`config.get()`** gains `singleTenantPendingReconciliation` — DERIVED,
  read-only, and beside `config` rather than in it. Absent ≠ `0`: the issuer
  reports it only while `single_tenant_membership` is on.
- **Seven error codes** registered in the §3.1 taxonomy so they reach
  `error.code` instead of collapsing into the generic 409 `conflict`:
  `owner_cannot_be_revoked`, `single_tenant_not_required`, `not_invited`,
  `not_pending`, `invitations_unavailable`, `owner_cannot_leave`,
  `already_left`.

SPEC §3.1, §4.1, §6.5 and the new §6.15 document the surface.

## go `v0.41.0` · java `0.30.0` — a `CookieDomain` change no longer strands live sessions

**Bug fix. Reported by Traide (`traide.co.in`) from a live production incident,
2026-07-28.** Verified against the source before acting; every claim in the
report held.

Setting or changing `CookieDomain` on a deployment with live sessions left every
affected browser holding **two** cookies named `realmid_refresh` at different
scopes. The middleware then read the wrong one on every refresh, forever, with
no in-product recovery — not login, not logout, not waiting for expiry. The only
escape was the user deleting cookies by hand.

- **Read every candidate.** `readRefreshTokens` (Go) / `readRefreshCandidates`
  (Java) return every cookie of the configured name, in header order,
  deduplicated and capped at 3; the refresh handler tries each until one mints.
  An already-stranded browser recovers on its next refresh with **no partner
  action and no migration** — the valid token was in the header all along.
  Logout now revokes every candidate too.
- **Evict the other scopes.** Setting `CookieDomain` also emits a host-only
  deletion on every write and on logout, so the twin is cleaned up instead of
  shadowing the live cookie forever. New `CookieDomainMigrateFrom []string`
  (`cookieDomainMigrateFrom` in Java) names scopes you are LEAVING, for the
  tighten/remove direction the SDK cannot discover on its own. `""` means the
  host-only scope; `.example.com` and `example.com` are treated as the same
  scope, and the scope currently being written is never deleted.
- **Documented.** SPEC §10.4 gains a "Changing `cookieDomain` on a live
  deployment" section. The option comments carry the warning inline.

Error semantics are unchanged: with the ordinary single cookie the behaviour is
byte-identical, and when every candidate fails it is the FIRST failure that is
reported — so no partner's `refresh_invalid` handling changes shape because a
browser happened to be carrying a stale twin.

TS/web is unaffected — the cookie is `HttpOnly` and never read client-side.

## `@realm-id/web-admin` 0.8.16 — MeMembership carries the caller's permissions

Adds `MeMembership.is_admin_tenant` and `MeMembership.permissions` (ADR-090).
Types only — no runtime change.

`permissions` is the caller's fully resolved effective permission set for that
membership. **Gate admin-UI affordances on it, never on `role === "admin"`.** A
role's NAME confers nothing: since issuer v0.54.0 the `admin`/`viewer` starter
roles are opt-in, so a fresh realm has no `admin` row and every delegated user
carries a custom name — while a partner may create a role literally named
`admin` holding zero permissions.

There is no implicit-all marker to expand: an owner arrives with the whole
catalog already listed, and the array is already intersected with the token's
ADR-084 `permissions_cap`. ORing in `is_owner` would over-grant a capped
principal.

Pair `permissions` with `is_admin_tenant` for realm-surface affordances
(federation, sources, domains, identity providers, platform config): the
realm-scoped gate additionally requires the caller to sit in the realm's admin
tenant, so a role can grant `federation:manage` on an org membership where it is
unreachable.

Both are optional for back-compat. Absent means **unknown, not none** — fall
through to your other checks rather than hiding every control.

## The platform session has no refresh token — go `0.40.0` · ts `0.31.0` · java `0.29.0` (2026-07-27)

**All three SDKs, in lockstep with issuer `v0.68.0` (ADR-089). Upgrade before
the issuer deploys** — see the compatibility note below.

The SDK's platform identity is now an **access token only**. Every acquisition
is a `POST /auth/login` with the bootstrap credential; when the cached token
comes within 30s of expiry, the SDK does that again. `POST /auth/token` is no
longer called for this identity, and `SPEC.md` §4.0 step 3 is rewritten
accordingly.

**Why:** ADR-089 withdrew the refresh token from every credential-bootstrapped
session. The caller is holding the API key (or can mint a fresh workload
assertion) at the moment it needs a token, so the refresh token was a strictly
weaker duplicate of a credential it already had — and one that outlived
revocation of its source. The apparatus that guarded that gap had failed twice
in production, once per lane.

**Compatibility — this is the sharp bit.** The Go and TypeScript managers
*required* `refresh_token` in the login response and threw
`"platform login returned empty tokens"` when it was absent. So an SDK older
than this release does not degrade against a `v0.68.0` issuer — **it fails
hard, on the first call.** Release order therefore matters: ship these SDK
versions (and anything pinning them, including the BFF) **before** the issuer.
The new SDKs work against old and new issuers alike, so the upgrade is safe to
do early. Java already treated the field as optional and was unaffected.

- **go `0.40.0`** — `sessionManager` loses `refreshToken`, `fetch` and
  `refreshAccess`; `login` no longer requires `refresh_token`. Single-flight is
  retained, now over `/auth/login`.
- **ts `0.31.0`** — same for `PlatformTokenManager`; `invalidate()` now clears
  the whole cached session rather than preserving a refresh token.
- **java `0.29.0`** — `refreshAccess` and `cachedRefreshToken` removed. Behaviour
  was already correct; this is dead-code removal plus doc.

Also: `platform_refresh_rotates` is gone from the realm-config surface (`PATCH
/platforms/{id}/config` → `unknown_config_key`). `service_refresh_rotates`
stays — it still governs the ADR-071 service-account lane, which is
OTP-bootstrapped and therefore keeps its refresh token.

## `MeMembership.is_owner` — web-admin 0.8.15 (2026-07-26)

TypeScript only, type-level. `MeMembership` now declares `is_owner` — the
issuer's per-membership reading of ADR-076's `tenants.owner_user_id`, which the
BFF forwards from v0.20.0. **Gate owner-only UI on it, never on
`role === "owner"`**: ADR-076 retired that marker, so the role check is false for
every actual owner (see `ui/DECISIONS.md` 2026-07-26 for the resulting bug).

## `admin.userApiKeys` — ts 0.30.0 (`ts-v0.30.0`) · web-admin 0.8.14 (2026-07-26)

TypeScript only; go/java unchanged. No wire change — this exposes a client that
already existed.

- **`UserApiKeysClient` is now re-exported from the `/internal` entry point.**
  It shipped in ts 0.29.0 on the public `realm.userApiKeys` facade but never on
  `@realm-id/sdk/internal`, which is the entry `@realm-id/web-admin` builds on —
  so the admin surface had no way to reach it. Also exported: `capAllows`,
  `isUserApiKeyRevoked`, and the `UserApiKey` / `UserApiKeyCreate` / `OrgScope` /
  `LivePermissionResolver` types.
- **`admin.userApiKeys.list/create/revoke` (web-admin).** Wired onto the same
  transport as every other admin resource. Distinct from `admin.apiKeys`, which
  remains the platform (`rk_live_…`) surface — see the README's Surface table.

## Admin-key lifecycle — go 0.39.0 (`go/v0.39.0`) · ts 0.29.0 (`ts-v0.29.0`) · java 0.28.0 (`java-v0.28.0`) · web-admin 0.8.13 (2026-07-26)

Tracks issuer **v0.61.0** (ADR-085 §2/§3/§7). SPEC §6.5 updated first.

- **`label` on every api-key list row.** The issuer omitted it, so the SDK
  types carried a comment saying "note there is **no** `label`". It is in fact
  the *only* handle on a key — the plaintext is echoed once at create and
  `prefix` is derived from the stored hash — so an `rk_live_…` found in a
  deployment config could not be traced to its row by any value.
- **`expires_at` everywhere** (create response + list rows). Nullable, and
  `null` is a **value**: "never expires", not "unknown". Go gains
  `APIKey.Expired(now)`, Java gains `expired(nowEpochSeconds)`, next to the
  existing `Revoked()` — an expired key returns the same envelope as a revoked
  one at login, so callers that need to tell an operator which it was have to
  ask separately.
- **`ttl_seconds` / `non_expiring` on create.** Omitting both applies the
  issuer's built-in 90-day default; the 300s floor rejects rather than clamps.
- **Two new create failures callers must expect** (ADR-085 §2, documented on
  the SPEC surface): `too_many_api_keys` (409 — a realm holds at most 2 active
  platform keys, one steady state plus one rotation slot) and
  `non_expiring_not_allowed` (400 — at most one permanent key). Revoked and
  expired keys free their slot, so mint-new → deploy → revoke-old always fits.

## Owner-required tenant create + BYO id/created_at — go 0.38.0 (`go/v0.38.0`) · ts 0.28.0 (`ts-v0.28.0`) · java 0.27.0 (`java-v0.27.0`) (2026-07-24)

`Tenants.Create` now provisions the org **and its owner** in one call (ADR-073
Amendment C, SPEC §6.1). The create payload gains three fields across all three
SDKs:

- **`owner`** (`TenantOwner` / `TenantCreate.owner`) — **required when creating
  a new tenant**; the server rejects an ownerless create with `owner_required`
  now that `tenants.owner_user_id` is `NOT NULL` (ADR-076). Shape:
  `{ user_id?, email?, phone?, display_name?, provider?, provider_uid? }`, ≥1 of
  email/phone, and deliberately no `role`. May be omitted only on a pure
  reconcile of an already-owned tenant.
- **`id`** — optional bring-your-own tenant UUID for verbatim migration; a known
  id reconciles idempotently, a foreign-realm id is `cross_realm_tenant_id`.
- **`created_at`** — optional RFC3339 creation timestamp (ignored on reconcile).

Import rows (`ImportUserRow`) also gain an optional **`created_at`** ("member
since"). Additive on the wire; the `owner` requirement is the one breaking
change for callers that created empty tenants and invited later. SPEC §6.1/§6.3.

## Cross-realm integrations — go 0.37.0 (`go/v0.37.0`) · ts 0.27.0 (`ts-v0.27.0`) · java 0.26.0 (`java-v0.26.0`) · web-admin 0.8.10 (2026-07-23)

New `realm.integrations.*` surface across go/ts/java (and `admin.integrations`
in `@realm-id/web-admin`) for the ADR-082/083 cross-realm integration model, plus
a 7th `/auth/login` grant. Additive; SPEC §6.14.

- **Source side** (the publishing platform): `register`, `list`, `update`,
  `disable`/`enable`, `remove`. These take no platform id — the SDK is per-realm
  and the source is its own realm, like `realm.roles.*`.
- **Target side** (the installing org owner): `install(tenantId, {integrationId,
  roleId})`, `listInstallations(tenantId)`, `uninstall(tenantId, installationId)`.
  The `roleId` MUST name a role whose `assignable_to` is exactly `["service"]`
  (ADR-082 §7.1) or the install fails `role_not_service_typed`.
- **`mintToken({ apiKey, installationId, sourceOrgId })`** — the brokered mint.
  Authenticated by the source realm's raw `platform_api` key (no bearer rides
  along); **returns an access token only — no refresh token, fixed 600 s TTL.**
  Deliberately NOT a token-manager credential: the token cannot refresh, so the
  caller re-mints (and may cache for `< expires_in`). This matches the M2M
  standard (OAuth 2.0 client-credentials / GitHub App installation tokens / AWS
  STS) — see `DECISIONS.md` 2026-07-23 and `docs/integration-guide.md` §9.
- **Nine new error codes** registered in every SDK's code taxonomy so the flat
  issuer envelope maps precise sentinels: `slug_taken`, `integration_not_found`,
  `already_installed`, `role_not_service_typed`, `role_not_installable`,
  `installation_not_found`, `installation_revoked`, `role_unavailable`,
  `key_class_mismatch`. Documented in `docs/error-reference.md`.
- **web-admin** reuses the ts `IntegrationsClient` verbatim via
  `@realm-id/sdk/internal`, exposed as `admin.integrations`.

## Role principal typing + invitation scope — go 0.36.0 (`go/v0.36.0`) · ts 0.26.0 (`ts-v0.26.0`) · java 0.25.0 (`java-v0.25.0`) (2026-07-22)

Types two role fields the issuer had shipped without any SDK surface:
`assignable_to` (ADR-081 principal typing, issuer v0.55.0–v0.57.0) and
`can_invite_roles` (ADR-076 WP4 invitation scope, issuer v0.41.0). Additive; no
wire or SPEC change — this is the SDK catching up to a live surface, not a new
one.

- **`RoleObject`** gains `can_invite_roles` and `assignable_to`, plus the
  read-only `migrated_holders` / `migrated_holders_to` that appear ONLY on the
  PATCH response of a narrowing that moved human holders (ADR-081 §2.5). The
  count is nullable/pointer in every language on purpose: a reported `0`
  ("narrowed, moved nobody") must stay distinguishable from the field being
  absent.
- **`RoleCreate` / `RolePatch`** gain both fields on the write side. `create`
  and `update` forward them under their wire names.
- **`assignable_to` has no "clear"**, unlike its sibling arrays. Since ADR-081
  § Amendment 2 the server rejects an explicit `[]` with 400
  `assignable_to_required`, so PATCH sends the kinds or omits the key. On
  create, OMITTING the key defaults to both kinds server-side (the field is
  younger than its clients) — the Go type uses `omitempty`, so an empty slice
  omits rather than 400s, which is deliberate.
- **TS gains a `PrincipalKind = "human" | "service"` union** (exported from the
  package root and `/internal`) rather than `string[]`: the server vocabulary is
  closed and an unknown value is a hard 400, so a typo should fail at compile
  time. Go and Java stay `[]string` / `List<String>`, matching how those SDKs
  already type the equally-closed `required_mfa_methods`.
- **Java records grew their canonical constructors**; the prior arities are
  retained as delegating constructors, so existing positional callers still
  compile. New `RolePatch.onlyAssignableTo` / `.onlyCanInviteRoles` factories.
- **Fixed: the Go `Version` const had drifted a release behind its tag** — it
  read `0.34.0` while `go/v0.35.0` was published. That is the exact failure its
  own doc comment records from `go/v0.29.0` (it misled a partner into thinking a
  shipped surface was unreleased). Now `0.36.0`.

## Realm-config read + platform/fleet stats — go 0.35.0 (`go/v0.35.0`) · ts 0.25.0 (`ts-v0.25.0`) · java 0.24.0 (`java-v0.24.0`) · web-admin 0.8.8 (2026-07-21)

Typed surface for the issuer v0.52.0 read endpoints. Additive; no wire or
SPEC change.

- **`GET /platforms/{id}/config`** — read counterpart of the long-standing
  PATCH. `realm.config.get()` (go `ConfigClient.Get`, ts `ConfigClient.get`,
  java `ConfigClient.get`), and `admin.platforms.getConfig(platformId)` in
  web-admin. The config body stays a loose map in the partner SDKs (the key set
  is derived server-side from `RealmConfigPatch`); web-admin types it as
  `RealmConfigPatch` / `RealmConfigView` for the admin UI.
- **`GET /platforms/{pid}/stats`** — platform KPI rollup, fully typed:
  `PlatformStats{platform_id, generated_at, orgs_count, users_count,
  sessions_24h, mfa_coverage{covered_users, eligible_users, percent}}`.
  `percent` is **nullable** — null when `eligible_users == 0`.
  go/ts/java: `realm.stats.get()`; web-admin: `admin.platforms.stats(id)`.
- **`AdminStats` gained the fleet fields** `platforms_active`,
  `platforms_suspended`, `platforms_new_7d`, `sessions_24h` (all four
  optional/zero against an older issuer). `sessions_24h` is a FLOW (human
  sign-ins in the trailing 24h), distinct from the `sessions_active` gauge.
- **web-admin only:** `admin.platforms.updateConfig(id, patch)` (retires the
  UI's local `patchRealmConfig` shim), `TenantSummary.users_count` /
  `last_activity_at` (both optional — absent means "not computed", not 0), and
  `AdminStats` is now re-exported from `@realm-id/sdk` instead of being
  redeclared as a loose blob (the two declarations collided at call sites).

## ADR-080 Phase B + session-revoke + MFA-self parity — go 0.34.0 (`go/v0.34.0`) · ts 0.24.0 (`ts-v0.24.0`) · java 0.23.0 (`java-v0.23.0`) · web-admin 0.8.7 (2026-07-20)

Typed parity for the 8 issuer v0.50.0 surfaces (backend already live; these
were reachable via the BFF `/api/*` passthrough, now typed). Go is the
reference; ts/java/web-admin mirror it idiomatically.

- **Contact-binding (ADR-080 Part 2/3):** `Users.DelinkContact` /
  `Users.HandBack`; drift `Reject` is now the SOFT (non-destructive) reject and
  `RejectHard` parks the account. `DriftRejectResult` reshaped to `{ id, status,
  mode, parked?, revoked_bindings? }` (old `new_user_id`/`original_value` removed).
- **Session-revoke (ADR-080):** new `Sessions` client — `RevokeUser(tenant,user)`
  (admin force-logout) + realm-wide mass logout (`RevokeAll` in go/ts/java;
  `revokeRealmSessions(realmId)` in web-admin, where `revokeAll` was already the
  self op). Distinct from `Auth.RevokeAllSessions` (the caller's own sessions).
- **MFA self-service:** `Auth.ListAuthenticators` + `Auth.RegenerateRecoveryCodes`
  (the latter may surface `mfa_required` 412 step-up / `conflict` not_enrolled).
  In web-admin these live on `admin.mfa`.
- **Error code:** `contact_admin_required` (409) added to each SDK's known-code
  set (web-admin exposes an `isContactAdminRequired()` helper since it can't widen
  the bundled `@realm-id/sdk` union).
- **Error-decoder fix (go + java):** the decoders only read the specific `code`
  from the *nested* `{error:{code}}` envelope; the issuer's `apiErr` shape is FLAT
  (`{error:"<str>",code}`), so codes like `contact_admin_required`/`refresh_invalid`
  silently degraded to the HTTP-class code. Both now read the top-level `code` (and
  fall back to the `error` string for the message). TS already handled it.

## ADR-075 roles: `required_mfa_methods` write surface — go 0.32.0 (`go/v0.32.0`) · ts 0.22.0 (`ts-v0.22.0`) · java 0.20.0 (`java-v0.20.0`) · web-admin 0.8.5 (2026-07-15)

Additive across all four SDKs. Fans out the per-role MFA requirement
(ADR-075 §4) to the role CRUD surface.

- **`RoleObject.required_mfa_methods` / `.requiredMfaMethods()`** — the role's
  MFA method set (subset of `{"totp","otp"}`), always an array. Decoded on
  list/create/update responses.
- **`RoleCreate` / `RolePatch` gain `requiredMfaMethods`** — forwarded as the
  `required_mfa_methods` wire field on `POST` / `PATCH /platforms/{id}/roles`.
  go: `RoleCreate.RequiredMFAMethods []string`, `RolePatch.RequiredMFAMethods
  *[]string` (nil = don't touch, `&[]{}` = clear). ts: optional
  `requiredMfaMethods?: string[]`. java: added record component + back-compat
  constructors (`RoleCreate(name,display,perms)` still compiles;
  `RolePatch.onlyRequiredMfaMethods(...)`).
- **web-admin 0.8.5** re-vendored: `Platform.mfa_policy`
  (`"disabled"|"enabled"|"enforced"`, ADR-075) added to the type; bundled
  `@realm-id/sdk` carries the new roles surface.
- The platform `mfa_policy` config key itself rides the existing generic
  realm-config PATCH (no new typed SDK method). No breaking change.

## ADR-074 roles: `listPermissions()` + delete `migrate_to` — go 0.31.0 (`go/v0.31.0`) · ts 0.21.0 (`ts-v0.21.0`) · java 0.19.0 (`java-v0.19.0`) · web-admin 0.8.4 (2026-07-14)

**All SDKs, additive.** Surfaces the two new issuer capabilities from ADR-074
(real permission enforcement):

- **`ListPermissions()` / `listPermissions()`** on the roles client — returns the
  live catalog (`GET /platforms/{id}/permissions`) as `[]Permission{key, resource,
  action, label}`. Served live (not a static SDK const) so consumers never drift
  from the server's catalog. `Permission` is re-exported from `@realm-id/web-admin`
  (0.8.3→**0.8.4**, re-vendored into `ui/`).
- **`Delete(roleID, migrate_to)`** — ts `delete(id, {migrateTo})`, go variadic
  `RoleDeleteOpts{MigrateTo}`, java `delete(id, migrateTo)` overload. Forwards
  `?migrate_to=<name>` so an in-use role's holders are reassigned server-side in
  one transaction instead of a 409.

Purely additive — `RoleObject.permissions` already existed and catalog validation
is server-side; absent the query param, delete is unchanged. No BFF change
(generic `/api/*` passthrough).

## Go `const Version` realigned to the module tag — go 0.30.0 (`go/v0.30.0`) (2026-07-14)

**Go SDK only, no functional change.** `realmid.Version` had drifted from the
resolvable module tag: `go/v0.29.0` shipped with `const Version = "0.20.0"`, which
led the Traide integration team to read the ADR-071/072 service-account surface as
"unreleased" (it was live in `go/v0.29.0`). Realigned the const to the module-tag
scheme — `go/v0.30.0` now reports `Version = "0.30.0"` — and documented that the two
MUST stay in lockstep every release. The value you `go get` is the source of truth.
No API/behavior change; the ADR-071/072 surface is unchanged from `go/v0.29.0`.
TS (`@realm-id/sdk`) and Java (`dev.realmid:sdk`) are versioned from their own
package manifests and are unaffected.

## Service accounts + OTP-login cutover + sources registry — go 0.20.0 + ts 0.20.0 + java 0.18.0 (tags TBD) (2026-07-14)

ADR-071/072 SDK surface (go reference; **ts + java parity shipped in WP6**):

- **OTP login grant renamed** `otp_internal` → `otp` (ADR-071 §4 direct cutover).
  `Auth.OTPLogin` sends `grant_type=otp`; `Auth.MFAVerifyOTP` sends `method=otp`.
  No dual-accept — safe because `otp_login_enabled` is default-off.
- **`OTP.Issue` gains `DeliveryMode`** (`DeliveryModeViewBFF = "view_bff"`), threaded
  onto `/auth/otp/issue` as `delivery_mode`.
- **`Session.InitiatedByUserID`** — decodes the issuer's `initiated_by_user_id`
  provenance (the owner/admin who minted a service account's login OTP, ADR-071 §8).
- **`realm.ServiceAccounts`** (new client) — Create / List / Get / ResetHandle /
  Suspend / Unsuspend / Deactivate / Revoke over `/tenants/{id}/service-accounts`
  with typed error sentinels (`ErrServiceAccountHandleTaken`, `…InvalidRole`,
  `…NotFound`).
- **`realm.Sources`** (new client, ADR-072) — List / Create / Update / Delete over
  `/sources` (the app/source registry; `allowed_methods` = mapping-2), with
  `ErrSourceMethodViolatesKind` / `ErrSourceNotFound`.
- SPEC.md updated: `otp_internal` → `otp` across the grant/method tables.

Dep-free; stdlib tests. Tag `go/vX.Y.Z` (TBD) at the coordinated release.

**WP6 — ts + java parity port (2026-07-14).** Same surface ported to `@realm-id/sdk`
(0.19.0 → **0.20.0**) and `dev.realmid:sdk` (0.17.0 → **0.18.0**), matching the go
reference exactly: `auth.otpLogin` sends `grant_type=otp` (drops the deprecated
`method` field); `auth.mfaVerifyOtp` sends `method=otp`; `otp.issue` gains
`deliveryMode` (`view_bff`, TS `DELIVERY_MODE_VIEW_BFF` / Java
`OtpIssueRequest.DELIVERY_MODE_VIEW_BFF`); the login/verify session decodes
`initiated_by_user_id` (TS `initiatedByUserId`, Java `Session.initiatedByUserId`);
new `realm.serviceAccounts` (TS) / `realm.serviceAccounts()` (Java) and
`realm.sources` / `realm.sources()` clients. New server error codes
(`handle_taken`, `invalid_role`, `service_account_not_found`, `not_service`,
`method_violates_kind`, `source_not_found`, `user_not_found`) surface on the
existing `RealmError.code` (TS) / `ErrorCode` + `RealmException` (Java) convention.
TS suite 136/136, Java suite 121/121 green. Tags `ts-vX.Y.Z` / `java-vX.Y.Z` held
for the coordinated release.

## Roles enable/disable + owner signing-keys client — go/v0.28.0 + ts-v0.19.0 + java-v0.17.0 + web-admin 0.7.1 (2026-07-13)

Cross-cutting, additive — SDK parity for the issuer v0.32.0 roles/signing-keys
overhaul (endpoints already shipped; swagger reconciled). See `DECISIONS.md`
(2026-07-13).

- **Roles disable/enable.** `RolesClient` gains `disable(roleId)` /
  `enable(roleId)` (POST `…/roles/{id}/disable|enable`) and a `disabled` /
  `disabled_at` field on the role object; `RoleListOpts` gains
  `includeSystem` (→ `?include_system=true`, surfaces the server-hidden
  `platform_api` row). go/ts/java + web-admin (reuses the ts `RolesClient`).
- **Owner signing-keys client.** New `SigningKeysClient` — `list()` (GET
  `/platforms/{id}/signing-keys`: keyring newest-first + rotation policy) and
  `rotate()` (POST `…/rotate`, self-serve owner rotate; shares the server rate
  limiter). Exposed as `realm.signingKeys` (go/ts/java) and `admin.keys`
  (web-admin, reusing the ts client via `@realm-id/sdk/internal`). Distinct
  from web-admin's existing base-staff `admin.signingKeys` ops client
  (`/admin/platforms/…`).
- **Per-tenant (org) config typing.** ts `TenantsClient.updateConfig` gains a
  typed `TenantConfigPatch` (`role_overrides` / `default_invitation_role`);
  go/java `updateConfig` already accepted an arbitrary config map (no change).

- **web-admin: `platforms.listPendingDomains()`** (+ `PendingDomain` type) —
  wraps issuer `GET /domains/pending` so the onboarding UI can list/resume
  in-progress domain verifications (issuer v0.33.0). Browser-admin only.

Fully backward compatible (absent `disabled`/`is_current` etc. decode to
zero-values). web-admin (0.7.1) re-vendored into `Realm-ID/ui`, retiring the UI's
`disableRole`/`enableRole`/`listSigningKeys`/`rotateSigningKey`/`patchTenantConfig`
`api.ts` shims.

## `is_base` on `MeMembership` — web-admin `@realm-id/web-admin@0.6.1` (2026-07-11)

Browser-admin SDK only, type-only. Adds optional `is_base?: boolean` to
`MeMembership` so admin UIs can tell the base-realm ops workspace ("RealmID")
apart from real platforms (the flag is set by the BFF — see the RealmID
`api/DECISIONS.md`). Optional for back-compat with pre-`is_base` BFFs; no other
language SDK affected. See `DECISIONS.md` (2026-07-11).

## `idle_ttl` on login/token/refresh — idle session timeout (ADR-070) — go/v0.27.0 + ts-v0.18.0 + java-v0.16.0 (2026-07-10)

Cross-cutting, additive. See `DECISIONS.md` (2026-07-10). Versions/tags picked
centrally by the orchestrator — headings say "next" until then.

- **`idle_ttl` (ADR-070).** Login and token/refresh responses now carry
  `idle_ttl` — the sliding-window idle-timeout **duration** in seconds. Each
  authenticated use slides the window forward; the session dies if idle past it.
  Surfaced as Go `Session.IdleTTL`/`MintResult.IdleTTL` (int64,
  `json:"idle_ttl,omitempty"`), TS `LoginResponse.idleTtl`/`TokenResponse.idleTtl`
  (`number?`, wire `idle_ttl`), Java `Session.idleTtl`/`TokenResponse.idleTtl`
  (`long`, `@JsonProperty("idle_ttl") @JsonAlias("idleTtl")`).
- **Backward-compatible.** Optional/omitempty; absent or `0` means *no idle
  timeout* (Go/Java decode `0`, TS `undefined`) — treat as disabled, never
  "expire now". The BFF reads it to enforce the per-realm idle window; the SDK is
  a pass-through. Guard tests cover present-value + absent→0/undefined on both
  Session and the token/mint result in all three languages.

## `refresh_exp` on the wire + drop dead `Origin.DetachedAt` (go/v0.26.0 · ts-v0.17.0 · java-v0.15.0)

Cross-cutting, additive. Two contract changes cut together — see `DECISIONS.md`
(2026-07-09).

- **`refresh_exp` (SPEC §4.1/§4.2).** Login (`Session`) and token (`MintResult`)
  responses now carry `refresh_exp` — the refresh token's **absolute** expiry in
  unix seconds (min of the rolling TTL, the ADR-054 scheduled cutoff, and the
  ADR-058 absolute session cap). Distinct from `expires_in` (access-token TTL).
  Exposed as Go `Session.RefreshExp`/`MintResult.RefreshExp` (int64), TS
  `refreshExp?` (number), Java `refreshExp` (long). **Forward/backward
  compatible:** absent decodes as `0`/`undefined`; a consumer sizing a session
  from it (the BFF store) must fall back to a local ceiling on the zero value.
  Pairs with issuer v0.28.0 (emit) + BFF v0.17.0 (consume, retiring its 30d
  guess).
- **Go: removed `Origin.DetachedAt`** (and the dead allowlist filter). The issuer
  never serialized `detached_at` and already filters detached origins
  server-side; the field was always nil and its `*string` type re-armed the
  go/v0.21.0 numeric-`created_at` decode outage. `encoding/json` ignores unknown
  fields, so removal is safe. Go-only; no TS/Java equivalent existed.

## SessionInfo last-used timestamp — decode from issuer `last_seen_at` (go/v0.25.1 · ts-v0.16.1 · java-v0.14.1)

Cross-cutting fix across all three SDKs. `SessionInfo.LastUsedAt` (Go) /
`lastUsedAt` (TS/Java) was mapped from `last_used_at`, but the issuer's session
DTO emits `last_seen_at` (int64 unix seconds,
`issuer/internal/httpapi/sessions.go`), so the field always decoded to zero.

- **Go**: fixed both the `SessionInfo` json tag **and** the live
  `decodeSessionPage` map key — the struct tag alone wouldn't fix `ListSessions`,
  which hand-decodes rather than `json.Unmarshal`.
- **Java**: `@JsonProperty("last_seen_at")` + defensive `@JsonAlias`.
- **TS**: `listSessions` never snake→camel mapped, so `SessionInfo` was realigned
  to the honest wire shape (`last_seen_at`, `created_at`, `origin`, `device_name`).

Public accessor names (`LastUsedAt` / `lastUsedAt`) unchanged. Regression guards
added in all three. RCA in `DECISIONS.md`.

## web/v0.4.5 — `@realm-id/web`: `resolveTenant()` completes a tenant picker without a second provider redirect

`@realm-id/web`. Adds `realm.resolveTenant(tenantId)`: when a provider-driven
login (`signIn` / `completeSignIn` / `login`) gates on `tenants_required`, the
SDK now retains the provider token and re-submits it with the chosen tenant —
instead of forcing the app to re-run the whole OIDC redirect. Fixes the
Microsoft double-round-trip (IdP → picker → IdP → dashboard) on realm-root
origins. Additive, backward-compatible patch (peers pin `^0.4.0`). Retained
token is single-use (cleared on session-issue / logout). Rationale +
tradeoffs in `DECISIONS.md`.

## go/v0.25.0 — login speaks `grant_type`, retiring the deprecated `method` field (ADR-051)

`github.com/Realm-ID/sdk/go`. `Auth.Login` now sends
`grant_type=provider_token` + `provider=<idp>`, and `OTPLogin` sends
`grant_type=otp_internal`, instead of the deprecated `method` field
(Sunset **2026-08-01**). This is the **BFF→issuer** hop — the correct place
for this migration (the web SDK↔BFF hop keeps the BFF's own `{method, token}`
contract; see web-bff-realmid/v0.3.6 for why 0.3.5's web-side attempt was
wrong). Public Go API is unchanged: callers still pass `LoginMethod`
(firebase/google/microsoft), which now rides through as the `provider` hint.
Once every caller is on ≥0.25.0, the issuer's `legacyMethodToGrant` shim can be
deleted at the sunset. No behavioural change against issuer ≥v0.27.1 (which
handled both forms); `MFAVerify`'s `method` is the MFA-factor field and is
untouched.

## web-bff-realmid/v0.3.6 — revert login to `method` (0.3.5 targeted the wrong hop)

`@realm-id/web-bff-realmid` preset. Reverts 0.3.5: the web SDK talks to the
**BFF**, whose `/login` contract is `{ method, token }` (`api` `handlers.go`
requires them) — **not** the ADR-051-deprecated issuer field. 0.3.5 sent
`grant_type` to the BFF and broke login with `method and token are required`.
The `method`→`grant_type` migration belongs on the **BFF→issuer** hop (the Go
SDK), not the web↔BFF hop. Login adapter sends `method` again.

## web-bff-realmid/v0.3.5 — login speaks `grant_type` (retire the deprecated `method` field)

`@realm-id/web-bff-realmid` preset. The login request adapter now sends
`grant_type=provider_token` + `provider=<idp>` (ADR-051) instead of the
deprecated `method` field (Sunset 2026-08-01). Previously every web login rode
the issuer's `legacyMethodToGrant` compat shim — which is why Microsoft login
broke when that shim lacked a `microsoft` case (fixed issuer v0.27.1). Migrating
the wire removes the dependency entirely: provider logins (google/microsoft/
firebase) no longer touch the shim, and the issuer can drop it at Sunset. OTP →
`grant_type=otp_internal`; native/unknown methods fall back to `method` until
they gain a first-class grant. Login regression tests updated to assert the new
wire shape (grant_type + provider, no `method`).

## web-bff-realmid/v0.3.4 — providers adapter reads wire `type` (fixes Microsoft sign-in)

`@realm-id/web-bff-realmid` preset. The public providers response names the
provider field `type` (`{"type":"microsoft",…}`), but the adapter read
`provider`, mapping it to `""`. The OIDC `signIn` path (`resolveProvider`) then
found no row and threw `no <type> provider configured for this realm`. Only
Microsoft hit this — Google/Firebase sign in via the Firebase popup, which never
calls `resolveProvider`.

- **`adaptProviders` now reads `p.type ?? p.provider`.** (The source fix landed
  in `014bf4e` without a version bump, so the vendored `0.3.3` tarball never
  carried it; this bump forces a re-vendor.)
- **Regression test** exercises the real wire shape (`type`, no `provider`) —
  the prior test mocked `provider:`, which is why the gap shipped.

## web/v0.4.4 — reload no longer signs you out (restore sends the session bearer)

`@realm-id/web` browser SDK. Fixes the client-side half of the ">15m reload
signs me out" bug (the BFF half shipped as api v0.15.4):

- **`restore()` now attaches the session bearer** to its `/me` revalidation
  (`accessToken: this.tokens.peek()`), like the refresh path already did.
  Previously it sent a bearerless `/me`; the BFF requires
  `Authorization: Bearer rsid_…` (`loadSession`) and 401'd `session_missing`,
  dropping the just-adopted session to anonymous and racing the app's own
  authed `/me` (the `no current tenant` + sign-out symptoms).
- **Tokenless mode keeps the durable session across the access-TTL.**
  `readStoredSession` no longer discards the stored snapshot when its
  `expiresAt` (the ~15m access-JWT hint) passes — under `refresh.tokenless`
  the stored `accessToken` is the durable, server-rotated session bearer, so
  the snapshot is adopted and `restore()` re-validates it. Classic
  (self-expiring-bearer) mode is unchanged.
- Rolls up web/v0.4.3 (Firebase `projectId` into the signIn driver), which the
  admin app had not yet vendored.

Regression tests: `restore()`'s `/me` must carry the bearer; a tokenless reload
>15m after mint keeps the session. Both reproduced the prod bug (red) against a
BFF-faithful mock before the fix. RCA: see `DECISIONS.md`.

## go/v0.24.0 (pending tag) — Middleware extension hooks + RI-driven origin enforcement (ADR-065)

Lets a BFF run the **entire** auth flow through `Realm.Middleware` (login /
token / logout / mfa / origin / cookie / response) and plug into it via
callbacks, instead of forking the four `/auth/*` routes. Unblocks a
partner's P0 (session-survives-reload via cookie mode + in-middleware mirror
reconcile). Pairs with an issuer change adding `RealmConfig.origin_enforcement`
(surfaced on `realm.Info()`).

- **go** `MiddlewareOptions.BeforeLogin(ctx, *LoginRequest) error` — mutate
  the login request before `Auth.Login` (e.g. sync-install key swap).
- **go** `MiddlewareOptions.OnAuthSuccess(ctx, *AuthSuccessEvent) error` —
  post-mint / pre-cookie callback; non-nil error fails the request
  (routed to `OnAuthFailure`). Event is normalized across login/refresh/mfa
  (`UserID`/`TenantID`/`Role` always set; on refresh the SDK verifies the
  minted access token to recover `UserID`, only when the hook is set).
- **go** `MiddlewareOptions.OriginEnforcement` (`Auto`|`On`|`Off`, default
  `Auto`) — confused-deputy Origin guard; `Auto` follows
  `realm.Info().OriginEnforcement`. Emits `missing_origin` /
  `realm_origin_mismatch`. Fails **open** on Auto-mode discovery failure.
- **go** `handleLogin` now forwards `tenant_id`/`tenantId` from the body
  into `LoginRequest.TenantID` (was silently dropped).
- **go** exported `Realm.SetRefreshCookie` / `ReadRefreshToken` /
  `ClearRefreshCookie` — delegate cookie mechanics without adopting the
  full middleware.
- **go** `RealmInfo.OriginEnforcement` added (read from `GET /platforms/mine`).
- **BREAKING (go)** `MiddlewareOptions.OnAuthFailure` changed from the
  response-owning `func(http.ResponseWriter, *http.Request, *RealmError)`
  to the observe-only `func(ctx, *AuthFailureEvent)`. The middleware now
  always writes the canonical error envelope; the hook is for side effects
  (audit/metrics) only. Callers that wrote a custom error body must move
  that logic elsewhere. (No in-repo caller used the old form.)
- **test** `middleware_hooks_test.go` — tenant_id passthrough + BeforeLogin
  mutation, OnAuthSuccess on login + refresh (verify-recovered UserID),
  fail-closed (no Set-Cookie leak), origin enforcement On + Auto.

## go/v0.22.0 — Fix: timestamp fields typed `string` crashed strict decode → BFF `/auth/*` login outage (2026-06-30)

A Go-only hotfix. `Origin.CreatedAt` (and `SessionInfo.CreatedAt`/
`LastUsedAt`, `Tenant.CreatedAt`/`UpdatedAt`) were typed `string`, but the
issuer serializes every list/get `created_at`/`updated_at` as a unix-seconds
JSON **number** (e.g. `toDomainDTO → CreatedAt.Unix()`). Because the BFF
guards the unauthenticated `/auth/*` proxy routes with `Origins.Validate`
(`GET /platforms/{realm}/origins`), the strict decode of a populated origins
row threw — `cannot unmarshal number into Go struct field
Origin.items.created_at of type string` — **before login could run, taking the
whole `/auth/*` surface down** (502) for partners on go/v0.21.0.

- **go** `Origin.CreatedAt` `string` → `int64` (the outage). `origins.go`.
- **go** `SessionInfo.CreatedAt` + `LastUsedAt` `string` → `int64`; the
  hand-decoder in `decodeSessionPage` switched from `strField` to a new
  `intField` helper (numbers decode to `float64` in `map[string]any`).
  `auth.go`.
- **go** `Tenant.CreatedAt` + `UpdatedAt` `string` → `int64`. `tenants.go`.
- **test** new `TestOrigins_DecodesNumericCreatedAt` exercises an origins-list
  decode against a representative server payload (numeric `created_at` +
  `verification_id`), and `TestAuth_ListSessions_OnBehalfOf` now carries a
  numeric `created_at` — closing the gap that let the mistype ship (no prior
  origins/session test populated a timestamp).

**Contract** (confirmed against the issuer): `created_at`/`updated_at` are
unix-seconds `int64` on every list/get the Go SDK models. The lone server
exception is the platform-transfer endpoints (ADR-063), which emit RFC3339
strings — but the Go SDK does not model platform transfers, so the fix is
plain `int64`, **not** a string-or-number union. (`expires_at` genuinely
varies per endpoint, but is off the login path.) Two pre-existing latent
issues surfaced while fixing this are tracked in `TODO.md`
(`SessionInfo.LastUsedAt` json tag vs server `last_seen_at`; `Origin.DetachedAt`
not serialized by the issuer).

Pin `go/v0.22.0` to restore login. No TS/Java change.

## All — IdP provider `config` on the admin write surface (SPEC §6.10) — go/v0.23.0, ts 0.16.0, java 0.14.0 (2026-06-29)

The issuer has accepted/served the identity-provider **PUBLIC config** map
(`config`, e.g. the Firebase web config: `apiKey`, `authDomain`,
`projectId`, `appId`) on `POST`/`PATCH /identity-providers` and on public
discovery since issuer **v0.16.0** (ADR-046). The SDKs' admin
write surface (`identityProviderConfig.create` / `.update`) lagged — it
exposed only the read side. This release closes that gap so a partner can
seed/rotate provider config with a released SDK instead of a raw HTTP call.

- **all** `IDPConfigCreate` / `IdpConfigCreate` gain an optional `config`
  map; sent on create when non-empty.
- **all** `IDPConfigPatch` / `IdpConfigPatch` gain an optional `config`
  map. Supplying it **replaces the stored map wholesale** (not merged),
  matching the server. (Java adds `IdpConfigPatch.onlyConfig(...)` and
  keeps the prior constructors via a backward-compatible overload.)
- **all** the read model (`IDPConfig` / `IdpConfig`) now carries a typed
  `config` field (Go/TS already round-tripped it on discovery).
- **spec** SPEC §6.10 documents `config` on the `IdpConfig` shape and on
  `create`/`update`.

No behaviour change for callers that don't set `config`. Publishable
values only — never put secrets in `config`.

## go/v0.19.0 — Platform-intrinsic audience (ADR-064) + on-behalf typed forwarding (ADR-056) — go (2026-06-20)

- **go** `verify`: the expected audience is the platform-intrinsic value
  `realmid:<public_ref>` (learned from `GET /platforms/mine`); the legacy
  **fallback to the realm domain is removed** (ADR-064). A realm always has a
  stable audience, so the "audience auto-discovery returned empty" footgun no
  longer triggers for configured platforms. Tokens also carry an informational
  `domain` claim (display/routing only, never an isolation key).
- **go** `X-User-Token` (on-behalf-of, ADR-056) is now forwarded on the
  **typed client path** (`Tenants.*`, `Origins.*`, `Auth.*`), not just
  `Realm.Do`. A token stashed via `WithUserToken(ctx)` makes user-scoped typed
  calls authorize on the user, not the platform principal. Closes a
  partner-reported on-behalf-of gap.
- ts/java: no code change for the audience increment — their verifiers resolve
  audience via the info resolver (no domain fallback) and pick up the new
  `realmid:<ref>` value automatically. Lockstep on-behalf forwarding + the
  ADR-064 §3 local-derivation increment tracked for the next SDK cut.
- Version bumps held until the release phase (whole feature set ships together).

## All — Refresh-authed MFA self-enrollment (ADR-061, SPEC §4.8) — go/v0.18.0, ts, java, web bff-realmid 0.3.3 (2026-06-09)

Breaking: the self-service MFA enrollment surface is now a single
refresh-authed call. Lockstep across all SDKs + the reference BFF preset.

### Changed (breaking)

- **`selfEnrollMfa(req)` replaces `enrollMfa` + `confirmMfa`.** Posts
  `{ refresh_token, tenant_id, method? }` to `POST /auth/mfa/enroll` (the
  platform token auto-attaches as bearer; the refresh rides the body, as
  for `token()`). Returns `{ secret, qrUrl, recoveryCodes,
  mfaChallengeToken, tenantId }`. The enroll-scoped `mfaChallengeToken`
  is completed via `mfaVerify` — a single verify confirms the new secret
  AND mints tokens, so the separate `confirmMfa` (`POST /auth/mfa/confirm`)
  is gone. Lets a first-login user (no access token — the MFA gate
  withheld it) self-enroll off their refresh.
  - Go: `AuthClient.SelfEnrollMFA(SelfEnrollMFARequest{RefreshToken,
    TenantID, Method})`; `MFAEnrollment` gained `MFAChallengeToken` +
    `TenantID`. `EnrollMFA`/`ConfirmMFA` removed.
  - TS: `auth.selfEnrollMfa({ refreshToken, tenantId, method? })`;
    `MfaEnrollment` gained `mfaChallengeToken` + `tenantId`.
    `enrollMfa`/`confirmMfa` + `ConfirmMfaRequest` removed.
  - Java: `auth.enrollMfa(SelfEnrollMfaRequest)`; `MfaEnrollment` gained
    `mfaChallengeToken` + `tenantId`. `ConfirmMfaRequest` deleted.
  - web `@realm-id/web-bff-realmid` (0.3.2 → 0.3.3): the
    `mfa_registration_required` gate now surfaces `sessionToken`
    (`session_token`) — the BFF's pending-MFA session the SPA bears to
    `/auth/mfa/enroll`.
- **Unchanged:** `disableMfa` (`DELETE /auth/mfa`, step-up) and the admin
  `tenants.users.{enrollMfa,confirmMfa,resetMfa}` surface.
- **Known issue — `recoveryCodes` not yet redeemable.** `selfEnrollMfa`
  returns `recoveryCodes`, but the issuer has no redemption path yet; do
  not present them to end users as a recovery mechanism until the redeem
  flow ships (a follow-up). Account recovery after authenticator loss
  currently requires an admin MFA reset.

## All — SPEC reconciliation: `subjectType` on `token()` + `realm_mismatch` code (2026-06-03)

Additive on the wire; no version bump cut yet (unreleased, lands with the
next lockstep tags). Three SPEC-vs-code divergences closed:

### Added

- **`subjectType` on the `token()` response** (SPEC §4.2). The issuer has
  always returned `subject_type ∈ {user, service, platform}` on
  `POST /auth/token` (it is `required` in the swagger `TokenResponse`); the
  SDKs were dropping it. Now surfaced as Go `MintResult.SubjectType`, TS
  `TokenResponse.subjectType`, and Java `TokenResponse.subjectType`.
  `tenantId` / `role` remain user-only.
- **`realm_mismatch` error code** (SPEC §3.1) — the ADR-041 **client-side**
  realm pin: the SDK decodes the freshly-minted platform access token and
  raises `realm_mismatch` locally when its `iss` doesn't reference the
  configured realm (confused-deputy guard), before any management call.
  Added to Go (`ErrCodeRealmMismatch`) and the TS `KNOWN_CODES` set (the TS
  type already had it); added to Java `ErrorCode` for taxonomy parity
  (Java's client-side pin itself is a tracked follow-up).

### Changed

- **Go `sessionManager.checkIssuer`** now emits `realm_mismatch` instead of
  the generic `unauthorized` on a realm-pin failure, matching TS and the
  newly-spec'd taxonomy.
- **SPEC §4.2.1 (token manager) transport wording** corrected: the manager
  rides the handle's platform session, so each `/auth/token` carries the
  **platform bearer** + the refresh in the body (matching the issuer BFF
  gate). The prior "directly on its own refresh token, not handed the
  platform API key" wording was misleading. No code change — implementation
  was already correct.

## Go — verified on-behalf-of via `X-User-Token` (2026-05-31)

`go-v0.16.0`. Additive on the wire. SPEC bumped to **v0.9.0**. **Go-only**
this round — the passthrough (`Realm.Do` / `PassthroughOptions`) is the Go
BFF/proxy escape hatch and the only server-side consumer; browser SDKs never
forward `X-User-Token` (they reach the BFF over `rsid_`), and TS/Java inherit
it through the existing on-behalf parity gap (`sdk/TODO.md`) — no speculative
lockstep.

### Added

- **`PassthroughOptions.OnBehalfOfUserToken`** (ADR-056) — forwards the
  user's verified access JWT as `X-User-Token` **alongside** the platform
  bearer (additive; unlike `UserBearer`, which replaces it). The issuer then
  authorizes a cryptographically verified principal instead of trusting the
  spoofable `X-On-Behalf-Of-User` id. A BFF holding a user JWT SHOULD send
  only the token (omit the bare id): the issuer prefers the token and rejects
  (`x_user_token_invalid`, no downgrade) a present-but-invalid one. Requires
  issuer with the ADR-056 prefer-verified order.
- **`WithUserToken(ctx, accessJWT)`** — idiomatic ctx helper so callers need
  not thread the option through every passthrough call; `Realm.Do` reads it
  when `OnBehalfOfUserToken` is unset. The SDK stores nothing — ctx is
  request-scoped transport; persistence + refresh stay the app's job.

### Note

- The `Version` const skipped `0.15.0`: the 2026-05-28 token-manager round
  below bumped the CHANGELOG to `go-v0.15.0` but left the const at `0.14.0`.
  This release fixes that forward (const → `0.16.0`).

## Java — v0.8.0 parity + ADR-051 migration (2026-05-28)

`java-v0.10.0` closes the lockstep gap left by the Go + TS round below.
The Java SDK now ships the **token manager** (SPEC §4.2.1), the
**`refresh_invalid`** error code (§3.1), and the **api-key DTO**
alignment (§6.5) — matching the Go/TS semantics exactly. As a
prerequisite, Java also completed the **ADR-051 platform-auth
migration**: `PlatformTokenManager` was still bootstrapping via the
removed `POST /auth/platform-token` (hard-cut server-side in v0.7.0); it
now uses the two-endpoint flow (`POST /auth/login
{grant_type:"platform_api_key"}` + `POST /auth/token`), like Go/TS. See
`java/CHANGELOG.md` for the per-symbol detail. Breaking only for callers
that read the prior `apiKeys` `displayName`/`scopes`/`secret` shape.

## Go + TS — token manager + refresh_invalid + api-key DTO (2026-05-28)

Additive on the wire. SPEC bumped to **v0.8.0**. Go + TS bump in
lockstep: `go-v0.15.0`, `ts-v0.13.0`. **Java is intentionally NOT bumped
this round** — it does not yet implement the token manager /
`refresh_invalid` / api-key DTO alignment; Java parity is tracked in
`sdk/TODO.md`.

### Added

- **Token manager** (SPEC §4.2.1) — `realm.auth.NewTokenManager(refresh,
  …)` / `realm.auth.newTokenManager(refresh, …)` for long-lived
  single-identity clients (desktop apps, sync agents, daemons). Caches
  the access token (refreshes ~60s pre-expiry), single-flights concurrent
  acquisitions (one-time-use refresh tokens must never be presented in
  parallel — reuse-detection), and persists the rotated refresh through a
  caller `RefreshSink` **before** returning the new access token
  (crash-safe). `refresh_invalid` is terminal (no API-key fallback).
- **`refresh_invalid` error code** (SPEC §3.1) — `POST /auth/token`
  surfaces a distinct code when the refresh token is expired / revoked /
  reuse-detected, so long-lived clients can branch on "re-auth required"
  vs a transient 401 (previously collapsed to generic `unauthorized`).
  Requires the matching issuer change (issuer ≥ v0.12.0).

### Changed

- **api-key DTO aligned to the issuer (code wins)** — the list/row shape
  is now `{ id, prefix, role, created_at, last_used_at?, revoked_at? }`
  and create returns a one-time `value` + `{ scope, label? }`. Replaces
  the prior incorrect `displayName` / `scopes[]` / string-timestamp shape
  that never matched the wire. **Breaking** for any caller that read those
  fields. `@realm-id/web-admin` gains `apiKeys.{list,create,revoke}`.

## All SDKs — SDK-surface gap fill (2026-05-26)

Additive (non-breaking). Wires three already-shipped issuer
capabilities that previously had no SDK method, so partners can stay
"SDK-only." SPEC bumped to **v0.7.0**. Versions bump in lockstep:
`go-v0.14.0`, `ts-v0.12.0`, `java-v0.9.0`.

### Added

- **Self-service MFA** on the auth surface (SPEC §4.8–4.10): `enrollMfa`,
  `confirmMfa`, `disableMfa` — current-user TOTP enroll/confirm/disable
  over `POST /auth/mfa/enroll`, `POST /auth/mfa/confirm`,
  `DELETE /auth/mfa`. Distinct from the admin-initiated
  `tenants.users.{enrollMfa,confirmMfa,resetMfa}`.
- **Revoke all sessions** (SPEC §4.7): `auth.revokeAllSessions` over
  `DELETE /auth/sessions` — complements the existing list +
  single-session revoke.
- **Identity-provider configuration** (SPEC §6.10):
  `realm.identityProviderConfig.{list,create,update,delete}` — realm-admin
  CRUD over login providers (`/identity-providers`), `platform_id`
  auto-injected. Separate from the read-only `identityProviders(...)`
  discovery surface, which is unchanged.

### Notes

- Go (`identity_provider_config.go`, `mfa_self.go`) and Java
  (`idp` package, `AuthClient`) expose both BFF (`userId` +
  `X-On-Behalf-Of-User`) and legacy (`userBearer`) bearer modes for the
  current-user methods. The TS SDK supports `userBearer` only for these
  (matching its existing `revokeSession`/`listSessions`); BFF parity for
  the TS session/MFA surface is tracked in `TODO.md`.

## All SDKs — v0.11.0 contact model (ADR-042) (2026-05-26)

Aligns the SDKs with the server's v0.11.0 contact model: identifiers
are independently-verified `user_contacts` rows, not user columns.
SPEC bumped to **v0.6.0**. Versions bump in lockstep:
`go-v0.13.0`, `ts-v0.11.0`, `java-v0.8.0`.

### Changed (breaking)

- `invitations.create(tenantId, { identifier, role? })` replaces
  `{ email, role? }`. `identifier` is an email or E.164 phone. Response
  is now `Invitation { id, identifier, role, status, expiresAt }` where
  `id` is the stable user id allocated at invite time. Re-inviting a
  still-pending identifier is idempotent; an active member's identifier
  → `RealmError(already_member)` (409).

### Added

- `users.updateContact(tenantId, userId, { email?, phone? })` — admin
  email/phone change; soft-releases the old contact (30-day slot hold)
  and issues a fresh unverified one. Collision → `identifier_collision`
  (409). `updateStatus` deactivation now documented to cascade
  contact release + verification revoke, guarded by `last_owner` (409).
- `realm.tenants.driftReviews.{list,accept,reject}` (§6.8) — returning-
  login contact-drift queue.
- `realm.tenants.contactVerifications.{list,approve,reject}` (§6.9) —
  first-login step-up gate on recycled identifier slots.

### Docs

- `SPEC.md` §6.2, §6.3 revised; §6.8, §6.9 added; breaking-changes
  preamble for 0.5.x → 0.6.0.

## web-admin-v0.2.0 — contact-model surface (2026-05-26)

`@realm-id/web-admin` repacked against `@realm-id/sdk@0.11.0`. The new
`admin.tenants.driftReviews.*` and `admin.tenants.contactVerifications.*`
clients flow through automatically (web-admin instantiates the SDK's
`TenantsClient` directly); index now re-exports `DriftReview`,
`DriftAcceptResult`, `DriftRejectResult`, `ContactVerification`,
`ContactVerificationResult`. Consumers also pick up the breaking
`invitations.create({ identifier })` change via the bundled SDK.

## All SDKs — partner audit-event feed (ADR-055) (2026-05-25)

**Additive.** Each language SDK gains a new resource for the
partner audit-event feed. Versions bump in lockstep:
`go-v0.12.0`, `ts-v0.10.0`, `java-v0.7.0`.

### Added

- `realm.AuditEvents.List(ctx, ListAuditEventsParams)` (Go) /
  `realm.auditEvents.list(opts?)` (TS) /
  `realm.auditEvents().list(opts)` (Java) — wraps
  `GET /platforms/{id}/audit-events`. The SDK forces the platform id
  from the configured `realmId`, so partners cannot accidentally
  read another platform's events; the server also ignores any
  query-string `platform_id`.
- Filters: `tenantId`, `actorId`, `kind` (repeatable), `since`,
  `until`, `cursor`, `limit` (default 50, max 200). Cursor is
  opaque — forward `next_cursor` verbatim until null.
- New response type `AuditEventsResponse { items: AuditEvent[],
  next_cursor: string | null }`. `AuditEvent` row shape is identical
  to the admin-aggregates surface (§7.5).

### Docs

- `SPEC.md §7.6` added.
- `docs/integration-guide.md §8.6` rewritten — was a workaround +
  roadmap note; now documents the live surface, retention (400 days),
  and the pull-only delivery model. Push (webhooks / event streams)
  remains explicitly out of scope.

## web-v0.3.0 — Request adapters + adopt() (2026-05-09)

**Additive only.** Closes the round-trip on partner-BFF flexibility:

- **`requestAdapters`** — symmetric to v0.2's response adapters. Lets
  partner BFFs receive any wire shape on POST `/login`, `/token`,
  `/switch-tenant`, `/mfa/challenge`, `/mfa/verify`. Without this,
  partners whose BFFs use snake_case (or any non-canonical shape) on
  the *request* side had to fork the SDK; now they pass a small adapter.
- **`realm.adopt({ accessToken, expiresAt, tenantId, user, tenants })`**
  — seed the SDK from an externally persisted session (sessionStorage,
  cookie reflection, SSR handoff) without going through `/login` or
  `/me`. Pairs with the new `realm.peekAccessToken()` getter for
  reading the bearer back out for re-persistence.
- **`@realm-id/web-bff-realmid@0.2.0`** ships matching request adapters
  for the reference BFF (`providerToken→token`, `tenantId→tenant_id`,
  `challengeToken→mfa_challenge_token`, body-less `/token`).
- **`TenantRef.mfaRequired?: boolean`** added (additive). Partners that
  surface a per-tenant MFA policy can populate it through the login or
  /me adapter.

Sibling packages (`@realm-id/web-react`, `-firebase`, `-google`) bumped
to 0.3.0 in lockstep; their public surface is unchanged.

## web-v0.2.0 — Partner-flexible adapters, gates, tokenless refresh (2026-05-09)

**Additive only.** No wire-shape changes; existing v0.1 BFF integrations
keep working. Adds the missing primitives that prevented partner BFFs
(including the realmid.dev reference BFF) from being used as drop-in targets:

- **Response adapters** (`createRealm({ adapters })`) — pluggable
  normalisers for `/login`, `/me`, `/token`, `/providers`. Lets BFFs ship
  any wire shape (snake_case, envelope-wrapped, flat `/me`, status
  discriminator) and have the SDK translate to the canonical shape.
- **Error gates** (`createRealm({ gates })`) — match HTTP status + body
  `code` to surface canonical `RealmError` codes (`mfa_required`,
  `mfa_registration_required`, `session_limit_reached`, `tenants_required`).
  Gate-specific payloads are exposed via `extract`.
- **Tokenless `/token` rotation** (`refresh: { tokenless: true }`) —
  `/token` returns `{ expiresAt }` only; SDK keeps using the existing
  opaque bearer with an advanced expiry.
- **`refresh.sendBearer`** — optionally attach `Authorization` to `/token`
  for BFFs that authenticate refresh with the current session bearer.
- **CSRF header injection** (`csrf: { headerName, cookieName | tokenProvider }`)
  on POST/PUT/PATCH/DELETE.
- **`switchTenant` fallback** — set `endpoints.switchTenant: null` and
  the SDK falls back to a `/login` second pass with `{ tenantId }`.
- **`expiresIn`/`expiresAt` reciprocal derivation** — partners can ship
  either; the SDK schedules refresh from whichever is present.
- **`AuthState.status: "error"`** — distinguishes a network/5xx failure
  during `/me` restore from a clean anonymous state.
- **`tenants_required` success-body gate** — surfaces a typed error and
  populates `state.pendingTenants` for the caller's tenant picker.
- **Open `LoginMethod` and provider strings** — partners can use
  `apple`, `magic_link`, etc. without forking the SDK.
- **New companion package `@realm-id/web-bff-realmid`** — bundles the
  adapters, gates, endpoints, and refresh flags needed to drop the SDK
  in front of the realmid.dev reference BFF (`api.realmid.dev`) in one import.
- **BFF-SPEC.md** rewritten around the canonical+adapter model.

Sibling packages (`@realm-id/web-react`, `@realm-id/web-firebase`,
`@realm-id/web-google`) bumped to 0.2.0 in lockstep; their public surface
is unchanged.

## go-v0.11.0 — Error + session helpers, typed IdentityProviders (2026-05-24)

**Additive only.** Promotes three pieces of duplication that BFF /
partner consumers were reinventing into the SDK surface:

- **Error helpers** (`errors.go`): `IsUnauthorized(err)`,
  `IsTimeout(err)`, `AsRealmError(err, &re)`, `HTTPStatus(err)`. Every
  consumer mapping an SDK error onto its own HTTP/UI surface was
  unwrapping `*RealmError` by hand; these collapse that to a single
  call. `IsTimeout` is `errors.Is`-based so it sees through wrapped
  `*RealmError{Cause: ctx.Err()}` rather than string-matching.
- **`Session.NeedsTenantChoice()` + `Session.SelectTenant(preferred)`**
  (`auth.go`): the two arithmetic pieces every server-side login flow
  re-implements — "did the issuer return a picker?" and "resolve final
  (tenant_id, role) given a caller preference". Pure functions on the
  existing `*Session`, no new state.
- **`Realm.IdentityProviders(ctx, *IdentityProvidersOptions)`**
  (`identity_providers.go`): typed wrapper over
  `GET /platforms/{realm_id}/identity-providers` with optional
  `Platform`, `TenantID`, `Origin`. Returns
  `*IdentityProvidersResponse`. Removes ~25 lines of
  `r.Do` + ReadAll + Unmarshal boilerplate from every consumer that
  populates a SPA login picker.

No SPEC change; no wire-shape change; existing call sites keep
working unchanged. TS / Java SDK lockstep additions are tracked
separately — bump those when a consumer needs them.

## go-v0.10.0 / ts-v0.9.0 — Two-endpoint auth surface (ADR-051) (2026-05-08)

**BREAKING.** Tracks api `v0.7.0`. The legacy
`POST /auth/service-token` and `POST /auth/platform-token` endpoints
are gone (server-side, hard cut, no aliases). The SDK now drives the
two-endpoint flow:

```text
POST /auth/login   {grant_type, ...} → refresh + (resolved) access
POST /auth/token   refresh-bearer    → rotated refresh + access
```

Authoritative reference:
- `api/docs/adr/051-two-endpoint-auth-surface.md`
- `api/docs/proposals/two-endpoint-auth-surface.md`

SPEC.md §4.0, §4.1, §4.2 rewritten to match.

### Changed — Go (`v0.10.0`)

- `internal: platformTokenManager` renamed to `sessionManager`.
  Public surface unchanged: every `realm.platformToken.get(ctx)`
  call site keeps returning the platform access token.
- `sessionManager` now holds **both** an access token and a refresh
  token. First call hits `POST /auth/login {grant_type:
  "platform_api_key", api_key}`; near-expiry calls hit `POST
  /auth/token` with the refresh token as the Authorization Bearer.
  401 on `/auth/token` falls back transparently to a fresh
  `/auth/login`.
- Refresh-token rotation gated by the realm's
  `platform_refresh_rotates` config (default off, non-rotating;
  the response's `refresh_token` will equal what was sent).
- Removed `platformTokenResponse`; introduced `loginResponse` matching
  the new wire shape (`subject_type`, `refresh_token`,
  `access_token`, `expires_in`).

### Changed — TS (`0.9.0`)

- `PlatformTokenManager` (kept the class name + `getToken()` surface
  for source compatibility) reimplemented against the two-endpoint
  flow. Same fallback semantics as Go.
- `invalidate()` now clears only the access token; the cached refresh
  token is preserved so the next `getToken()` can attempt
  `/auth/token` before a full re-login.

### Removed

- All references to `POST /auth/service-token` and
  `POST /auth/platform-token` in source, tests, and SPEC.md.

### Migration

Bump the SDK to `go-v0.10.0` / `ts-v0.9.0` whenever you bump the API
to `v0.7.0`. No partner code changes required — call surface (`auth.login`,
`auth.token`, `tenants.*`, etc.) is unchanged.

## go-v0.9.0 / ts-v0.8.0 — Partner OTP primitive + `mfa_challenge_token` wire fix (2026-05-08)

Tracks api `v0.6.0`. Both SDKs ship the partner OTP primitive
(issue / view / verify) and two login integrations
(`auth.otpLogin` single-factor, `auth.mfaVerifyOtp` second-factor),
plus a wire-shape fix on `/auth/mfa/verify`. SPEC.md gains §X (OTP
primitive). Authoritative reference:
`api/docs/proposals/partner-otp-primitive.md`.

> Versioning note: the previous Go SDK release was `0.8.2`. Bumping
> Go to `0.9.0` (not `0.8.0`) since 0.8.x is already in flight.
> TS jumps from `0.6.0` to `0.8.0` to keep the lockstep numbering
> aligned with Go on the OTP cut.

### Added — Go (`v0.9.0`)

- `realm.OTP.Issue(ctx, tenantID, OTPIssueRequest{SubjectRef, Purpose})` →
  `OTPIssueResponse{ID, Value, ExpiresAt, Purpose, SubjectRef}`.
- `realm.OTP.View(ctx, tenantID, otpID)` →
  `OTPViewResponse{..., IssuerUserID}`.
- `realm.OTP.Verify(ctx, OTPVerifyRequest{TenantID, SubjectRef, Purpose, Presented})` →
  `OTPVerifyResponse{OTPID, IssuerUserID, IssuedAt, SubjectRef, Purpose}`.
- `Auth.OTPLogin(ctx, OTPLoginRequest{RealmID, Identifier, Presented})` —
  wraps `POST /auth/login` with `method=otp_internal`. Realm gate:
  `otp_login_enabled`.
- `Auth.MFAVerifyOTP(ctx, MFAVerifyOTPRequest{MFAToken, Presented})` —
  wraps `POST /auth/mfa/verify` with `method=otp_internal`. Realm
  gate: `otp_mfa_enabled` + per-user/per-role enrollment.

### Added — TS (`0.8.0`)

- `realm.otp.issue({ subjectRef, purpose })`,
  `realm.otp.view(otpId)`,
  `realm.otp.verify({ subjectRef, purpose, presented })`.
- `realm.auth.otpLogin({ realmId, identifier, presented })`.
- `realm.auth.mfaVerifyOtp({ mfaToken, presented })`.

### Fixed — both SDKs (`mfa_challenge_token` wire shape)

`Auth.MFAVerify` (Go) and `auth.mfaVerify` (TS) previously sent the
challenge token under JSON key `challenge_token`, but the API's
`mfaVerifyReq` JSON tag is `mfa_challenge_token` — every MFA verify
broke at the wire. Pre-existing bug; surfaced when Phase 4b's
`MFAVerifyOTP` path inherited it. Both SDKs now serialise the body
key as `mfa_challenge_token`. The TS Connect-style middleware's
inbound body parser (`handleMfaVerify`) accepts both
`mfa_challenge_token` (canonical) and `challenge_token` (legacy)
keys from partner UI code so existing partner integrations don't
regress while they update.

### SPEC

- Adds `§X OTP primitive` with full surface + worked examples.
- Updates `§4.1 login()` and `§4.3 mfaVerify()` to mention
  `otp_internal` and the new typed helpers.
- Calls out the corrected `mfa_challenge_token` wire-shape on §4.3.

## Unreleased — Admin aggregates surface (all SDKs)

Admin aggregates surface (ADR-048, SPEC §7.5) shipped on all three
SDKs: `realm.admin.{listPlatforms, stats, listEvents, search}`. Wraps
the base-realm-staff-only `GET /admin/platforms`, `/admin/stats`,
`/admin/events`, `/admin/search` endpoints. The SDKs do not gate
locally; the server's `403 forbidden` envelope is surfaced as the
standard `RealmError(forbidden)` / `RealmException(FORBIDDEN)`.

## 0.8.2 — PassthroughOptions.UserBearer (Go) (2026-05-02)

Adds `UserBearer` to `PassthroughOptions`. When set, replaces the
default platform-token bearer with the supplied bearer (typically a
user JWT or a one-shot revocation_token). The platform token is
still minted (cache stays warm, mint-errors surface), but the wire
bearer is the user's. Required for the BFF's session-limit-modal
flow where the auth server validates a one-shot revocation_token.

## 0.8.1 — LoginRequest.TenantID (Go) (2026-05-02)

`LoginRequest` now carries an optional `TenantID`. When set, the SDK
forwards `tenant_id` on the `/auth/login` body so the auth server can
mint a tenant-scoped session in one round-trip. When empty and the
user has >1 tenants, the auth server's existing tenant-picker
response (no tokens, just `tenants[]`) is preserved.

## 0.8.0 — Realm.Do passthrough (Go) (2026-05-02)

Adds a public escape hatch for BFF / proxy consumers that need to
forward arbitrary admin-API calls without re-implementing the
dual-token dance:

- **`Realm.Do(ctx, method, path, body, *PassthroughOptions)`** — issues
  an authenticated request and returns the raw `*http.Response`. The
  platform token is minted (and cached) behind the scenes; the caller
  closes `resp.Body`.
- **`PassthroughOptions`** carries `OnBehalfOfUser`
  (→ `X-On-Behalf-Of-User`), `OnBehalfOfIP` (→ `X-On-Behalf-Of-IP`),
  and a free-form `http.Header` for forwarding things like
  `Idempotency-Key` or `Content-Type`. `Authorization` is always
  overwritten with the platform-token bearer.

Typed methods (`Tenants`, `Roles`, `Origins`, …) remain the
recommended surface for application code; `Do` exists for the BFF at
`api.realmid.dev` and for partner backends doing protocol-level
gateway work.

## 0.7.0 — BFF alignment fixes (Go) (2026-05-02)

Alignment fixes surfaced while standing up the `api.realmid.dev` BFF
(ADR-050). Wire-compatible for callers using the typed request structs;
only direct `map[string]any` consumers of the body JSON would notice
the field rename.

- **Login wire shape (Go)** — `Auth.Login` body field renamed
  `provider_token` → `token` to match `api/internal/httpapi/auth.go`
  (`loginReq.Token`). Pre-existing SDK/api drift; was failing every
  Login at the dev provider in BFF mode. The Go-side `LoginRequest`
  struct field stays `ProviderToken`.
- **Tenant ID JSON tag (Go)** — `TenantRef.ID` now decodes from
  `tenant_id` (matches `authsvc.TenantMembership.TenantID`); legacy
  `id` accepted via fallback for older mocked issuers / tests.
- **Session shape (Go)** — added top-level `TenantID` and `Role`
  (the api's login response carries them flat alongside `Tenants[]`).
  `User.ID/Email/DisplayName` now backfilled from the access JWT's
  `sub/email/name` claims when the wire response omits the `user`
  object (it does today — see `api/internal/httpapi/auth.go.loginResp`).
- **New helper (Go, private)** — `peekJWTUserFields` decodes JWT
  user claims for the backfill above.
- **`Auth.ListSessions` + `Auth.RevokeSession` — request structs +
  on-behalf-of (Go, breaking)**. Both now take `ListSessionsRequest` /
  `RevokeSessionRequest`. Two mutually-exclusive auth modes:
  - `UserID` → SDK attaches the cached platform token as bearer and
    `X-On-Behalf-Of-User: <UserID>`. Required when the realm has
    `config.require_bff_login=true` (ADR-041 §7) — the user's own JWT
    won't pass the BFF gate against base realm once that flips on.
  - `UserBearer` → that JWT rides as `Authorization: Bearer` (legacy /
    public-client realms; subject read from the JWT).
  Optional `OnBehalfOfIP` rides as `X-On-Behalf-Of-IP` so the issuer's
  per-IP rate limits attribute to the SPA's IP, not the BFF's egress
  (ADR-050 plan §8.2). Old signatures `(ctx, sessionID, userBearer)` /
  `(ctx, userBearer)` are gone — there are no in-tree callers.
- **`Auth.MintMFAChallenge` — request struct (Go, breaking)**. Now
  takes `MFAChallengeRequest{AccessToken, OnBehalfOfIP}`. The SDK's
  own MFA middleware was migrated in the same change.
- **`MFAVerifyRequest.OnBehalfOfIP` (Go)** — new optional field
  forwards SPA IP via `X-On-Behalf-Of-IP` for the same rate-limit
  reason.

TS + Java are not affected by this set; they don't have a Server-mode
consumer landed yet.



## 0.5.0 — platforms-namespace cut + signup_mode enum (2026-04-29)

Cross-cutting **breaking** bump aligning with RealmID v0.5.0
(ADR-044 + ADR-045). All three SDKs (`ts/`, `go/`, `java/`) bumped in
lockstep. Early adopters are on 0.4.0; partners on 0.4.x must upgrade
when they cut over to a v0.5.0 server.

### Breaking — admin sub-paths moved to `/platforms/{id}/...` (ADR-044)

Every realm-admin sub-path was renamed:

| Old wire path | New wire path |
|---|---|
| `POST /realms/{id}/api-keys` | `POST /platforms/{id}/api-keys` |
| `GET /realms/{id}/api-keys` | `GET /platforms/{id}/api-keys` |
| `DELETE /realms/{id}/api-keys/{keyId}` | `DELETE /platforms/{id}/api-keys/{keyId}` |
| `PATCH /realms/{id}/config` | `PATCH /platforms/{id}/config` |
| `GET /realms/{id}/roles` | `GET /platforms/{id}/roles` |
| `POST /realms/{id}/roles` | `POST /platforms/{id}/roles` |
| `PATCH /realms/{id}/roles/{name}` | `PATCH /platforms/{id}/roles/{roleId}` |
| `DELETE /realms/{id}/roles/{name}` | `DELETE /platforms/{id}/roles/{roleId}` |
| `POST /realms/{id}/roles/{name}/rename` | `POST /platforms/{id}/roles/{roleId}/rename` |

The high-level SDK surface (`realm.apiKeys.*`, `realm.config.update`,
`realm.roles.*`, etc.) is unchanged — only the wire path constants
inside the SDKs moved. Partners who use the SDK methods don't need to
touch their code; partners who hand-rolled HTTP calls must update.

OIDC discovery URLs (`/realms/{realm}/.well-known/jwks.json` and
`/realms/{realm}/.well-known/openid-configuration`) **stay** on the
`/realms/...` namespace. They are the realm-as-issuer surface. Verifier
behavior is unchanged.

There is no dual-mount window. v0.5.0 is a clean cut; old paths are
404. See ADR-044 for the rationale.

### Breaking — `signup_mode` enum replaces `open_signup` bool (ADR-045)

`TenantConfig` and `TenantCreate` no longer carry an `open_signup`
boolean. They carry `signup_mode: "closed" | "allowlist" | "open"`
instead.

- `closed` (default) — invitation-only; `allowed_domains` ignored.
- `allowlist` — auto-provision when the verified email domain is in
  `allowed_domains`. List must be non-empty.
- `open` — auto-provision every authenticated user. Reserved for the
  base admin tenant; partner tenants cannot set this mode (server
  rejects with `signup_mode_invalid_for_tenant`).

Migration on existing data is automatic on the server side
(see ADR-045 §"Migration from today's model"). For SDK callers:

- TS: `tenants.create({ ..., openSignup: true })` →
  `tenants.create({ ..., signupMode: "allowlist" })`.
- Go: `TenantCreate{ ..., OpenSignup: true }` →
  `TenantCreate{ ..., SignupMode: SignupModeAllowlist }`.
- Java: `TenantCreate` is config-blob shaped; pass
  `Map.of("signup_mode", "allowlist", ...)` instead of
  `"open_signup", true`.

There is no compatibility shim — sending `open_signup` to a v0.5.0
server is a `bad_request` and the SDKs no longer encode that field.

### What changes in your SDK code

If you call `realm.apiKeys.*`, `realm.config.update`, `realm.roles.*`,
or pass `tenants.create` with the basic fields covered above: nothing
beyond bumping the dependency.

If you talked to the server directly without the SDK, see the table
and the `signup_mode` section above.

### Compatibility

- SDK 0.5.0 talks to RealmID v0.5.0+ realms.
- SDK 0.5.0 against pre-v0.5.0 realms: admin sub-paths 404 (the
  server still has `/realms/{id}/...`); do not mix.
- SDK 0.4.0 against v0.5.0 realms: admin sub-paths 404, `open_signup`
  on tenant create is rejected. Upgrade to 0.5.0 in lockstep with
  the server.

## 0.4.0 — BFF login enforcement (2026-04-27)

Cross-cutting bump aligning with RealmID v0.4.0 (ADR-041).

### What changed on the wire

RealmID v0.4.0 ships a per-realm flag `realms.config.require_bff_login`.
When true, every `/auth/*` call against the realm MUST carry an
`Authorization: Bearer <platform_token>` minted from an API key bound
to a `platform_api`/`owner` user in the realm's admin tenant. Direct
browser → RealmID `/auth/login` is rejected with `bff_bearer_required`.

### What changes in your SDK code

Nothing. Both `@realm-id/sdk` (TS) and `realmid-go` already attach the
platform token to every `/auth/*` call as Bearer — that's been the
SDK's wire shape since the dual-token surface locked. The 0.4.0 bump
is the version compatible with the server side that enforces it.

### Compatibility

- SDK 0.4.0 talks to RealmID v0.4.0+ realms (BFF or non-BFF).
- SDK 0.4.0 talks to pre-v0.4.0 realms unchanged (those realms ignore
  the bearer; the gate isn't enforced server-side).
- SDK 0.3.0 talks to v0.4.0 BFF realms — the platform token attach is
  already there; no behavioural difference.

### Also in 0.4.0 (rolled forward from the planned 0.4.1)

Pre-public release; no point shipping the gate without the surrounding
hardening that makes BFF mode usable end-to-end.

- **Client-side platform-token realm pinning.** Both Go and TS decode
  the JWT minted from `/auth/platform-token` and verify its `iss`
  claim references the configured `realmId`. Mismatch throws
  `realm_mismatch` (TS) / `unauthorized` (Go) locally before any
  subsequent API call goes out — catches confused-deputy bugs (SDK
  constructed for realm A but key actually belongs to realm B) at the
  source instead of as cryptic 4xx on first partner call.

- **Optional shared revocation cache.** Pluggable `RevocationCache`
  interface; ships with `MemRevocationCache` (in-process LRU) for
  single-replica partners. Multi-replica partners implement the
  interface against Redis/memcached/etc. The verifier checks the
  cache after signature + claim checks; cache hit on the JWT's `jti`
  → reject as `unauthorized`/`token revoked`. `auth.logout()` learns
  to push the access token's jti when `accessToken` is supplied in
  the request. Bridges the gap between user logout and the access
  token's stateless natural expiry. OPT-IN: nil cache → no-op,
  unchanged behaviour.

  ```ts
  import { createRealm, MemRevocationCache } from "@realm-id/sdk";

  const realm = createRealm({
    realmId, apiKey,
    revocation: new MemRevocationCache(),
  });

  await realm.auth.logout({ refreshToken, accessToken });
  // Subsequent realm.verify(accessToken) → throws "unauthorized"
  ```

  ```go
  realm, _ := realmid.NewRealm(realmid.Config{
      RealmID: realmID, APIKey: apiKey,
      Revocation: realmid.NewMemRevocationCache(nil),
  })

  realm.Auth.Logout(ctx, &realmid.LogoutRequest{
      RefreshToken: refreshToken,
      AccessToken:  accessToken,
  })
  // Subsequent realm.Verify(ctx, accessToken, nil) → ErrCodeUnauthorized
  ```

- **Dual-token (`Authorization` + `X-User-Token`) for `/auth/sessions/*`
  and `/auth/mfa/*`.** Server-side change shipped in RealmID v0.4.0;
  the SDK already attaches both headers on the user-on-self call
  helpers (no SDK API change). Partner can no longer impersonate
  arbitrary users — they have to actually possess the user's access
  JWT to make a call on their behalf.

### Compatibility

- SDK 0.4.0 ↔ RealmID v0.4.0+: full feature surface.
- SDK 0.4.0 ↔ pre-v0.4.0 RealmID: bearer attach is a no-op server-side;
  revocation cache is purely client-side, also works.
- SDK 0.3.0 ↔ RealmID v0.4.0 BFF realm: works for everything except
  `/auth/sessions/*` and `/auth/mfa/*` on partner-brokered calls
  (those need the X-User-Token header which 0.3.0 doesn't send).


## Unreleased — locked surface (2026-04-26)

The cross-language SDK contract was finalized in
[`SPEC.md`](./SPEC.md). All three SDKs are being aligned to the
locked surface; the next published versions of `ts/`, `go/`, and
`java/` will all match it.

### Major surface decisions

- **`apiKey` is required.** Verifier-only callers can still use the
  low-level `createVerifier` (or `Verifier.builder()`) primitive, but
  the integrated `createRealm` handle now requires the API key as a
  first-class input.
- **Dual-token login.** The SDK exchanges the API key for a
  short-lived platform JWT via `POST /auth/platform-token`, then sends
  the platform JWT (not the API key) on every subsequent call —
  including `/auth/login`. The raw key is sent on exactly one mint
  call. See [`docs/dual-token.md`](./docs/dual-token.md).
- **Custom claims move from refresh to access tokens.** `auth.login`
  no longer accepts `customClaims`. `auth.token` (the access-token
  mint endpoint) accepts a `customClaims` map, gated by a per-realm
  server-side allowlist.
- **`realm.platforms.*` removed.** Partners have one platform per
  realm; cross-platform admin is a RealmID-ops concern that lives in
  a separate `realmid-admin` CLI.
- **`realm.realm.*` flattened.** `info()`, `apiKeys.*`, and
  `config.update` are now top-level on the handle.
- **Paginated wire shape locked** to `{ items, next_cursor, total? }`.
  SDKs reject any other shape with a `RealmError(server_error)`.
- **Origin auto-attached** on every auth call, derived from the
  realm's claimed domain via `realm.info()`. Per-call and per-handle
  override.
- **Logger interface** replaces the earlier debug callback. TS uses a
  4-method `Logger` interface; Go uses `*slog.Logger`; Java uses
  `java.lang.System.Logger`. Raw credentials are never logged — only
  the first 6 chars of any bearer credential appear.
- **Middleware adds `tokenDelivery`** (`"cookie"` | `"body"`) and
  `mfaProtectedPaths`. Cookie mode is the SPA default; body mode
  serves mobile clients. MFA-protected paths surface a 412 envelope
  matching the login flow when a verified-but-non-MFA token hits one
  of them.

### New cross-language surface

The handle now exposes:

- `realm.verify(token, opts?)`
- `realm.auth.{login, token, mfaVerify, logout, revokeSession, listSessions}`
- `realm.tenants.{list, get, create, update, updateConfig, delete, transferOwner}`
- `realm.tenants.invitations.{list, create, delete}`
- `realm.tenants.users.{list, get, updateStatus, enrollMfa, confirmMfa, resetMfa}`
- `realm.domains.{claim, verify}`
- `realm.info()` (cached)
- `realm.apiKeys.{create, list, revoke}`
- `realm.config.update(patch)`
- `realm.middleware(opts)` — Connect-style (TS), `http.Handler`
  middleware (Go), or `jakarta.servlet.Filter` (Java)

### Server changes driven by this redesign

Tracked in the auth-monorepo TODO under "Server changes driven by SDK
SPEC.md (2026-04-26)":

- `POST /auth/platform-token` (new; mints the short-lived platform
  JWT used for dual-token login)
- Drop `customClaims` from `POST /auth/login` (with a `Deprecation:`
  + `Sunset:` header for one release)
- Accept `customClaims` on `POST /auth/token` (per-realm allowlist
  via `realms.config.access_token_custom_claim_keys`)
- 412 `mfa_required` envelope on MFA-protected resources (today
  emitted only on login)
- Standardize paginated list responses to
  `{ items, next_cursor, total? }`
- `GET /realms/{id}/api-keys` + `DELETE /realms/{id}/api-keys/{kid}`
- Self-MFA endpoints (`POST /auth/mfa/{enroll,confirm}`,
  `DELETE /auth/mfa`) for the bearer user (today only the admin
  surface exists)
- `PATCH /realms/{id}/config` allowlist documented in `swagger.yaml`

### Roadmap (deferred)

CSRF middleware layer, webhooks, service-to-service tokens, OIDC
discovery, impersonation, WebAuthn / passkeys, custom domains for
hosted UIs, bulk user import, idempotency-key pass-through.

## ts-v0.1.0 (initial public release, 2026-04-25)

First public TypeScript SDK as a verifier-only surface
(`createVerifier({ baseUrl, audience })`). Web Crypto + JWKS fetch,
runs in Node ≥ 20, Deno, Bun, Cloudflare Workers, modern browsers.
Superseded by the locked surface above.

## go-v0.1.0 (initial public release, 2026-04-25)

First public Go SDK as a verifier-only surface. Stdlib only.
(This release exposed a standalone `realmid.NewVerifier(...)` factory;
it was later folded into the unified handle — verification is now
`realmid.NewRealm(...)` + `realm.Verify(ctx, token, opts)`, with no
exported `NewVerifier`.) Superseded by the locked surface above.

## java-v0.1.0 (initial public release, 2026-04-25)

First public Java SDK as a verifier-only surface
(`Verifier.create(Config.builder()...build())`). Java 17+, single
Jackson dependency. Superseded by the locked surface above.
