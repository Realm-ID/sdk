# Operations Reference

Companion to `integration-guide.md`. Where the integration guide tells
you how to wire RealmID into your app, this document tells you what to
expect from RealmID as a *running service* — incident channel, key
rotation, version policy, hosted environments, roadmap commitments.

> RealmID is pre-launch, so a few operational policies are still
> firming up; where a section describes a post-launch enhancement or a
> roadmap item, it says so explicitly. If your project is blocked on
> one, file an issue at https://github.com/Realm-ID/sdk and we'll
> prioritize.

---

## 1. Service URL and environments

- **Production:** `https://auth.realmid.dev` (single host; per-realm
  scoping happens via the `realmId` UUID in URL paths and JWT `iss`).
- **Staging:** No separate hostname today. The recommended pattern is
  a **separate realm on the same host** for staging — provision a
  fresh realm via the admin UI, point your stage SPA + backend at it,
  and treat `auth_realm_id` as a per-environment variable.

  A distinct staging hostname (e.g. `auth-staging.realmid.dev`) is
  not offered: same-host realm isolation is the supported staging
  model, and per-realm scoping already isolates config, keys, users,
  and tokens. If your compliance posture strictly requires a separate
  hostname, file an issue — but it is not on the near roadmap.
- **Local dev:** There is no packaged test issuer shipped with the SDK
  (an earlier revision implied one). For local and CI tests, either
  stub the handful of endpoints your code touches (the SDK is plain
  HTTP — every suite in this repo does exactly that with an in-process
  fake), or run against a dev realm on the hosted issuer with
  `baseUrl` unchanged. For a full local server, contact the RealmID
  team.

## 2. Status and incident communication

- **Status page:** `https://status.realmid.dev` — a single overall
  service indicator plus a historical incident log. Automated
  per-component decomposition (auth API, JWKS, admin UI, partner-token
  mint) is a post-launch enhancement.
- **Incident notifications:** Today, critical incidents on
  `/auth/login` or JWKS are posted to the `Realm-ID/sdk` repo's GitHub
  Discussions and recorded on the status page's incident log.
  Automated subscription (RSS + email) from the status page is a
  post-launch enhancement.
- **Published SLO:** 99.9% monthly availability on `/auth/login` and
  `/auth/token`, with p99 latency under 300 ms. **These are
  contractual** under a signed SLA addendum; absent one, they are our
  committed service objective. Window is the calendar month; partner-
  caused 4xx (401/412/429) are excluded, while 5xx and timeouts count
  against the objective.

## 3. JWKS and signing-key rotation

> **Not the same thing as rotating your API key.** This section is about the
> **signing keys** RealmID uses to sign tokens — RealmID rotates those, your SDK
> follows along automatically, and you do nothing. Your own `rk_live_…`
> **platform API key** is a separate credential that **you** rotate, and since
> issuer `v0.61.0` it **expires by default (90 days)**. The caps, the
> mint→deploy→verify→retire sequence, the chicken-and-egg if you let it lapse,
> and the per-realm policy for end-user `uk_live_…` keys are all in
> [partner-integration-guide §6.4.1](./partner-integration-guide.md) —
> which lives beside this file since 2026-08-28 (it previously sat in a
> private repo partners could not read; the old path is a pointer stub).
> The two rotations share a word and nothing else.


- **Verifier cache TTL:** 10 minutes (SDK default; not configurable).
- **Unknown-`kid` behavior:** any verify against a JWT whose `kid` is
  not in cache forces an immediate JWKS refetch. Rotation never causes
  more than one cache-miss-latency spike per process.
- **Rotation cadence:** quarterly (every 90 days) in steady state,
  plus immediate emergency rotation on suspected key compromise or
  algorithm upgrade. Planned rotations carry 30 days' advance notice
  (see below); emergency rotations are handled transparently by the
  unknown-`kid` refetch path with no advance notice.
- **Advance notice:** for planned rotations, 30 days via the status
  page + GitHub Discussions. For incident-driven rotations, none —
  the verifier handles them transparently via the unknown-`kid`
  refetch path.
