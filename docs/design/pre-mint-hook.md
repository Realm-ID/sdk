# Design — the post-identity, pre-derived-claims hook (`OnIdentityResolved`)

**Status:** DESIGN, awaiting owner sign-off on the open questions in §11.
**Scope:** `sdk/go`, `sdk/ts`, `sdk/java`. Build approved by the owner
2026-09-05; nothing below re-opens *whether* to build it.
**Author's evidence basis:** every code fact below carries a `path:line`
citation and was read in this pass. Claims I could not check are labelled
INFERRED or NOT VERIFIED, inline. Nothing in `sdk/TODO.md`'s partner-ask entry
is re-affirmed here without an independent read.

---

## 1. Controlling documents, and which one wins where

| Document | Says | Controls |
|---|---|---|
| `sdk/SPEC.md` | "SPEC.md is law — if a language SDK and the SPEC disagree, fix the SDK" (`sdk/TODO.md:71`) | the cross-language *contract* |
| root `CLAUDE.md` | "When prose and code disagree, **code wins** — update the doc" | *descriptions of what exists* |
| `sdk/DECISIONS.md`, `issuer/DECISIONS.md` | prior rulings | anything already ruled |

**These two collide on this exact surface, and it is a finding, not a detail.**
`SPEC.md:582-593` (§4.1.2) specifies the `productRoles` handler as "Go a
functional option alongside `WithRefreshSink`, TS a field on
`TokenManagerOptions` alongside `refreshSink`, Java a `Realm.Builder` method."

The code did none of that in Go or TS:

