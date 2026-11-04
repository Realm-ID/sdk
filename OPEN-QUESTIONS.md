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

## The reference BFF does not follow `BFF-SPEC.md` — ADR needed (filed 2026-08-30)

> Given its own heading on 2026-09-13. It had been sitting under the Traide
> partner-ask heading, which it has nothing to do with — it landed there only
> because that section happened to be last in the file when this file was
> split out of `TODO.md`.

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