- **Old keys:** retained in the JWKS for 24 hours after rotation so
  in-flight access tokens (default 15-minute TTL) verify cleanly.

## 4. Audit events

- **Today:** RealmID keeps an audit log of auth events (login
  attempts, role changes, invitation accepts, session revocations,
  OTP issue/view/verify) and **exposes a partner-facing pull feed** —
  see the shipped pull endpoint below. You no longer need to mirror
  RealmID-side events into your own store to retain them, though
  doing so is still reasonable if you want a single unified audit view.
- **OTP-related kinds (v0.6.0):** `auth.otp.issued`,
  `auth.otp.viewed`, `auth.otp.verified`, `auth.otp.verify_failed`.
  The verify-success row denormalises `issuer_user_id` so partner
  side audit logs can record the gating actor without a follow-up
  RealmID query. When the partner sets `X-On-Behalf-Of-User`
  (ADR-050), `on_behalf_of_user_id` is also captured. (An earlier
  revision said these kinds were server-internal pending the pull
  endpoint; the endpoint shipped — they are in the feed.)
- **Shipped — pull endpoint (ADR-055):**
  `GET /platforms/{id}/audit-events`, surfaced in all three SDKs
  (`realm.AuditEvents.List` in Go, `auditEvents.list` in TS,
  `auditEvents()` in Java). Filters: `since`/`until` (unix seconds),
  `kind`, `tenant_id`, `actor_id`, `limit`. Pagination is an **opaque
  forward cursor** — pass `next_cursor` from the response back as
  `cursor` until it is null; do not parse it as a timestamp. The feed
  is **platform-scoped and forced**: the server derives the platform
  from your authenticated token and ignores any query-string
  `platform_id`, so you cannot read another platform's events.
  **Retention is 400 days** — pull at least quarterly if you need a
  longer compliance archive.
- **Roadmap — webhook delivery:** signed payload, retries, partner-
  registered endpoint. Heavier surface; lower priority than the pull
  endpoint, which now covers the common need. No committed ETA.

If you prefer not to poll the pull endpoint, you can still emit your
own audit entries from your partner middleware (you already see every
authenticated request) + your invitation/role-update handlers (you
already make those calls). This covers ≥ 90% of what the RI-side
audit feed gives you, and pairs well with it for a unified view.

## 5. SDK versioning

- **TS:** `@realm-id/sdk` on npm. Pin to the latest minor and re-pin
  on each minor release — and remember a caret does **not** cross a
  0.x minor (`^0.43` never installs `0.44.0`; edit the manifest).
- **Go:** `github.com/Realm-ID/sdk/go`. Pin via `go.mod` to the
  latest tag. The Go module follows semver post-v1; pre-1.0 minor
  bumps may include breaking changes.
- **Java:** `dev.realmid:sdk` on Maven Central. Same versioning model.
- **Compatibility matrix:** `SPEC.md` is the authoritative contract.
  As of this document's last audit (2026-08-31) the released tags are
  Go **`go/v0.51.1`**, TS **`ts-v0.44.0`**, Java **`java-v0.41.0`**,
  against issuer **`v0.114.0`** — but treat those as a snapshot: the
  git tags and `CHANGELOG.md` are the source of truth, not this line.
  (Go module tags use the submodule-path form `go/vX.Y.Z` — that, not
  the stale `go-v*` label, is what `go get` resolves. ⚠️ `go/v0.51.0`
  is published-and-immutable with a `const Version` that says
  `0.50.0`; pin `0.51.1` if you read `realmid.Version`.) SDKs are
  versioned independently per language; see `CHANGELOG.md` for
  per-version support.

## 6. Roadmap items partners often ask about

Status of the items partners most often ask about, as of 2026-05-31.
Most remain on the roadmap; any that have since shipped are marked.