- Go: `Config.ProductRoles` / `Config.Scopes` are **struct fields on `Config`**
  (`go/realmid.go:117`, `go/realmid.go:130`), with an explicit written
  rationale for departing from the SPEC (`go/realmid.go:112-116`: *"A CONFIG
  FIELD, not a functional option, and that is a deliberate reading of ADR-102
  D3 … the precedent that matters is the one for a REALM-level hook"*).
- TS: `RealmConfig.productRoles` / `RealmConfig.scopes` (`ts/src/realm.ts:129`,
  `ts/src/realm.ts:147`), not `TokenManagerOptions`.
- Java: `Realm.Builder.productRoles(...)` / `.scopes(...)`
  (`java/.../Realm.java:493`, `:512`) — the only one of the three that matches
  the SPEC.

So the SPEC is **drifted** on the wiring of realm-level handlers. This spec
follows the CODE precedent (a realm-level config surface), because the code's
rationale is written down and correct, and registers the SPEC correction as
**OQ-5**. A builder must not "fix the SDK to match the SPEC" here.

---

## 2. The problem, restated against the code

Traide consumes `sdk/go`. They resolve their authorization claim in
`Config.Scopes` by reading their own local `users` row; that row is written by
their reconciler inside `MiddlewareOptions.OnAuthSuccess`
(`go/middleware.go:186`). On a first login the resolver runs before the
reconciler, so it resolves against a row that does not exist and the token is
minted scope-less. They repair it with an extra `/auth/token` round trip after
the reconciler, on every login, permanently.

They cannot move the seeding into `Resolve`, because side-effect freedom is a
stated contract (`go/scopes_handler.go:28-33`) backed by a real retry loop —
`productRolesAttempts = 3` with `{50ms, 150ms}` backoff
(`go/product_roles.go:74,76`), reused verbatim by `resolveScopes`
(`go/scopes_handler.go:89-119`). Their write would run up to three times per
mint. **Their constraint is real and verified.**

### 2.1 Their framing is wrong in one load-bearing way, and the spec must say so

They asked for a hook "before the first mint". **On the login lane there is no
such point.** The first mint *is* `POST /auth/login`
(`go/auth.go:519-534`), and identity and tenant are only known *from its
response* (`go/auth.go:546-556` backfills `User.ID` from the access token's
`sub`; `settledTenant` at `go/auth.go:570` reads the tenant off the same
response). "After identity is known" and "before the first mint" are mutually
exclusive on that lane.

What actually exists — and what closes their problem — is the seam **before the
DERIVED-CLAIMS mint**: `Auth.Login` calls `/auth/login`, then calls
`mintProductRoles` (`go/auth.go:561`), which resolves `product_roles` and
`scope` (`go/auth.go:647`, `:658`) and re-mints through `/auth/token`
(`go/auth.go:662-669`). The hook belongs immediately before those two
resolvers. That placement gives the partner exactly what they need — their row
exists before `Config.Scopes` reads it — while making a claim we can keep.

**Consequence for naming and for the guarantee wording: this is not a
"pre-mint" hook and must not be called one.** See §6 and §4.

---

## 3. Where the seam lives

### 3.1 The one insertion point per language

| Language | Function | Insertion point |
|---|---|---|
| go | `(*AuthClient).mintProductRoles` (`go/auth.go:643`) | first statement of the body, **above** the existing short-circuit at `go/auth.go:644-646` |
| ts | `AuthClient.mintProductRoles` (`ts/src/auth.ts:714`) | first statement, above the short-circuit at `ts/src/auth.ts:719` |
| java | `AuthClient.mintProductRoles` (`java/.../AuthClient.java:228`) | first statement, above the short-circuit at `java/.../AuthClient.java:231-234` |

and, for the refresh lane (§4.3):

| Language | Function | Insertion point |
|---|---|---|
| go | `(*Realm).enrichRefreshMint` (`go/derived_claims_refresh.go:50`) | after the subject peek (`go/derived_claims_refresh.go:69`), before `resolveProductRoles` (`:78`) |
| ts | `enrichRefreshMint` (`ts/src/derived-claims-refresh.ts:78`) | after `peekJwtSubject` (`ts/src/derived-claims-refresh.ts:93`), before `resolveProductRoles` (`:104`) |
| java | `AuthClient.enrichRefreshMint` (`java/.../AuthClient.java:308`) | after `JwtPeek.subject` (`java/.../AuthClient.java:~325`), before `ProductRoles.resolve` |

### 3.2 Why this seam satisfies "direct-client, not only middleware"

`mintProductRoles` is reached from **every** session-producing lane in all
three SDKs, and none of those calls come from the middleware:

- go: `Login` (`go/auth.go:561`), `CompleteLogin` (`go/auth.go:622`),
  `OTPLogin` (`go/auth.go:833`), `PasswordLogin` (`go/auth.go:947`),
  `MFAVerify` (`go/auth.go:1023`), with `MFAVerifyOTP` (`go/auth.go:959`)
  delegating to `MFAVerify`.
- ts: `login` (`ts/src/auth.ts:640`), `completeLogin` (`:695`), `otpLogin`
  (`:853`), `passwordLogin` (`:908`), `mfaVerify` (`:951`).
- java: `login` (`java/.../AuthClient.java:132`), `completeLogin` (`:192`),
  `mfaVerify` (`:420`), `otpLogin` (`:451`), `passwordLogin` (`:494`).

The handler is therefore configured on the **realm**, alongside `ProductRoles`
and `Scopes` — **not** on `MiddlewareOptions`. A direct-client caller who never
touches the middleware gets it; a middleware caller gets it through the same
code path. **No middleware file changes in any language.** That is the whole
reason this seam was chosen over extending `OnAuthSuccess`.

### 3.3 Java-specific trap the builder must not miss

`Realm.withUserToken` builds a derived `Realm` by copying fields
(`java/.../Realm.java:184-185`, re-wiring `AuthClient` at `:194`). The existing
doc comment on `productRoles` says exactly why this matters
(`java/.../Realm.java:55-59`): *"a withUserToken copy that dropped it would
silently stop minting the claim on exactly the BFF lane the claim exists for."*
The new handler must be copied in **both** constructors
(`java/.../Realm.java:107-108` and `:184-185`) and passed to **both**
`AuthClient` constructions (`:144` and `:194`).

TS is safe by construction — `withUserToken` re-enters `build(...)`
(`ts/src/realm.ts:381`), which re-reads `cfg` (`ts/src/realm.ts:354`). Go has
no derived-`Realm` copy at all (`WithUserToken` is a context helper,
`go/passthrough.go:67`).

---

## 4. The guarantee — stated so that it is checkable

> **`OnIdentityResolved` fires exactly once per derived-claims resolution,
> immediately before `ProductRoles` and `Scopes` are resolved, on every lane
> where they are resolved — and nowhere else.**

Not "once per authentication". We cannot keep that promise (see §4.2, §4.3),
and a guarantee that is vacuous on some lanes must say so rather than imply
coverage it lacks.

### 4.1 Login lanes — fires once each

`Login`, `OTPLogin`, `PasswordLogin`, `MFAVerify`, `MFAVerifyOTP`. Each reaches
`mintProductRoles` exactly once (citations in §3.2). `MFAVerifyOTP` delegates
to `MFAVerify` and therefore fires once, not twice — verified at
`go/auth.go:959-967`.

### 4.2 Multi-tenant login and tenant choice — fires per *(authentication,
tenant)*, not per authentication

On a multi-tenant login `settledTenant` returns empty (`go/auth.go:570-587`,
`ts/src/auth.ts:637`, `java/.../AuthClient.java:195-207`), so
`mintProductRoles` is **not** called and the hook does **not** fire. It fires
at `CompleteLogin` (`go/auth.go:622`), for the tenant the app chose.

A later tenant **switch** through `CompleteLogin` on an already-minted session
fires it **again**, for the new tenant. This is correct, not a leak: the mirror
is per-tenant, the hook's contract is "(tenant, user) is settled", and the
partner's row for the second tenant may not exist either. **Say this in the
doc comment**; a partner counting on "once per login" would otherwise call it a
bug.

### 4.3 Refresh — PROVISIONAL: fires (see OQ-1)

This is the one place where the partner's ask and the codebase's own history
point in opposite directions, and it is registered as **OQ-1**. The body below
is written to the recommended answer.

**All three middlewares REQUIRE `tenant_id` on the refresh route** —
`go/middleware.go:543-551` (`400 tenant_required`),
`ts/src/middleware.ts:276-278`, `java/.../RealmFilter.java` (same shape,
`tenantId` threaded into `token(...)` at `:296-297`). **So in a BFF deployment
the refresh route *is* the tenant-choice route.** There is no separate
tenant-choice route in any of the three middlewares — the Go route table has
only Login/Logout/Refresh/MFAVerify (`go/middleware.go:365-390`).

