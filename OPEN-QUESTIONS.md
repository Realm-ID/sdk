# OPEN-QUESTIONS — sdk/

Needs an ADR or an owner ruling before any code. See [`TODO.md`](TODO.md) for open, actionable items.

## `onAuthSuccess` exists only in Go, and only in middleware (OQ-4, deferred 2026-09-05)

`OnAuthSuccess` is a field on Go's `MiddlewareOptions` (`go/middleware.go:186`).
It has **no ts or java equivalent at all** — `grep -rin authsuccess ts/src
java/src web` returns zero hits; `ts/src/middleware.ts:71` has only
`onAuthFailure` and `java/.../MiddlewareConfig.java:67-80` exposes no hook
accessor. It is also absent from Go's own DIRECT-client path.

Deliberately NOT addressed by the `OnIdentityResolved` work (spec OQ-4): that
hook is configured on `Config`/`RealmConfig`/`Realm.Builder` and therefore
needed no middleware surface in any language. Whether ts and java should also
gain a post-auth hook is a separate question with its own consumers.

## The middleware has no tenant-choice route (OQ-6, filed 2026-09-05)

All three middlewares route only Login/Logout/Refresh/MFAVerify
(`go/middleware.go:368-390` and its ts/java analogues). `CompleteLogin` — the
tenant-choice mint — is a direct-API call the middleware never sees.

Consequence, and the reason this is filed rather than merely noted: all three
middlewares REQUIRE `tenant_id` on the refresh route, so in a BFF deployment
**the refresh route is doing the tenant-choice job**. That is what forced
`OnIdentityResolved` to fire on the refresh lane (OQ-1) — the alternative was a
known hole in exactly the deployment class that asked for the hook. A real
tenant-choice route would let the two concerns separate.

## `ui/sdk-ts` — structural decision needed

- [ ] `ui/sdk-ts/` is described in `ui/CLAUDE.md` as a mirror of `sdk/ts/`, but is
  in practice a **minimal JWT-verifier shim** (`verifier.ts` + `admin.ts` types +
  `index.ts`) whose `verifier.ts` predates the `errors.ts` taxonomy. `ui/web` does
  **not** consume it at build time. Decide: either make it a full `sdk/ts` mirror
  (drag in errors/auth/http/realm/token-manager/api-keys — a structural rebuild,
  not a file copy) or narrow `ui/CLAUDE.md`'s "mirror / do not let them drift"
  wording to "verifier + admin types only." Also: its verifier tests are mildly
  flaky (1/8 intermittent, timing/JWKS-mock related).

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