- **ADR-057 — Workload Identity Federation (no stored API key) —
  SHIPPED (issuer v0.14.0, SPEC v0.10.0).** A partner workload running on
  GCP (Cloud Run/GKE/GCE) or GitHub Actions can authenticate with its
  *ambient* OIDC token instead of a stored `rk_live_` key. The SDK is
  zero-config — drop the API key and it auto-detects the ambient source:

  ```
  // Go — no APIKey:
  realmid.NewRealm(realmid.Config{RealmID: rid})
  ```

  Register a trust binding once (RI-side) per workload via
  `POST /platforms/{id}/federation-bindings`. The `match_claims` are the
  tenant boundary and must constrain the provider's mandatory claim:
  - **GCP** → the service account's immutable numeric `sub` (its
    `uniqueId`, never the reassignable email):
    `gcloud iam service-accounts describe SA_EMAIL --format='value(uniqueId)'`
    → `{ "issuer": "https://accounts.google.com", "match_claims": {"sub": "1148350..."} }`
  - **GitHub Actions** → at least `repository` (workflow needs
    `permissions: id-token: write`):
    `{ "issuer": "https://token.actions.githubusercontent.com", "match_claims": {"repository": "acme/billing", "environment": "prod"} }`

  Additive — `platform_api_key` is unchanged. AWS/Azure/self-hosted K8s
  are not yet supported (RI pins the JWKS for the two v1 issuers).
- **ADR-042 — identifier-collision invariant + `user_contacts` table —
  SHIPPED (issuer v0.11.0).** Identifiers are now independently-verified
  `user_contacts` rows rather than `users.email`/`users.phone` columns;
  the collision invariant is generalized to all contact kinds and
  invite allocates the stable, final `users.id` (= future `sub`) up
  front. Invite-time pre-check returns collision details in the
  response. (The related *provider-anchored login* piece — login-time
  linking of multiple providers to one user, ADR-042 P1 — is still
  roadmap.) Partners no longer need their own uniqueness pre-check,
  though keeping one is fine defence-in-depth.
- **`permissions[]` JWT claim (ADR-040 P2) — SUPERSEDED.** The need
  this item tracked shipped as the ADR-097 `scope` claim (issuer
  `v0.95.0`–`v0.101.0`): your backend supplies its own scope strings
  at `/auth/token` mint time and enforces them with the SDK's
  `ScopePolicy`. A role's `permissions[]` is RealmID's own ADR-074
  catalog (what the holder may do *to RealmID*) and is deliberately
  never minted into partner tokens. Note also that custom role
  *authoring* was retired outright by ADR-101 — RealmID owns the role
  set, and partner product roles are scopes.
- **Per-role / per-user-class concurrent-session limit.**
  `concurrent_session_limit` is realm-wide today — and that is now a
  decision, not a gap: a per-ROLE limit shipped with ADR-092 and was
  **retired** by ADR-101 along with the rest of the per-role knobs.
  Workaround: split sync into a separate realm if you need
  independent ceilings.
- **Headless device-code grant.** OAuth 2.0 device-code flow
  (`POST /auth/device/code` → poll `/auth/device/token`) shipped for
  RealmID's **own** CLI at RealmID's BFF (ADR-062) — proof the shape
  works — but there is still no issuer-side device grant a partner
  can call. If you want it, the ADR-062 pattern is what you would
  host on your own BFF; otherwise today's pattern remains the
  install-time browser flow described in the integration guide §6.1.
- **Cross-tenant identity portability.** "Same human, multiple
  tenants in one realm" view (one canonical record per
  `(method, provider_uid)`). Captured as G8 in ADR-042; explicit
  non-decision. Future ADR if a partner needs it.

## 7. Pricing

Out of scope for engineering documentation. Route via your RealmID
account contact. As of 2026-04-27, no realm-config knob (e.g.
`concurrent_session_limit`, `access_token_custom_claim_keys`,
custom-domain count, origin count) is gated by tier — every option
documented in the integration guide is available to every realm.
This may change once formal pricing tiers land.

## 8. Where to file feedback

- **SDK bugs / feature requests:** `Realm-ID/sdk` issues.
- **Server bugs / behavior questions:** file via `Realm-ID/sdk` issues
  or your account contact; we triage server-side.
- **Operational incidents:** status page + your account contact.
- **Design change proposals:** shared with integration partners ahead of
  implementation via your account contact.