That makes "login lanes only" untenable: for a BFF-fronted multi-tenant realm,
the moment a brand-new `(user, tenant)` pair first appears is a call to the
**refresh** route, and a hook that skipped it would leave Traide's exact
deployment class uncovered — the same defect shape this repo has now hit twice
(`sdk/DECISIONS.md:647` "the handler ran on three lanes and all three were
logins"; `sdk/DECISIONS.md:440` "the guard that was a COMMENT found three call
sites; the guard that is a PARSER found five").

**Therefore: the hook fires wherever its sibling resolvers fire, refresh
included, with `Flow` naming the lane.** A partner who wants
once-per-authentication writes one line — `if ev.Flow == FlowRefresh { return
nil }` — which is the idiom `OnAuthSuccess` already prescribes for
best-effort work (`go/middleware.go:181-185`). Us guessing which lanes they
want is worse than telling them which lanes exist.

Two consequences the builder must implement:

1. **The `enrichRefreshMint` short-circuit must consult the hook.**
   `go/derived_claims_refresh.go:51-53` returns early when both resolvers are
   nil; likewise `ts/src/derived-claims-refresh.ts:83` and
   `java/.../AuthClient.java:309`. A hook-only consumer would otherwise never
   fire on refresh. This is the *same* rule the Java code already states for
   the login-lane guard (`java/.../AuthClient.java:229-231`: *"BOTH handlers
   gate the short-circuit. Consulting productRoles alone would leave a
   scopes-only consumer silently never minting at all"*).
2. **The subject-peek failure branch becomes an error when the hook is
   configured.** Today an unreadable `sub` degrades silently
   (`go/derived_claims_refresh.go:70-77`, `ts/src/derived-claims-refresh.ts:95-102`,
   `java/.../AuthClient.java:~326-334`). The hook's contract is "identity is
   known"; if it is not, we cannot fire it, and silently not firing is exactly
   the failure the partner came to us with. **Refuse the refresh** in that
   branch *only when the hook is non-nil*; leave the degrade path unchanged for
   everyone else. This is the only behaviour change this work imposes on an
   existing configuration, and it applies to zero current consumers (nobody can
   have configured a handler that does not exist yet).

### 4.4 Lanes where the guarantee is VACUOUS — stated, not implied

- **`Auth.Token` called directly** (`go/auth.go:690`, `ts/src/auth.ts:778`,
  `java/.../AuthClient.java:352`): does **not** fire. It is the raw mint
  primitive; the caller is already in their own code and can call their own
  reconciler. Firing here would double-fire every lane above, all of which
  route through it.
- **Credential-bootstrapped lanes** (static API key / platform API key /
  ADR-057 workload federation): do **not** fire, and **cannot**. The platform
  session is minted by `sessionManager.login` (`go/platform_token.go:131`),
  which produces no user and no tenant — there is no identity to resolve. This
  is the guarantee being vacuous by construction, not a gap to close.
- **ADR-089 no-refresh sessions**: `enrichRefreshMint` returns early when there
  is no refresh token (`go/derived_claims_refresh.go:55-63`,
  `ts/src/derived-claims-refresh.ts:84-89`). Those sessions never refresh, so
  there is nothing to fire on. The hook still fires on the lane that *created*
  them if that lane reached `mintProductRoles`.
- **Logout / RevokeSession / ListSessions**: no mint, no fire.

---

## 5. THE CRUX — may the hook's error fail the authentication?

### 5.1 Ruling: YES, unconditionally, with no policy knob

**Because the identical veto already exists and has since ADR-102/ADR-097.**
This is the decisive fact, and it is verifiable:

- `Config.Scopes` failing → `resolveScopes` returns `*ScopesError`
  (`go/scopes_handler.go:114-118`) → `mintProductRoles` returns it
  (`go/auth.go:658-661`) → `Login` wraps it in `LoginMintError`
  (`go/auth.go:561-566`) → the middleware writes an auth failure
  (`go/middleware.go:501`). **A partner's scope store being down already fails
  every login on that realm today.**
- On refresh, identically: `enrichRefreshMint` returns the error
  (`go/derived_claims_refresh.go:79-85`) and `handleRefresh` fails the request
  (`go/middleware.go:590-593`). Java states the reasoning in the filter itself
  (`java/.../RealmFilter.java:315-318`).
- `SPEC.md:601-604` makes it contract: *"An ERROR -> the SDK RETRIES, then
  REFUSES to mint. Not swallowed, not best-effort."*

So the availability surface the owner is right to be wary of is **already
handed to relying parties**. Refusing it to the new hook would not remove the
veto; it would only keep the partner's write in the one place where the SDK
retries it three times — the exact contract violation this work exists to end.
The choice is not "veto or no veto"; it is "veto in a retried function or veto
in a non-retried one".

**No policy knob.** A partner who wants best-effort behaviour writes `return
nil` after handling their own error — the idiom `OnAuthSuccess` already
prescribes in writing (`go/middleware.go:181-185`). A configuration flag would
be a second way to express something already expressible in one line, and this
codebase has a standing preference against exactly that
(`go/product_roles.go:86-88`: *"which is the price of not having a knob"*).

### 5.2 Which house precedent applies — the seat guard, not the revocation cache

Both were ruled 2026-09-05 and they went opposite ways. The distinguishing
question the revocation entry itself names
(`issuer/DECISIONS.md:466-472`) is: *is this a read degrading to the behaviour
that preceded it, or a write proceeding on an unknown?*

**Fail-open (revocation, `issuer/DECISIONS.md:440-457`) does NOT apply.** Its
two load-bearing arguments both fail here:

1. *"Never worse than the status quo"* — false. The status quo for a
   hook-configured partner is not "nothing happened"; it is "the row was
   seeded". Proceeding past a failed hook mints a token whose `scope` was
   resolved against a row that is missing or stale. That is not a degraded
   read; it is a **confidently wrong authority claim**.
2. *"Fail-closed would make a datastore a hard dependency of every
   authenticated read"* — false. The hook runs on mint, not on read. It is
   already true that mint depends on the partner's store, by way of `Scopes`.
   No new dependency is created and no per-request path is touched.

**Fail-closed (seat guard, `issuer/DECISIONS.md:494-502`) DOES apply**, almost
literally: *"a store that cannot answer must say so, never guess 'none'"*, and
*"a silent `(0, nil)` here would read as 'no seats' and ALLOW the write — the
exact fail-open misreading the guard exists to prevent."* Swap "seats" for
"scopes" and it is this decision. An absent `scope` claim reads as **no granted
authority** in every SDK gate — the issuer never stores `scope`, deliberately
(`go/scopes_handler.go:35-40`) — so minting past a failed hook turns a blip in
the partner's store into an authorization outage our logs record as a clean
200. That sentence is already in the tree, twice
(`go/scopes_handler.go:60-63`, `go/derived_claims_refresh.go:45-49`).

### 5.3 "Fail the login" and "fail the mint" are NOT the same thing, and the
spec must not conflate them

The hook can only fail the **mint**. It cannot prevent an authentication,
because by the time it runs the issuer has already authenticated the principal
and created a session:

- **Direct client**: `/auth/login` already returned 200 and the session exists
  server-side. The SDK hands the session back **on the error** —
  `LoginMintError` carries it (`go/auth.go:561-566`), and that is the ADR-102
  OQ8 recovery anchor, restated in ts (`ts/src/auth.ts:653-661`) and java
  (`java/.../AuthClient.java:146-152`). The new hook's error MUST ride the same
  anchor, for the same reason. **Builder instruction: wrap it in
  `LoginMintError` / `LoginMintException` exactly as the resolver errors are.**
- **Middleware**: `respondAuthFail` runs, so no refresh cookie is written and
  no session reaches the browser (`go/middleware.go:501`,
  `go/middleware.go:611`) — but the issuer-side session is live and orphaned
  until it expires. **This is already true for a `ScopesError` today**; the
  hook adds no new class of orphan. State it in the doc comment so nobody
  discovers it during an incident.
- **Refresh**: worse, and worth calling out. The hook fires *after* the first
  `/auth/token` (it needs the subject, and
  `go/derived_claims_refresh.go:31-35` deliberately refuses to peek the
  expiring token). So the presented refresh token has already rotated and a
  hook error is an **unrecoverable logout**. `OnAuthSuccess`'s doc comment
  already warns about this exact hazard on the refresh path
  (`go/middleware.go:181-185`). Again: already true for `ScopesError` today.
  The doc comment must say it.

### 5.4 Timeout, and what happens on expiry

**Ruling: no synthetic deadline, no race, no goroutine/`Promise.race`
abandonment. The hook receives the caller's context unchanged and is
contractually required to honour it.**

Reasons, in order of weight:

1. **The SDK cannot bound a partner handler's execution today either.**
   `resolveScopes` calls `h(ctx, ...)` directly (`go/scopes_handler.go:106`); a
   `ScopesHandler` that blocks forever blocks the login forever, right now. The
   documented "~200ms ceiling" (`go/product_roles.go:68-72`) bounds the SDK's
   *retry* budget, not the handler's own execution. **The hook adds no new hang
   class.** A design that invented an enforcement mechanism only for the new
   hook would leave the older, larger hole open while claiming safety.
2. **A deadline we cannot enforce is a promise we cannot keep.** Go cannot kill
   a goroutine; abandoning it leaks it *and* leaves the partner's write racing
   the error we already returned — a mirror written after the login we failed.
   That is a partial-write hazard the seat-guard ruling would call a claim made
   without evidence.
3. **Inventing a deadline is a behaviour change for a working hook.** A hook
   that legitimately takes 400ms would start failing on an SDK upgrade for a
   limit nobody chose.

**What the doc comment must therefore say, in all three languages:** the hook
runs on the login hot path with a human waiting; it must be bounded by the
caller's own timeout, and the SDK will not interrupt it. The residual — whether
to *additionally* race a deadline — is **OQ-3**.

### 5.5 Should the answer differ per lane?

**No.** A per-lane failure policy would mean the partner's mirror is
authoritative on some mints and advisory on others, and the token would carry
authority derived from a row we accepted might be wrong. One rule, stated once.
Per-lane *behaviour* differences (§5.3) are consequences to document, not knobs
to configure.

---

## 6. Naming — settled

| | Handler type | Config surface | Event | Error |
|---|---|---|---|---|
| go | `IdentityResolvedHandler` | `Config.OnIdentityResolved` | `*IdentityResolvedEvent` | `*IdentityResolvedError` |
| ts | `IdentityResolvedHandler` | `RealmConfig.onIdentityResolved` | `IdentityResolvedEvent` | `IdentityResolvedError` |
| java | `IdentityResolvedHandler` | `Realm.Builder.onIdentityResolved(...)` | `IdentityResolvedEvent` | `IdentityResolvedException` |

Go signature (note the `ctxpkg "context"` alias — the `check-gofr.sh` hook
blocks a bare `context.Context` on a new exported func in this SDK):

```go
type IdentityResolvedHandler func(ctx ctxpkg.Context, ev *IdentityResolvedEvent) error
```

**Why `On…` and not the resolver naming.** `ProductRoles` / `Scopes` are named
for what they *return*, and their names carry an implicit "pure". An `On…`
prefix marks an event whose whole purpose is a side effect. The naming itself
encodes side-effect-permitted vs side-effect-free, which is the single
distinction a partner most needs to get right here. It also sits naturally
beside the existing `BeforeLogin` / `OnAuthSuccess` / `OnAuthFailure` family.

**Rejected, with reasons that should not be re-litigated:**

- `BeforeMint` / `PreMint` — **factually false** on every lane. `/auth/login`
  has already minted (`go/auth.go:519`); on refresh the first `/auth/token` has
  already minted (`go/middleware.go:568`). A name that lies is worse than a
  clumsy one.
- `BeforeDerivedClaims` — accurate but names an internal concept
  (`derived_claims_refresh.go`) that no partner has a reason to know.
- `OnPrincipalResolved` — "principal" is issuer vocabulary; the SDK's public
  surface says *user* and *identity*.

---

## 7. The payload

```go
type IdentityResolvedEvent struct {
    Flow        AuthFlow // login | otp | password | mfa_verify | tenant_choice | refresh
    RealmID     string   // guaranteed non-empty
    TenantID    string   // guaranteed non-empty
    UserID      string   // guaranteed non-empty — the per-membership users row id (JWT `sub`)
    Role        string   // best-effort; may be "" — the RealmID role for this tenant
    Email       string   // best-effort; may be ""
    DisplayName string   // best-effort; may be ""
}
```

Sourcing, so the builder does not invent it:

- `TenantID`: on the login lanes, `settledTenant`'s result — the same value
  passed to the resolvers (`go/auth.go:647`). On refresh, `out.TenantID` when
  present, else the requested tenant — the `effectiveTenant` the code already
  computes (`go/derived_claims_refresh.go:65-68`,
  `ts/src/derived-claims-refresh.ts:93`).
- `UserID` / `Email` / `DisplayName`: on the login lanes, `Session.User`
  (backfilled from the access token at `go/auth.go:546-556`). On refresh,
  `peekJWTUserFields` already returns all three
  (`go/platform_token.go:243`) — today `enrichRefreshMint` discards two of them
  (`go/derived_claims_refresh.go:69`); keep them.
- `Role`: on the login lanes, the `Tenants[i].Role` matching `TenantID` — the
  same lookup `mintProductRoles` already does *after* the mint
  (`go/auth.go:676-681`); hoist a read-only copy of it. On refresh, `""`.

**`UserID` doc comment must state the per-membership rule**: the JWT `sub` is
the per-tenant `users` row id, not a person. A partner keying a mirror on
`sub` alone will split or collide humans across orgs; the key is
`(tenant_id, sub)`.

### 7.1 What it must NOT receive, and why

- **No access token.** The token in hand at that instant is the
  *pre-derived-claims* token: no `scope`, no `product_roles`. A partner reading
  it would see absent-scope and conclude "no granted authority" — the exact
  ADR-097 misreading the whole seam exists to prevent
  (`go/scopes_handler.go:35-40`). Handing a bearer credential to a hook whose
  job is a database write is also a credential-surface expansion for nothing.
- **No refresh token.** Same reasoning, higher stakes.
- **No `*http.Request` / `ConnectReq` / `HttpServletRequest`.** The hook lives
  in `AuthClient`, which has none; giving it one on the middleware lane only
  would make the hook behave differently direct vs middleware, which is the
  property §3.2 exists to guarantee. A partner who needs the request has
  `OnAuthSuccess` (Go middleware) — see §8.
- **No mutable handle on the `Session` / `LoginResponse`.** `BeforeLogin`
  deliberately allows mutation (`go/middleware.go:170-174`); this hook
  deliberately does not. If the hook could change tenant or role, the
  resolution that follows would resolve for something the issuer did not
  authenticate. The Go event is passed as `*IdentityResolvedEvent` for
  allocation reasons only; the doc comment states that mutating it has no
  effect and a test pins that (`TestIdentityResolvedEventMutationIsInert`).

---

## 8. Relationship to `OnAuthSuccess`

**Sibling. Not a replacement, and `OnAuthSuccess` is not redefined in terms of
it.** They answer different questions at different times:

| | `OnIdentityResolved` (new) | `OnAuthSuccess` (existing, Go only) |
|---|---|---|
| Configured on | `Config` (realm) | `MiddlewareOptions` (`go/middleware.go:186`) |
| Available to | direct client **and** middleware, all 3 languages | Go middleware only |
| Fires | before the derived-claims resolution | after the mint, before the cookie is written (`go/middleware.go:751-771`) |
| Sees | identity + tenant, no tokens | the full `Session` incl. tokens, and the `*http.Request` |
| Purpose | seed the row the resolvers read | post-auth work that needs the finished session |

**`OnAuthSuccess` keeps its current semantics exactly.** It still fires where it
fires; its doc comment gains one cross-reference sentence pointing at the new
hook for the "my resolver needs a row that does not exist yet" case.

**ts and java do NOT get `OnAuthSuccess` in this change.** Reasons: (a) the new
hook already covers Traide's need on both direct and middleware lanes in all
three languages, so the parity gap is not blocking anything; (b) adding it
would be a *second* new three-language surface in one change, with its own
event type, failure routing and stage constants; (c) `OnAuthSuccess` needs the
framework request object, which means three different framework types and no
shared contract. Registered as a follow-up in `sdk/TODO.md`, not built here.
This is **OQ-4** only in the sense that the owner may disagree; the
recommendation is firm.

---

## 9. Idempotency and retries — stated plainly

- **The hook is NOT retried. Exactly one invocation per derived-claims
  resolution.** That is the entire point of its existence: it is the
  side-effecting twin of two deliberately side-effect-free, deliberately
  retried resolvers (`go/scopes_handler.go:28-33`,
  `go/product_roles.go:74-88`).
- **On a transient failure**: the mint is refused, the error surfaces to the
  caller (§5.3), and the retry is the *user's* — they log in again, which fires
  the hook again from the top. The SDK does not own that retry and does not
  pretend to.
- **The hook must still be idempotent**, and the doc comment must say so with
  the reason: a user can retry a failed login, and a tenant switch re-fires it
  for a second tenant (§4.2). **Upsert, do not insert.**
- **No caching, no dedupe key, no "already fired" memo in the SDK.** A memo
  would need an identity key, a TTL and an eviction policy — three decisions
  with no right answer at this layer — and it would silently stop firing after
  a partner's own database was restored from backup. Absent state is the honest
  state.

---

## 10. Tests — the reordering regression must be caught

`sdk/TODO.md` records the defect this section exists to prevent: the refresh
ordering is two adjacent statements (`go/middleware.go:590` then `:598`) with
**no test that would fail if they were swapped**, because no Go test configures
both `Scopes:` and `OnAuthSuccess:` — they are exercised in disjoint universes
(`go/derived_claims_lanes_test.go` and `go/middleware_derived_claims_test.go`
set the resolver; `go/middleware_hooks_test.go:66,101,150` set the hook).
Shipping this hook without closing that gap repeats the defect.

### 10.1 The named test

**`TestIdentityResolvedRunsBeforeScopeResolution`** (go) /
`"runs before scope resolution and its write is visible to the resolver"`
(`ts/src/identity-resolved.test.ts`) /
`IdentityResolvedTest#runsBeforeScopeResolutionAndItsWriteIsVisible` (java).

It must assert the **causal** property, not the order of a log:

1. Configure `OnIdentityResolved` **and** `Scopes` **and** `ProductRoles` on
   one realm — the first test in this repo to configure the hook and a resolver
   together.
2. The hook writes `{tenantID+userID: ["orders:read"]}` into a map.
3. `Scopes` *reads that map* and returns whatever it finds — nothing else.
4. Assert the minted `/auth/token` body carries `scope: ["orders:read"]`.

A test that only records `["hook","scopes"]` in an ordered slice can be
satisfied by a reordering that happens to log the same way; a test where the
resolver's return value is *produced by* the hook cannot. **Mutation-verify it:
move the fire site below `resolveScopes` and confirm RED before accepting the
change**, in each language. A gate that has never failed has not been shown to
work (`issuer/DECISIONS.md:438`).

### 10.2 The other four

- **`TestIdentityResolvedFiresOnEveryDerivedClaimsLane`** — drives all five
  login lanes plus refresh; asserts exactly one fire each, with the expected
  `Flow`.
- **`TestIdentityResolvedFiresOncePerTenant`** — a multi-tenant login fires
  zero times, `CompleteLogin` fires once, a second `CompleteLogin` for a
  different tenant fires once more (§4.2).
- **`TestIdentityResolvedErrorRefusesTheMint`** — the error surfaces, no
  `/auth/token` request is made, and on the login lanes the session rides the
  `LoginMintError` anchor (§5.3).
- **`TestEveryResolverCallSiteAlsoFiresTheHook`** — extends
  `go/derived_claims_lanes_test.go`'s AST walk. The existing guard derives the
  lane set from the package rather than a hand-maintained list, precisely
  because two hand-maintained lists hid two lanes
  (`go/derived_claims_lanes_test.go:22-40`). The new assertion: **no function
  in the package may call `resolveScopes` or `resolveProductRoles` without also
  calling `fireIdentityResolved`.** That catches a *future* resolver call site
  added without the hook — the failure mode that produced this work.
  ⚠️ An AST walk proves co-occurrence, not order; §10.1 is what proves order.
  Both are required, and neither substitutes for the other.

### 10.3 The E2E suite

Add the hook to `tests/sdk-e2e/` alongside the existing derived-claims cases.
Per the standing rule, a new parity check goes in the E2E suite too, not only
the unit suites (`sdk/TODO.md:341`). **NOT VERIFIED in this pass**: I did not
read `tests/sdk-e2e/` — the builder should confirm the shape before assuming a
slot exists.

---

## 11a. OWNER RESOLUTIONS (2026-09-05) — all six settled, spec is BUILDABLE

The six questions in §11 are CLOSED. Builders implement against these; do not
re-open them, and do not treat §11's phrasing as still-open where it conflicts.

- **OQ-1 — fire on the REFRESH lane? YES.** Owner ruling. Login-only would ship
  a known hole in exactly the deployment class that asked for this: all three
  middlewares require `tenant_id` on the refresh route and none has a
  tenant-choice route, so in a BFF deployment the refresh route IS the
  tenant-choice route. A partner who does not want the per-access-TTL write
  opts out by returning nil.
- **OQ-2 — a fail-open policy knob? NO.** Owner ruling. A partner already
  expresses fail-open by returning nil, so the knob adds no capability. The
  decisive argument is asymmetry: adding a knob later is additive, removing one
  is breaking.
- **OQ-3 — race a deadline against the hook? NO.** Owner ruling. The SDK cannot
  bound `ScopesHandler` today, so bounding only the new hook is theatre — a
  hanging resolver stalls the same mint by the same amount. The caller's own
  context deadline still applies and is the honest bound.
- **OQ-4 — do ts/java also gain `OnAuthSuccess`? NO, deferred** to `sdk/TODO.md`
  as its own item. Out of scope here.
- **OQ-5 — `SPEC.md` §4.1.2 vs the code.** CORRECT THE SPEC. Root `CLAUDE.md`'s
  "when prose and code disagree, code wins" governs; add §4.1.5 for this hook
  and record the correction in `sdk/DECISIONS.md`. ⚠️ Do NOT "fix the SDK to
  match SPEC.md" — that inverts the rule.
- **OQ-6 — a distinct middleware tenant-choice route?** FILE in `sdk/TODO.md`,
  do not build here.

**The crux (§5) stands as written: the hook's error refuses the mint,
unconditionally, with no knob.** Verified independently before the owner ruled:
a failing `Config.Scopes` ALREADY fails every login on that realm
(`go/auth.go:658` → `go/auth.go:561`), so this veto is not new. And
`LoginMintError` HANDS THE SESSION BACK rather than discarding it
(`go/auth.go:562-565`), which is why the hook can only fail the DELIVERY of a
session, never an authentication — the issuer-side session already exists.

## 11. Open questions — each with a recommendation

### OQ-1 — Does the hook fire on the REFRESH lane?

The partner asked for "once per authentication"; refresh is not an
authentication. But all three middlewares require `tenant_id` on refresh
(`go/middleware.go:543-551`, `ts/src/middleware.ts:276-278`,
`java/.../RealmFilter.java:296`) and no middleware has a tenant-choice route
(`go/middleware.go:365-390`), so **in a BFF deployment the refresh route IS the
tenant-choice route** — the most likely place a new `(user, tenant)` pair first
appears.

- **OPTION A (recommended): fire on refresh**, with `Flow: refresh` in the
  event and a doc comment telling the partner they may early-return. Symmetric
  with the resolvers it feeds; a hook that fires on a strict subset of the
  resolver's lanes is the exact defect shape this repo hit on 2026-09-01 and
  2026-09-03. **Cost:** the partner's write runs once per access-TTL per live
  session unless they opt out; and the peek-failure branch becomes an error for
  hook-configured consumers (§4.3.2).
- **OPTION B: login lanes only.** Matches the partner's words and their load
  expectation. **Blocks:** BFF multi-tenant tenant-choice seeding — Traide's own
  deployment class — which would have to be documented as uncovered, meaning
  they keep their extra round trip for exactly the case that motivated this.
- **What each blocks:** A makes §4's guarantee wording, the two
  `enrichRefreshMint` changes and one test case load-bearing. B removes all
  three and shrinks the change by roughly a third — but ships a known hole.

### OQ-2 — Is there a `Continue` (fail-open) policy at configuration time?

§5.1 rules **unconditional fail-closed, no knob**, because a partner can
already express fail-open with `return nil` and the identical veto already
exists via `Config.Scopes`.

- **OPTION A (recommended): no knob.** One rule, no configuration surface, no
  second way to say the same thing.
- **OPTION B: `OnIdentityResolvedFailure{FailMint|Continue}`, default
  `FailMint`.** Buys a partner an audit-visible declaration of intent instead
  of a silently swallowed error inside their own handler.
- **What each blocks:** B adds a three-language enum, its defaulting rule, and
  a test matrix; and it becomes a compatibility surface forever. A is
  reversible later (adding a knob is additive); B is not (removing one is
  breaking). **That asymmetry is the argument for A.**

### OQ-3 — Should the SDK additionally race a deadline against the hook?

§5.4 rules **no** — the SDK cannot bound `ScopesHandler` today either, and a
race leaks a goroutine and lets the partner's write land *after* we returned
the error.

- **OPTION A (recommended): no race.** Pass the caller's context; document that
  the hook must honour it.
- **OPTION B: race a configurable deadline** (Go goroutine + `select`, TS
  `Promise.race`/`AbortSignal`, Java `Future.get(timeout)` — which needs an
  executor, i.e. new machinery in the Java SDK).
- **What each blocks:** B bounds our worst-case login latency, which is real.
  It also introduces the partial-write hazard and, in Java, an executor
  lifecycle the SDK does not currently own. If B is chosen it should be applied
  to `ScopesHandler` and `ProductRolesHandler` at the same time — a hang bound
  on the new hook alone is theatre.

### OQ-4 — Do ts and java also get `OnAuthSuccess`?

§8 recommends **no, not in this change**: the new hook covers the partner need
in all three languages on both lanes, and `OnAuthSuccess` needs a
framework-specific request object.

- **OPTION A (recommended): defer**, file in `sdk/TODO.md`.
- **OPTION B: build both now**, for Go-parity.
- **What each blocks:** B roughly doubles the surface and drags in three
  framework request types with no shared contract. A leaves a real, already
  four-months-old Go-only asymmetry unaddressed for longer.

### OQ-5 — `SPEC.md` §4.1.2 contradicts the code on how realm-level handlers are wired

`SPEC.md:589-591` says Go functional option / TS `TokenManagerOptions`; the
code is a `Config` field in Go (`go/realmid.go:117`) and a `RealmConfig` field
in TS (`ts/src/realm.ts:129`), with a written rationale
(`go/realmid.go:112-116`). `sdk/TODO.md:71` says the SPEC is law and the SDK
must be fixed; root `CLAUDE.md` says code wins.

- **OPTION A (recommended): correct the SPEC**, add a §4.1.5 for
  `onIdentityResolved` describing the Config-field wiring, and note the
  §4.1.2 correction in `sdk/DECISIONS.md`. The code's rationale is written down
  and is right; the SPEC sentence was a prediction, not a decision.
- **OPTION B: honour the SPEC** and wire the new hook as a functional option in
  Go — inconsistent with its two siblings, which is worse than either rule.
- **What each blocks:** leaving it unresolved means the next builder reading
  "SPEC.md is law" wires the new hook a third way.

### OQ-6 — Should the middleware gain a distinct tenant-choice route?

Out of scope for this work, surfaced because §4.3 depends on it. Today the
refresh route carries two semantically different operations, which is why OQ-1
is hard at all. Recommend: **file in `sdk/TODO.md`**, do not build here.

---

## 12. Migration — is this breaking?

**No, in all three languages, for every existing consumer.**

- **go**: `Config` gains a field (`go/realmid.go:37`). Non-breaking for every
  keyed struct literal. *Theoretically* breaking for an unkeyed composite
  literal `Config{...}` — not idiomatic, not used in the repo's own examples,
  and already true of the last four fields added to this struct. Note it in the
  changelog; do not gate on it.
- **ts**: `RealmConfig` gains an optional property (`ts/src/realm.ts:147`
  neighbourhood). Purely additive.
- **java**: `Realm.Builder` gains one method (`java/.../Realm.java:512`
  neighbourhood). Purely additive. Two constructors and two `AuthClient`
  constructions must carry the field (§3.3).
- **`OnAuthSuccess` users**: unaffected. It fires where it fired, with the same
  event and the same failure routing.
- **The single behaviour change**, and it applies to zero consumers today: with
  the hook configured, an unreadable `sub` on the refresh lane refuses the
  refresh instead of degrading silently (§4.3.2). Nobody can have configured a
  handler that does not exist yet.

### Release mechanics the builder must not skip

- Go's `const Version` must be bumped in the same PR — the CI job
  `tag-hygiene.sh unreleased-go` fails when `go/` differs from the tag matching
  the declared version (`sdk/TODO.md:158-164`).
- `CHANGELOG.md` entries in `go/`, `ts/`, `java/` **and** the root, before any
  tag: `scripts/changelog-hygiene.sh` gates the publishers, and for Go the tag
  *is* the release — a Go tag pushed before its changelog entry exists is
  immutable and can never go green (root `CLAUDE.md` § SDK row).
- A dated `sdk/DECISIONS.md` entry in the same turn, recording the §5 ruling
  and the OQ resolutions.
- `SPEC.md` §4.1.5 per OQ-5.
- `docs/integration-guide.md` and `docs/partner-integration-guide.md` need the
  hook documented next to the resolvers; the partner guide is the one Traide
  can actually read (`issuer/docs/` is private).

---

## 13. Summary of rulings this document makes

1. The seam is **`mintProductRoles` + `enrichRefreshMint`**, on `Config` /
   `RealmConfig` / `Realm.Builder` — **not** `MiddlewareOptions`. No middleware
   file changes.
2. The guarantee is **"once per derived-claims resolution"**, never "once per
   authentication". Vacuous on the credential lanes and on direct `Auth.Token`,
   and it says so.
3. **The hook's error refuses the mint, unconditionally, with no knob** — the
   seat-guard shape, not the revocation-cache shape, because this is a write
   proceeding on an unknown rather than a read degrading to prior behaviour.
   And because `Config.Scopes` already holds the identical veto today.
4. **It cannot fail an authentication** — only the delivery of a session. Say
   so, including the orphaned-session and rotated-refresh consequences.
5. **Not retried; must be idempotent; no SDK-side memo.**
6. **Name: `OnIdentityResolved`.** `BeforeMint` is rejected as factually false.
7. **`TestIdentityResolvedRunsBeforeScopeResolution`** asserts the causal
   property, mutation-verified, plus an AST guard that no resolver call site
   may exist without a fire site.
8. **Non-breaking**, with one behaviour change that reaches zero current
   consumers.
