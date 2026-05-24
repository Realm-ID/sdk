# Operations Reference

Companion to `integration-guide.md`. Where the integration guide tells
you how to wire RealmID into your app, this document tells you what to
expect from RealmID as a *running service* — incident channel, key
rotation, version policy, hosted environments, roadmap commitments.

> Some sections below are marked **TBD**. RealmID is pre-launch enough
> that not every operational policy is published yet. TBD items will
> firm up before the relevant guarantee is needed; if your project is
> blocked on one, file an issue at https://github.com/Realm-ID/sdk and
> we'll prioritize.

---

## 1. Service URL and environments

- **Production:** `https://auth.realmid.dev` (single host; per-realm
  scoping happens via the `realmId` UUID in URL paths and JWT `iss`).
- **Staging:** No separate hostname today. The recommended pattern is
  a **separate realm on the same host** for staging — provision a
  fresh realm via the admin UI, point your stage SPA + backend at it,
  and treat `auth_realm_id` as a per-environment variable.

  A distinct staging hostname (e.g. `auth-staging.realmid.dev`) is
  not currently offered; the value-add over realm-isolation is small
  for most partners. **TBD** — file an issue if your compliance posture
  requires a separate hostname.
- **Local dev:** Run the auth API locally via the docker-compose stack
  in the `Realm-ID/issuer` repo (`tests/docker-compose.test.yml`). Same
  wire shape; same SDK code path with `baseUrl` pointed at
  `http://localhost:<port>`.

## 2. Status and incident communication

- **Status page:** `https://status.realmid.dev` — **TBD** (page exists
  but content is sparse pre-launch). Will publish per-component
  status (auth API, JWKS, admin UI, partner-token mint) and historical
  incident reports.
- **Incident notifications:** Subscribe via the status page (RSS +
  email). Critical incidents on `/auth/login` or JWKS will also be
  posted to the `Realm-ID/sdk` repo's GitHub Discussions for partners
  who already follow the SDK.
- **Published SLO:** **TBD.** Internal targets: 99.9% monthly
  availability on `/auth/login` and `/auth/token`; p99 latency under
  300 ms. These are not yet contractual — treat as planning numbers.

## 3. JWKS and signing-key rotation

- **Verifier cache TTL:** 10 minutes (SDK default; not configurable).
- **Unknown-`kid` behavior:** any verify against a JWT whose `kid` is
  not in cache forces an immediate JWKS refetch. Rotation never causes
  more than one cache-miss-latency spike per process.
- **Rotation cadence:** approximately quarterly in steady state; ad
  hoc on incident response (suspected key compromise, algorithm
  upgrade). **TBD** — exact cadence will be published once the
  background `keyrotate` worker has six months of production data.
- **Advance notice:** for planned rotations, 30 days via the status
  page + GitHub Discussions. For incident-driven rotations, none —
  the verifier handles them transparently via the unknown-`kid`
  refetch path.
- **Old keys:** retained in the JWKS for 24 hours after rotation so
  in-flight access tokens (default 15-minute TTL) verify cleanly.

## 4. Audit events

- **Today:** RealmID keeps an internal audit log of auth events
  (login attempts, role changes, invitation accepts, session
  revocations, OTP issue/view/verify). **There is no partner-facing
  way to subscribe to or export this log.** Drop your local
  audit_log table on this assumption *only if* domain audit is
  acceptable to you (your access log + your own role-change handlers
  cover most needs).
- **OTP-related kinds (v0.6.0):** `auth.otp.issued`,
  `auth.otp.viewed`, `auth.otp.verified`, `auth.otp.verify_failed`.
  The verify-success row denormalises `issuer_user_id` so partner
  side audit logs can record the gating actor without a follow-up
  RealmID query. When the partner sets `X-On-Behalf-Of-User`
  (ADR-050), `on_behalf_of_user_id` is also captured. Until the
  pull endpoint below ships these are server-internal only;
  partners should mirror their own view of issue/verify into their
  business audit log.
- **Roadmap — pull endpoint:** `GET /platforms/{id}/audit-events?since=…`
  paginated. Cheaper than webhooks; partners poll on their cadence.
  **TBD** — no committed ETA; will land if multiple partners formally
  request it.
- **Roadmap — webhook delivery:** signed payload, retries, partner-
  registered endpoint. **TBD** — heavier surface; lower priority than
  the pull endpoint.

If you need auth-event observability before the above ships, the
practical workaround is to emit your own audit entries from your
partner middleware (you already see every authenticated request) +
your invitation/role-update handlers (you already make those calls).
This covers ≥ 90% of what an RI-side audit feed would give you.

## 5. SDK versioning

- **TS:** `@realmid/sdk` on npm. Pin to the latest minor (`^0.4`)
  during pre-launch; re-pin on each minor release.
- **Go:** `github.com/Realm-ID/sdk/go`. Pin via `go.mod` to the
  latest tag. The Go module follows semver post-v1; pre-1.0 minor
  bumps may include breaking changes.
- **Java:** `dev.realmid:sdk` on Maven Central. Same versioning model.
- **Compatibility matrix:** SDK 0.4.x is the version of record; it
  matches the auth-API behavior described in this guide. Older SDK
  versions may lag features (e.g. BFF mode, custom roles, the fixed
  `Tenants.Create` wire path) — see `CHANGELOG.md` for per-version
  feature support.

## 6. Roadmap items partners often ask about

These are designed but not shipped. Status as of 2026-04-27.

- **ADR-042 — identifier-collision invariant + `user_contacts` table.**
  Generalizes phone-uniqueness to all contact kinds, adds invite-time
  pre-check with collision details in the response, makes username/
  password a clean schema slot. Designed (`api/docs/adr/042-…md`),
  not yet implemented. Until it ships, partners enforcing
  identifier-uniqueness in their UI should pre-check against their
  own users mirror.
- **`permissions[]` JWT claim.** Custom roles (ADR-040) currently
  store permissions per role but don't surface them in the access
  token. Roadmap item; **TBD** ETA. When it ships, the addition is
  non-breaking — partners gating on `role` name continue to work.
- **Per-role / per-user-class concurrent-session limit.**
  `concurrent_session_limit` is realm-wide today. Per-class limits
  (e.g. "100 web sessions per user, but unlimited sync sessions")
  are not on the near roadmap. Workaround: split sync into a
  separate realm if you need independent ceilings.
- **Headless device-code grant.** OAuth 2.0 device-code flow
  (`POST /auth/device/code` → poll `/auth/device/token`) for
  long-lived clients on headless servers. Designed but not built;
  schedule depends on partner demand. Today's pattern is the
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
- **Server bugs / behavior questions:** `Realm-ID/issuer` issues
  (private repo; if you don't have access, file via SDK and we'll
  triage).
- **Operational incidents:** status page + your account contact.
- **ADRs / design discussions:** GitHub Discussions on
  `Realm-ID/issuer`. Major changes (like ADR-042) are posted there
  before implementation starts.
