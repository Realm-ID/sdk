<!-- GENERATED from docs/migrating-to-realmid.md by claude-plugin/scripts/sync-references.py. Do not edit; run the script. -->
<!-- Canonical: https://github.com/Realm-ID/sdk/blob/main/docs/migrating-to-realmid.md -->

# Migrating to RealmID: questions partners ask

Written 2026-10-14 from a real consultation: a partner with several apps, its own user store and
"Sign in with Google" asked what to build today so that moving to RealmID later needs no breaking
change. This page answers those questions (and the ones that follow from them) in plain words.

How to read it:

- It is written for a person **or** for the partner's AI agent. Every entry stands alone and has a
  stable heading, so you can jump straight to one.
- Each answer links to a **public** place that says the same thing: the
  [partner integration guide](https://github.com/Realm-ID/sdk/blob/main/docs/partner-integration-guide.md), the [SDK contract](https://github.com/Realm-ID/sdk/blob/main/SPEC.md), the
  [error reference](https://github.com/Realm-ID/sdk/blob/main/docs/error-reference.md), or the
  [served OpenAPI spec](https://auth.realmid.dev/.well-known/openapi.json) (call it "the spec"
  below). When this page and the spec disagree, the spec wins; please tell us.
- A line starting `Claim:` is a hard rule with an id. Those ids are what we pin with tests, so a
  claim here cannot quietly go stale.
- Nothing here is a roadmap. Where RealmID does not do something today, it says so and does not
  promise it.

Contents: [What RealmID does](#what-realmid-does-and-does-not-do) ·
[Identity keys](#identity-keys-what-to-store-per-person) · [Roles](#roles-who-holds-what) ·
[Tokens and sign-in](#tokens-and-sign-in) · [Testing and CI](#testing-and-ci) ·
[Mistakes to avoid](#mistakes-to-avoid-now)

---

## What RealmID does and does not do

### What does RealmID own, and what stays with me?

RealmID owns **sign-in, a user directory per organisation, organisations, invitations, bulk import,
API keys and service accounts**. You keep everything about your product: your own roles inside
your product, your data, billing.

Example: a customer company is one RealmID *organisation* ("tenant"). Its people sign in through
RealmID. "Editor on project 7" is a fact in *your* database.

- Realm and organisation model: [guide, section 1](https://github.com/Realm-ID/sdk/blob/main/docs/partner-integration-guide.md#1-the-one-minute-model)
  and [section 2](https://github.com/Realm-ID/sdk/blob/main/docs/partner-integration-guide.md#2-terminology-cheat-sheet).
- What RealmID will not do: [guide, section 8](https://github.com/Realm-ID/sdk/blob/main/docs/partner-integration-guide.md#8-what-realmid-will-not-do-for-you).

### Does RealmID support SCIM?

No. There is no SCIM route in the spec. To create people in bulk use
[bulk import](#how-do-i-load-my-existing-users), and to manage them use the users routes under
`/tenants/{id}/users` in [the spec](https://auth.realmid.dev/.well-known/openapi.json).

Claim: `no-scim`

### Does RealmID issue an OIDC ID token or run a redirect ("authorize") login page for my app?

No. RealmID mints **access tokens and refresh tokens** only. There is no `/authorize` redirect
flow and no ID token. The discovery document is deliberately minimal: it gives your verifier the
issuer, the key-set URL (`jwks_uri`) and the token endpoint, and nothing more. Your login screen
stays yours; see [How does Google sign-in work?](#how-does-google-sign-in-work).

Example: do not point a generic "OIDC login" library at RealmID and expect a redirect login. Your
backend calls RealmID's `POST /auth/login` instead.

Spec: `GET /{realm}/.well-known/openid-configuration` and `GET /{realm}/.well-known/jwks.json`.
Also [guide, architecture summary](https://github.com/Realm-ID/sdk/blob/main/docs/partner-integration-guide.md#architecture-summary-adr-041-bff-login).

Claim: `no-id-token`

### Can RealmID erase a person's name and email? We have an erase-on-delete rule.

No, not today. A person's membership is moved to `deactivated`; the row and its id stay (that is
what keeps your foreign keys valid). The spec has no erase or anonymise route. The closest thing is
`POST /tenants/{id}/users/{uid}/contacts/{contactId}/delink`, which removes a sign-in binding from
an address but does **not** delete the address.

What to do: keep your own personal data (names, emails) in your own store and give RealmID only
what sign-in needs, so your erase rule has something real to act on. If you need true erasure
inside RealmID, raise it with us; do not assume it exists.

Claim: `no-erase-user`

### Can a project (or any thing below an organisation) be a RealmID organisation?

No. Organisations are flat inside a realm; there is no organisation-inside-organisation. Model
one customer as one organisation, and keep projects as your own records.

- [Guide, section 1](https://github.com/Realm-ID/sdk/blob/main/docs/partner-integration-guide.md#1-the-one-minute-model) and
  [section 8](https://github.com/Realm-ID/sdk/blob/main/docs/partner-integration-guide.md#8-what-realmid-will-not-do-for-you) (no sub-tenant RBAC).

### Can one person belong to many organisations?

Yes, and each membership is a **separate row with its own id**. A person in three organisations
has three RealmID user rows, three `sub` values. There is no person-level record. See
[What is `sub`?](#what-is-sub-and-what-should-i-store-per-person).

A realm can forbid it: if the realm setting `single_tenant_membership` is on, a second active
membership is refused.

- [Guide, section 7.1](https://github.com/Realm-ID/sdk/blob/main/docs/partner-integration-guide.md#71-the-identity-model-you-are-mapping-onto-read-first).

Claim: `same-provider-uid-two-orgs`

---

## Identity keys: what to store per person

### What is `sub`, and what should I store per person?

`sub` is the id of the person's membership row **in one organisation**. It is not a person id and
it is not Google's id. The token also carries `tenant_id`. Store and look up on the pair
**`(tenant_id, sub)`**, never on email.

Example: Dana is in "Glowbar" and "Acme". She has `sub = A1` with `tenant_id = Glowbar` and
`sub = B2` with `tenant_id = Acme`. Two rows in your table, one per membership. If you need to
say "these are the same human", use your own person id, or the memberships returned by
`GET /me`; no RealmID claim identifies a person across organisations.

`sub` is stable: leaving an organisation is a status change to `deactivated`, never a row
deletion, so a foreign key onto it does not dangle.

- [Guide, section 3](https://github.com/Realm-ID/sdk/blob/main/docs/partner-integration-guide.md#3-jwt-claims-you-will-receive).
- [SDK contract, verifier surface](https://github.com/Realm-ID/sdk/blob/main/SPEC.md#5-verifier-surface-realmverify).

Claim: `sub-is-per-membership`
Claim: `key-on-tenant-sub`

### Why not key people on their email?

Email is only a way to *find* a person; it is never proof of who they are or what they may do. An
address can change, be shared, or be asserted by an admin without the owner proving it. RealmID
only links accounts by email when a sign-in provider the realm trusts proves the address.

Rule: use email to look someone up, never as the primary key or as an authorisation decision.

- [Guide, section 7.1](https://github.com/Realm-ID/sdk/blob/main/docs/partner-integration-guide.md#71-the-identity-model-you-are-mapping-onto-read-first).

### Can I bring my own user ids?

Yes, if they are UUIDs. In a bulk import a row may carry its own `user_id`, and that value
**becomes the RealmID user id**, which is then the `sub` in their tokens. A row without one gets a
fresh UUIDv7, returned in the result so you can store it.

Rules:

- The id must be a UUID. A non-UUID (for example an integer or `usr-123`) cannot be imported, so
  if your ids are not UUIDs, derive one (see
  [UUIDv5 from a slug](#my-ids-look-like-ten-glowbar-what-do-i-do)).
- One id is **one membership**, so a person in two organisations needs two ids. Put the
  organisation in the hash: for example `uuidv5(NAMESPACE, "user:" + org_id + ":" + user_id)`.
- An id that already exists in a **different** organisation rejects the whole import file.
- An id that already exists in the **same** organisation is an update, so re-running an import
  is safe.

Example: you import Dana's two memberships with `user_id` set to your two UUIDs. After the move,
her token `sub` is exactly the UUID you already store, so nothing in your database is re-keyed.

- [Guide, section 7.3](https://github.com/Realm-ID/sdk/blob/main/docs/partner-integration-guide.md#73-bulk-import-mechanics-post-tenantsidusersimport-adr-073).
- Spec: `POST /tenants/{id}/users/import`.

Claim: `user-id-byo-uuid`

### Can I bring my own organisation (tenant) ids?

Yes, if they are UUIDs. `POST /platforms/{pid}/tenants` accepts an optional `id`.

- Absent: RealmID mints a UUIDv7 and returns it.
- Present and new: the organisation is created with that id.
- Present and already in **your** realm: it is a reconcile, so only `display_name` is updated. The
  owner and creation date never change. That makes the call safe to re-run.
- Present but in **another** realm: refused (`cross_realm_tenant_id`).
- Not a UUID: refused with `400 invalid_tenant_id`.

A new organisation must be created with an inline `owner`, because an organisation is always born
with an owner.

The id is used in URLs (`/tenants/{id}`) and as the `tenant_id` claim in tokens, so choose it
once and keep it.

- Spec: `POST /platforms/{pid}/tenants` (field `id`).

Claim: `tenant-id-is-uuid`
Claim: `tenant-id-byo-reconcile`

### My ids look like `ten-glowbar`. What do I do?

Either change them to UUIDs, or keep the readable slug as your own column and **derive** the
UUID from it with UUIDv5: the same slug always gives the same UUID, so re-runs are stable. RealmID
explicitly accepts a derived UUIDv5 as an organisation id or user id. Key your records on the
UUID, and treat the slug as a label.

Example: `uuidv5(YOUR_NAMESPACE, "tenant:ten-glowbar")` is always the same UUID. Pick
`YOUR_NAMESPACE` once, write it down, and never change it.

- [Guide, section 7.1](https://github.com/Realm-ID/sdk/blob/main/docs/partner-integration-guide.md#71-the-identity-model-you-are-mapping-onto-read-first)
  (deriving ids).
- Spec: `POST /platforms/{pid}/tenants`, the `id` description says a derived UUIDv5 is legal.

### How do I load my existing users?

Use the bulk import, one call per organisation: `POST /tenants/{id}/users/import`. It is
all-or-nothing on validation (any bad row means nothing is written), and the answer is HTTP 200
with a `committed` flag, so read the flag, not the status code. Imported people are active with
verified contacts.

To make the person's **first Google sign-in** attach to the right row, give the row `provider`
and `provider_uid` (Google's subject). Without them the first sign-in is matched by email or phone.

- [Guide, section 7.3](https://github.com/Realm-ID/sdk/blob/main/docs/partner-integration-guide.md#73-bulk-import-mechanics-post-tenantsidusersimport-adr-073)
  and [section 7.4](https://github.com/Realm-ID/sdk/blob/main/docs/partner-integration-guide.md#74-minimal-downtime-cutover).

### Can the same Google account be linked in two organisations?

Yes. A Google identity is bound per organisation, so one Google account can have a row in several
organisations of one realm. One sign-in can then get tokens for each organisation the person
belongs to. The exception is a realm with `single_tenant_membership` on, which allows only one.

Claim: `same-provider-uid-two-orgs`

### After I migrate, what does `sub` mean?

`sub` becomes RealmID's membership id, **not** Google's subject. Google's subject survives only as
the provider id on the binding. If you recorded "the token subject" anywhere (audit logs, caches,
foreign keys), it changes meaning unless you imported with `user_id` set to your own UUID, in
which case `sub` equals that UUID. Grep for every place you log, cache or join on `sub`.

- [Guide, section 7.2](https://github.com/Realm-ID/sdk/blob/main/docs/partner-integration-guide.md#72-the-ordered-checklist), step on auditing claims.

Claim: `sub-is-per-membership`

---

## Roles: who holds what

### Who owns roles: RealmID or me?

Two different things share the word "role":

| | RealmID role | Your product role |
|---|---|---|
| What it controls | what a person may do **to RealmID**: manage members, mint keys, revoke sessions | what a person may do **in your product** |
| Examples | `owner`, `admin`, `member` | "project editor", "viewer on project 7" |
| Who defines it | RealmID. The set is fixed; you cannot add one. | You, in your own database. |
| On the token | the `role` claim (one role per person per organisation) | `scope` and/or `product_roles` |

Recommendation: keep your product roles in your own stores and make them the source of truth.
RealmID has no per-project roles and stores no partner role catalog. Move them onto the token
(next entries) only so your services can read them without a database call.

- [Guide, section 4](https://github.com/Realm-ID/sdk/blob/main/docs/partner-integration-guide.md#4-adding-your-own-rbac).

Claim: `role-set-realmid-owned`

### Can I add my own roles to RealmID?

No. Authoring a role answers `403 role_authoring_retired`. For an organisation the roles are
`owner`, `admin` and `member`. Do not hard-code those names; `GET /platforms/{id}/roles` returns
what your realm offers.

- [Guide, section 4](https://github.com/Realm-ID/sdk/blob/main/docs/partner-integration-guide.md#4-adding-your-own-rbac).

Claim: `role-set-realmid-owned`

### How do my own roles get onto the token?

Your **backend** asks for them when it mints, on `POST /auth/token`:

- **`scope`**: a list of strings your services check route by route. Your repo owns the
  mapping from route to scope and from role to scope; RealmID never reads the strings.
- **`product_roles`**: your role *names*, carried for your services to read. RealmID never reads
  them either.

Limits: `product_roles` holds at most 16 entries of at most 64 bytes each. `scope` is bounded by
the realm: by default 32 entries of 128 bytes each, and a violation answers `too_many_scopes` or
`scope_too_long`.

Example: your backend mints for Dana in Glowbar with `scope: ["projects:read", "projects:write"]`
and `product_roles: ["tenant_admin"]`. Your services read those two claims from the verified token.

- [Guide, section 4.2](https://github.com/Realm-ID/sdk/blob/main/docs/partner-integration-guide.md#42-route-authorization-scope-on-the-token-adr-097),
  [how you get a scoped token](https://github.com/Realm-ID/sdk/blob/main/docs/partner-integration-guide.md#how-you-get-a-scoped-token) and
  [`product_roles`](https://github.com/Realm-ID/sdk/blob/main/docs/partner-integration-guide.md#your-role-names-on-the-token--product_roles-adr-102-issuer-v01160).
- [SDK contract, token(req)](https://github.com/Realm-ID/sdk/blob/main/SPEC.md#42-tokenreq).

Claim: `scope-on-token-endpoint`
Claim: `scope-bounds-realm-default-32x128`
Claim: `product-roles-bounds-16x64`

### Does RealmID drop scopes it does not recognise?

No. RealmID does not understand your scope strings, so it never filters them. On an ordinary
session the scope you request is signed **unchanged**. Only a session born from a **user API key**
that carries a `permissions_cap` is narrowed, by exact string match against that cap; an empty cap
narrows to nothing. So **your backend is the filter**: request only scopes the person should have.

- [Guide, section 4.1](https://github.com/Realm-ID/sdk/blob/main/docs/partner-integration-guide.md#41-user-api-keys-permissions_cap-is-a-cap-never-a-grant-adr-084)
  and [section 4.2](https://github.com/Realm-ID/sdk/blob/main/docs/partner-integration-guide.md#42-route-authorization-scope-on-the-token-adr-097).

Claim: `scope-passthrough-uncapped`

### Can a browser ask for its own roles or scopes?

It must not. Scope is taken from a request your confidential backend makes; never forward a
browser-supplied role list into the mint.

- [Guide, section 4.2](https://github.com/Realm-ID/sdk/blob/main/docs/partner-integration-guide.md#42-route-authorization-scope-on-the-token-adr-097).

### Who is the owner of an organisation, and can it change?

Exactly one person owns an organisation (a single pointer on the organisation). Ownership moves by
a direct transfer, `PUT /tenants/{id}/owner`, with no accept step. The new owner must already be
an **active** member. The old owner keeps a role you choose (default `member`), or leaves entirely.
Deactivating the sole owner is refused (`409 last_owner`); transfer first.

- Spec: `PUT /tenants/{id}/owner`, and `PATCH /tenants/{id}/users/{uid}/status` (the `last_owner`
  guard).

Claim: `single-owner`
Claim: `owner-transfer-direct`

---

## Tokens and sign-in

### What is in a RealmID access token?

A signed JWT with: `iss`, `sub`, `aud`, `exp`, `iat`, `nbf`, `jti`, `sid` (session id),
`azp`, `tenant_id`, `role`, and, when your backend asks for them, `scope`, `product_roles` and
custom claims. Verify signature, `iss` and `aud` on every request; the SDK does this for you.

- [Guide, section 3](https://github.com/Realm-ID/sdk/blob/main/docs/partner-integration-guide.md#3-jwt-claims-you-will-receive) and
  [SDK contract, verifier surface](https://github.com/Realm-ID/sdk/blob/main/SPEC.md#5-verifier-surface-realmverify).

### What are `iss` and the key set (JWKS)?

The issuer is **per realm**: the base URL plus the realm id. Each realm has its own key set and a
small discovery document at `/{realm}/.well-known/openid-configuration`, which names the `jwks_uri`.
Configure your verifier with three values: issuer, key-set URL, audience.

Claim: `discovery-minimal`

### Can my three apps have different `aud` values?

No. `aud` is **one value per realm**, so every app in the realm gets the same `aud`. What tells
apps apart is `azp`, and only in one situation: when a token is minted through a backend that signs
in with its own platform API key, `azp` is that key's fingerprint (it looks like
`apikey:abc123...`). Give each backend (BFF) its own platform API key and you can tell them apart by
`azp`. For a direct, non-backend login `azp` is the origin the person signed in from. If you need
hard separation, use separate realms.

Example: three BFFs (customer app, admin console, staff console), three platform API keys, three
distinct `azp` fingerprints, one shared `aud`. Check `aud` for "is this my realm?" and `azp` for
"which front end?".

- [Guide, section 3](https://github.com/Realm-ID/sdk/blob/main/docs/partner-integration-guide.md#3-jwt-claims-you-will-receive).

Claim: `aud-per-realm`
Claim: `azp-is-bff-key-fingerprint`

### How long does an access token last, and how does refresh work?

Access tokens last **15 minutes** by default; a realm can change that with its
`access_ttl_seconds` setting. Your confidential backend holds the refresh token and calls
`POST /auth/token` to get a new access token and a **new** refresh token. Every refresh rotates
the refresh token. If an *old* refresh token is presented again, RealmID treats it as theft and
revokes the whole session, so the real holder must sign in again. Never let the browser keep the
refresh token, and never refresh from two places at once with the same token.

A session started from an API key (platform key, service key, user API key, token exchange) has
**no refresh token**: you just sign in again. Presenting one answers `401 m2m_refresh_withdrawn`.

The idle timeout is a realm setting that your backend is expected to enforce; the issuer does not.

- [Guide, section 5](https://github.com/Realm-ID/sdk/blob/main/docs/partner-integration-guide.md#5-sessions-logout-mfa) and
  [SDK contract, token(req)](https://github.com/Realm-ID/sdk/blob/main/SPEC.md#42-tokenreq).
- [Error reference](https://github.com/Realm-ID/sdk/blob/main/docs/error-reference.md).

Claim: `access-ttl-15m`
Claim: `refresh-rotation-reuse-revokes`

### How does Google sign-in work?

RealmID does not redirect to Google for you. Your front end does Google sign-in as it does today
and gets a Google ID token. Your **backend** then sends it to RealmID:

`POST /auth/login` with
`{"grant_type": "provider_token", "provider": "google", "token": "<google id token>"}` and
`Authorization: Bearer <your platform access token>`.

Not `/auth/token`: that endpoint is for refreshing and for choosing an organisation. The Google
client id your front end uses must be registered with the realm (identity providers), because
RealmID checks the token's audience against it.

You do not have to name the organisation. If the person belongs to one organisation you get an
access token straight away; if they belong to several, login returns a refresh token and your
backend calls `POST /auth/token` with the chosen `tenant_id` (leaving it out answers
`missing_tenant_id`). You may also send `tenant_id` on login to pin it.

- [SDK contract, login(req)](https://github.com/Realm-ID/sdk/blob/main/SPEC.md#41-loginreq) and
  [two-endpoint auth surface](https://github.com/Realm-ID/sdk/blob/main/SPEC.md#40-two-endpoint-auth-surface-adr-051).
- Spec: `POST /auth/login`, `POST /auth/token`.

Claim: `google-signin-via-login`
Claim: `login-tenant-optional`

### Do I need my own backend in the path?

Yes. Every user sign-in needs a platform bearer, which only your backend holds (it comes from a
platform API key). The browser never calls `POST /auth/login` directly. After sign-in your backend
passes the user's RealmID access token on to your services, conventionally in an `X-User-Token`
header.

- [Guide, section 6, acting on behalf of a user](https://github.com/Realm-ID/sdk/blob/main/docs/partner-integration-guide.md#acting-on-behalf-of-a-user-x-user-token-adr-056).

---

## Testing and CI

### How does my CI get a user token without an interactive Google sign-in?

Use a **user API key**. Your backend mints a key for a test person once (minting is backend-only);
CI stores it as a secret and exchanges it with
`POST /auth/login` and `{"grant_type": "user_api_key", "api_key": "uk_live_..."}`. No bearer and no
Google step. The key's `permissions_cap` limits what it can do, and it expires, so plan rotation.
The session carries `amr: ["api_key"]` and never counts as having passed MFA.

A "test user" sign-in does **not** exist; do not wait for one. Machine accounts (`kind=service`)
sign in with a service API key instead.

- [Guide, section 4.1](https://github.com/Realm-ID/sdk/blob/main/docs/partner-integration-guide.md#41-user-api-keys-permissions_cap-is-a-cap-never-a-grant-adr-084),
  [minting is backend-only](https://github.com/Realm-ID/sdk/blob/main/docs/partner-integration-guide.md#one-thing-that-changed-for-you-minting-a-user-api-key-is-now-bff-only)
  and [service accounts](https://github.com/Realm-ID/sdk/blob/main/docs/partner-integration-guide.md#service-accounts-adr-071).
- Spec: `POST /auth/login` (grant `user_api_key`).

Claim: `user-api-key-grant`
Claim: `user-api-key-mint-bff-only`
Claim: `no-test-user-grant`

### What can I test against today?

Run a real issuer locally (Postgres, Redis and the issuer image) and point your `BaseURL` at it.
That is stronger evidence than a hand-written stub, which will happily accept things the real
issuer refuses. Read [guide, section 9](https://github.com/Realm-ID/sdk/blob/main/docs/partner-integration-guide.md#9-testing-your-integration)
for the options and their limits.

---

## Mistakes to avoid now

### What should I avoid doing now because it breaks later?

1. **Verifying Google tokens separately in every service.** Put one verifier abstraction behind a
   config of (issuer, key-set URL, audience). Moving to RealmID then changes that config, not your
   services.
2. **Keying records on email**, or on Google's subject. See
   [Why not key people on their email?](#why-not-key-people-on-their-email)
3. **Mixing up a person id and a membership id.** RealmID's `sub` is per membership.
4. **Non-UUID user or organisation ids.** Imports and organisation creation require UUIDs.
5. **Expecting your role names in RealmID's `role` claim.** Put yours in `scope` or `product_roles`.
6. **Letting the browser state its own roles**, or holding the refresh token in the browser.
7. **Gating on `azp` from a direct browser login.** It is only a trustworthy backend marker when a
   backend minted the token (see [different `aud` values](#can-my-three-apps-have-different-aud-values)).

Example of item 1: write `verifyUser(token) -> {tenantId, sub}` once. Today it checks Google; after
migration it checks RealmID. Every service calls `verifyUser`; none calls Google.

- [Guide, section 7](https://github.com/Realm-ID/sdk/blob/main/docs/partner-integration-guide.md#7-migration-checklist).
