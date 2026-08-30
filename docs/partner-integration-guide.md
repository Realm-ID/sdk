# Partner Integration Guide

> **Published here, in the PUBLIC `Realm-ID/sdk` repo, as of 2026-08-28.** This
> guide used to live in `Realm-ID/issuer`, which is private — so the page that
> answered partners' most common question was unreachable to every partner. An
> integrator told us. It is here now, and `Realm-ID/issuer` keeps a pointer
> rather than a second copy.
>
> **A note on the references.** This guide cites ADR numbers
> (`issuer/docs/adr/`), `issuer/docs/swagger.yaml`, and sequence diagrams that
> all live in that private repo. The citations are kept deliberately: they say
> exactly what decision a behaviour comes from, so you can hold us to it and ask
> for a specific document by number. **Ask and we will send you any ADR named
> here.** The two documents you never need to ask for are this one and
> [`SPEC.md`](../SPEC.md), both public.
>
> **Related, also public:** [`integration-guide.md`](./integration-guide.md) is
> the SDK-shaped walkthrough (bootstrap → backend → frontend → operations); this
> guide is the platform-shaped one (the model, claims, RBAC, migration). They
> overlap and are being reconciled; where they disagree, `SPEC.md` wins.
>
> **Current as of 2026-07-15 (issuer v0.39.0), except §4.2 (`scope`), refreshed
> 2026-08-28.**
>
> Audience: a backend engineer at a partner platform integrating with RealmID. Features deferred past v1
> (cross-platform authorization endpoints, per-realm invitation TTL)
> are called out inline and catalogued in **ADR-035** — see §9.7 for
> the current list.
> Since v0.4 the surface has moved on substantially — two-endpoint auth
> (`/auth/login` + `/auth/token`, ADR-051), contact-as-identifier
> (ADR-042), workload identity federation (ADR-057, §6.5), and
> first-login MFA self-enrollment (ADR-061, §5).
>
> **Authoritative contract:** `issuer/docs/swagger.yaml`. Sequence
> diagrams (including error branches) live under `issuer/docs/diagrams/`.
> (Per the ADR-053 repo rename, these moved from `Realm-ID/api` to
> `Realm-ID/issuer`; GitHub auto-redirects old links.) This guide indexes
> those and fills the partner-integration gaps the contract alone doesn't
> cover.

## Architecture summary (ADR-041, BFF login)

New realms default to **BFF (Backend-For-Frontend) login**: every
`/auth/*` call against your realm carries `Authorization: Bearer
<platform_token>` minted from your `rk_live_…` API key. A direct
browser → RealmID `/auth/login` with no platform bearer is rejected with
`401 unauthorized` (login *always* requires a platform token, ADR-047 §2);
the `bff_bearer_required` sub-code is what every `/auth/*` call returns
when the platform bearer is absent. Since ADR-088 (issuer v0.67.0) that is
unconditional — the old per-realm `require_bff_login` opt-in is gone,
along with the public-client model it enabled.

```
┌──────────────┐      ┌──────────────┐      ┌──────────────────┐
│   Webapp     │─────▶│ Partner API  │─────▶│ RealmID          │
│  (browser)   │ user │ (your        │ +    │ auth.realmid.dev │
│              │ JWT  │  backend)    │ Auth │                  │
│              │◀─────│              │◀─────│                  │
└──────────────┘      └──────────────┘      └──────────────────┘
                       │  - holds rk_live_… in secret manager
                       │  - SDK exchanges for platform JWT (cached ~4m)
                       │  - attaches platform JWT to every /auth/* call
                       │  - forwards user's access JWT in X-User-Token
                       │    on /auth/sessions/* and /auth/mfa/*
```

The SDK (`@realm-id/sdk` for TS, `github.com/Realm-ID/sdk/go` for Go)
handles all of
this transparently — partner code calls `realm.auth.login(...)` /
`realm.auth.token(...)` / `realm.auth.logout(...)` and the SDK attaches
the right headers. See §6 below.

This is the entry point for any platform integrating with RealmID. It does not replace the ADRs or `design.md` — it indexes them and fills the gaps a real partner hits when wiring things up.

## 0. Getting started (one-time setup)

Operator-side bootstrap, once per environment (see ADR-028):

1. Point a fresh Postgres + Redis at the compose stack.
2. Run `cmd/realmid-seed` against the empty Postgres. The binary
   applies the baseline schema itself (`migrations.ApplyBaseline`)
   and then inserts the base realm + base admin tenant + signing
   key + bootstrap invitation + default `realm_clients` rows in a
   single deferred-FK transaction (ADR-037).
3. Capture the emitted lines:
   ```
   BASE_REALM_ID=<uuid>
   BASE_TENANT_ID=<uuid>
   BOOTSTRAP_INVITATION_ID=<uuid>
   ```
4. Copy `BASE_REALM_ID` into the main api process env as
   `REALMID_BASE_REALM_ID`. The api refuses to start without it
   (ADR-015 `validateBaseRealm`).
5. Start `cmd/realmid`. Accept the bootstrap invitation link via
   `app.realmid.dev` using Firebase to sign in; that creates the
   first `users` row for the operator.

From that point forward the operator can create platform realms
via the self-serve flow (§1 below + `docs/diagrams/platform-self-serve.md`).

---

## 1. The one-minute model

- You (the partner) get **one realm** per platform. A custom domain is
  **optional** (ADR-073): create the platform without one and it lives
  on its `<slug>.realmid.dev` hosted-login subdomain, with full
  login/JWKS/discovery/SSO; add a verified custom domain later via the
  realm-origins flow.
- Your users live in **tenants** inside your realm. One row per person per tenant (ADR-022).
- RealmID issues **JWTs**; your API verifies them using the SDK against RealmID's JWKS.
- You do **not** self-issue JWTs. You do **not** verify Firebase/Google tokens yourself (ADR-024).
- A user's tenant lives in the **JWT claim**, not in your session store (ADR-026).

If any of this conflicts with your current auth, see §7 Migration.

## 2. Terminology cheat sheet

See `design.md` §Terminology for the canonical definitions. The three that trip up partners:

| Your word (common usage) | RealmID word | Notes |
| --- | --- | --- |
| "platform admin" (admin of your platform) | **Realm Owner** or **Tenant Owner** | Not **Platform Admin** — that's RealmID's own operator. |
| "org" | **Tenant** | One tenant per organizational unit you isolate. |
| "outlet" / "branch" / "sub-team" | (partner-owned) | RealmID does not model sub-tenant structure (ADR-025). |

## 3. JWT claims you will receive

Every RealmID access token carries at least:

| Claim | Source | What you do with it |
| --- | --- | --- |
| `iss` | `https://auth.realmid.dev/{realmId}` | Validate prefix matches SDK `BaseURL` (ADR-020). |
| `aud` | The realm's intrinsic audience `realmid:<platform_ref>` (ADR-064) — frozen at platform creation, **not** your domain | Validate matches SDK `Audience`. |
| `azp` | The login origin (e.g., `app.dealera.com`) | Audit / analytics; don't gate on it. |
| `sub` | RealmID user ID (UUIDv7) | Your FK to RealmID users. |
| `tenant_id` | RealmID tenant ID | **Authoritative** tenant boundary for the request. |
| `role` | The user's single role in that tenant | See §4 for how to extend. |
| `jti` | Session ID | For audit correlation. |
| `exp`, `iat`, `nbf` | Standard | Standard. |

Partner API middleware must reject any token where `iss` prefix, `aud`, or signature check fails. The SDK does this by default.

## 4. Adding your own RBAC

> **⚠️ Breaking, ADR-101 (2026-08-30): you can no longer author a role in
> RealmID.** `POST /platforms/{id}/roles` and its `PATCH` / `DELETE` / `rename`
> siblings now answer `403 role_authoring_retired` for every realm but
> RealmID's own. `GET /roles` and `disable`/`enable` are unchanged.
>
> If you have product roles in RealmID today, they are being migrated to
> `member` and you have been notified separately. This section tells you where
> they go instead.

**RealmID's roles are RealmID's own administrative vocabulary.** A role in
`realm_roles` describes what a user in one of your tenants may do **to
RealmID** — manage members, mint keys, claim domains, revoke sessions. It has
never described your product, and after ADR-101 it is not permitted to pretend
to.

The set you get is fixed, and differs by level:

| your tenants are… | the roles they can hold |
|---|---|
| **orgs** in your platform realm | `owner`, `admin`, `member` |
| your own **admin tenant** (staff who run your realm) | `owner`, `admin`, `member`, `platform_api`, `platform_mgmt_api` |

A realm may **disable** `admin` — that is the one shaping decision left, and it
means "this realm has exactly one administrator, its owner". So do **not**
hardcode the names: `GET /platforms/{id}/roles` remains the honest way to learn
what a realm offers.

### Your product's roles live in your system

They reach RealmID as **ADR-097 scopes**, and the SDK ships the map:

```ts
import { scopesForRoles, validateRoleScopes } from "@realm-id/sdk";

// In YOUR repo, next to the roles it describes. RealmID never sees this.
const ROLE_SCOPES = {
  dispatcher: ["orders:read", "orders:assign"],
  accountant: ["invoices:read", "orders:read"],
};

// Once, at startup — a bad entry here costs a user their authority at request
// time, far from the typo.
for (const e of validateRoleScopes(ROLE_SCOPES)) console.error(e);

// At login, per user.
const scopes = scopesForRoles(ROLE_SCOPES, user.roles);
await realm.auth.login({ ..., scope: scopes, rolePermissions: scopes });
```

Go: `realmid.RoleScopes{...}.ScopesFor(roles...)`. Java:
`RoleScopes.scopesForRoles(MAP, roles)`. Both have the same `Validate`.

A role the map does not know contributes **nothing** — no error. That is
deliberate: raising would fail every login by a user holding a role you added
before your deploy, and refusing a login is far worse than issuing a token with
fewer scopes that your gate then refuses comprehensibly. `validate` at startup
is how you catch the gap.

The other half of the same idea — route → scope — is §4.2 below. Both maps live
in your repo; the SDK only evaluates them.

### Attaching partner-owned DATA (not authority)

RealmID gives you **one role per user per tenant** (ADR-025). Use `PATCH
/tenants/{id}/users/{uid}/role` to change it (cannot set `owner` — use `PUT
/tenants/{id}/owner` for the explicit handover; cannot demote the last owner).
Since ADR-101 D6, **only the tenant owner may seat a principal at a role that
confers authority** — derived from the permission catalog, never from the name —
so a non-owner holding `users:manage` gets `403 role_owner_only` rather than
being able to promote themselves. The full management surface is in
`sdk/SPEC.md` §6.1–§6.3; domain SSO is claimed through the domains API
(ADR-094), not patched onto the tenant.

Two ways to attach data:

**(a) Inline custom claims on the JWT.** Any non-reserved keys you pass in `POST /auth/login`'s `custom_claims` field land on the token payload directly (e.g. `outlet_ids`, `feature_flags`, `region`). Reserved claim names are **refused**, not silently dropped: sending one in `custom_claims` on `POST /auth/token` returns `400 reserved_claim_key` (ADR-097 D3 — a dropped claim is indistinguishable, from your side, from an honoured one, and once `scope` carries granted authority that difference is a gate that never fires). The reserved set is `iss`, `sub`, `aud`, `iat`, `nbf`, `exp`, `jti`, `azp`, `tenant_id`, `role`, `mfa_at`, `amr`, `scope`, `token_class`. Claims are snapshotted on the session, so refresh re-emits the same set; tenant switch (`POST /auth/token { tenant_id }`, ADR-031/032) clears them because they're tenant-specific. Use this when the data is small, stable-for-the-session, and needs to be available without a DB hop (a per-user list of the outlets or branches they may see is the archetype).

**(b) Partner-side lookup keyed on JWT subject.** Read `tenant_id` + `user_id` off the verified claim, consult your own DB per request. Use this when the data is mutable mid-session (tokens won't reflect changes until next refresh) or too big for a claim.

Do **not** try to stuff extra roles into the RealmID JWT by overriding reserved keys — they'll be stripped. Prefer `scope` over a role LABEL in `custom_claims`: `scope` is re-resolved on every `/auth/token` call and never stored, whereas custom claims are snapshotted onto the session and drift across a long one.

**Role permissions on the RealmID admin surface (ADR-074).** Realm roles carry
a `permissions` array drawn from a closed `resource:action` catalog (`GET
/platforms/{id}/permissions`), and it is **enforced** on the RealmID admin
surface: a non-owner may call an admin endpoint iff their realm role grants the
matching permission. Permissions are resolved from the DB at request time (no
JWT claim), so a grant/revoke applies on the holder's next request. You can no
longer edit these — the set and its grants are RealmID's (ADR-101) — but you can
read them, and `GET /roles` is what tells you what a role in your realm actually
confers.

**Two per-role knobs were retired by ADR-101** and no longer appear on the wire:
`required_mfa_methods` (ADR-075) and `can_invite_roles` (ADR-076 WP4). Zero
realms had ever configured an MFA floor. The invitation scope bounded one of
four paths that seat a user at a role while the other three were unbounded;
ADR-101 D6 now bounds all four with one rule. The **per-realm** and **per-org**
MFA policies are untouched.

## 4.1 User API keys: `permissions_cap` is a cap, **never** a grant (ADR-084)

Your end users can mint API keys (`uk_live_…`) so third-party tools call **your**
API on their behalf. A key is minted through your BFF, is bound to the `users`
row of the person who minted it, and carries a `permissions_cap` — a list of
strings **in your vocabulary**, which RealmID stores and never interprets.
Exchanging the key (`grant_type=user_api_key`) returns an access token shaped
like this:

```json
{ "sub": "<the minting user's id>", "aud": "<your realm>",
  "permissions_cap": ["reports:read"] }
```

### ⚠️ Breaking, ADR-100: you must now STATE the key's authority

`uncapped` is **required** on the mint body, and there is no default:

| `uncapped` | `permissions_cap` | result |
|---|---|---|
| `true` | empty / omitted | all **current and future** permissions of the holder |
| `false` | non-empty | capped to exactly those entries |
| `false` | empty / omitted | `400` |
| `true` | non-empty | `400` — self-contradicting |
| *omitted* | anything | `400 uncapped_required` |

`uncapped: true` also needs the realm's `user_api_keys.allow_uncapped`, which
defaults to **false** (`403 uncapped_not_allowed`).

**Why we broke this.** Until ADR-100, a body of `{"label": "x"}` — the shape
every client produced when the caller named no permissions — minted a key
carrying the holder's **full** authority. The direction was backwards from the
intuition it invited: *"I selected no permissions"* granted everything. That
same shape was also the only way to ask for an unrestricted key on purpose, so
we could not refuse the accident without refusing the intent.

**`uncapped` is forward-inclusive.** It is not a shorthand for "everything this
user can do today" — to freeze today's set, name today's permissions. And do not
render an all-current selection as "All permissions" in your console: it becomes
visually indistinguishable from an uncapped key, which rebuilds the same
confusion one layer up.

You can also now **change a key's cap in place** without re-issuing its secret:
`PUT /tenants/{tid}/users/{uid}/user-api-keys/{id}`, sharing this same write
schema. ⚠️ It is a **PUT: it resets what it omits** — read the key, change the
one field, send the whole shape back. A cap change takes effect at the **next**
token mint; tokens already issued keep their bound until they expire.

**The rule, and the whole of this section:**

> **Effective authority = `permissions_cap` ∩ the user's LIVE permissions in your
> system, re-resolved on every request.**

A cap can only ever *narrow* what the user can already do. It is not a grant, not
a scope, and not a snapshot of anything.

### Get this wrong and the failure is silent

Here is the version most people write if nobody warns them:

```js
// ❌ WRONG — treats the cap as a grant. Do not ship this.
const { permissions_cap } = decodeJwt(token);
if (permissions_cap.includes("reports:read")) return serveReport();
```

It reads fine and it passes every test you are likely to write, because on day
one it returns the right answer. Then:

- **Day 1** — Priya is an admin in your system holding `reports:read`. She mints
  a key capped to `["reports:read"]` for a reporting tool. The tool reads
  reports. Correct.
- **Day 30** — Priya moves off the reporting team. You revoke `reports:read` from
  her **in your database**, which is the only place it has ever existed.
- **Day 31** — the tool presents the same key. The token still says
  `permissions_cap: ["reports:read"]`, because the cap was fixed at mint and
  RealmID never learned about the change — it cannot, it does not know your
  vocabulary or your role model. The check above still passes. **The tool now
  reads reports Priya herself can no longer read.**

No error, no log line, no failed request. The key has simply outlived its
holder's authority, and it will keep working until someone notices.

### The correct version

```js
// ✅ RIGHT — the cap is one operand; your live permissions are the other.
const live = await yourDb.permissionsFor(claims.sub);
if (capAllows(claims, "reports:read", () => live)) return serveReport();
```

On day 31 `live` no longer contains `reports:read`, so the request is denied.
Demote the holder and every key they minted shrinks with them. That is the
property the cap exists to give you, and the intersection is the **required**
integration pattern — not a recommendation.

Our SDKs expose a helper whose signature *forces* the second operand, so the
one-operand version is not expressible:

| language | call |
|---|---|
| Go | `realmid.CapAllows(ctx, claims, "reports:read", resolver) bool` |
| TypeScript | `await capAllows(claims, "reports:read", resolveLive)` |
| Java | `CapCheck.capAllows(claims, "reports:read", resolveLive)` |

Use them. If you decode the JWT yourself, you are responsible for the
intersection, and the wrong version is three lines away.

### Why RealmID cannot do this for you

The second operand — what the user may do *right now* — lives in your database.
RealmID never sees it, under any storage scheme, which is why we deliberately do
**not** store partner permission catalogs (ADR-084 §7.2). We shape-validate the
strings at mint (count and length only) and store them verbatim.

The one exception is keys whose audience is `realmid` itself — those caps are
validated against our own ADR-074 catalog at mint (`400 unknown_permission`) and
we perform the intersection ourselves before every authorization decision. That
does not help you: for a key minted in *your* realm, the enforcement is yours.

### Staleness, and why it always fails closed

- **You shrink a role** ⇒ live resolution shrinks on the next request ⇒ the key
  narrows immediately. This is the point.
- **You rename or delete a permission** while live keys reference it ⇒ the old
  cap string goes **inert** ⇒ the key under-grants. It never over-grants.
- **A role is deleted and recreated broader** ⇒ the key tracks the user's new
  authority **up to the cap**. This is inherent and correct: a cap is not a
  snapshot of the permissions the user held at mint time.

Every failure mode narrows authority. If you ever find one that widens it, that
is a bug — report it.

## 4.2 Route authorization: `scope` on the token (ADR-097)

§4.1 covers keys. This covers **every** authenticated request, which is the far
more common case — and until ADR-097 the SDKs gave you nothing for it, so you
hand-rolled a gate and `capAllows`'s safety property applied on the key path and
nowhere else. (The gate shipped with ADR-097; the way to MINT the claim it reads
did not arrive until go `0.49.0` / ts `0.42.0` / java `0.39.0` — see below.)

**The division of labour, stated once:**

| Owner | Artefact |
|---|---|
| RealmID | identity, attestation, session lifecycle, the token |
| **you** | the route → scope map, and the map from YOUR roles to scopes |
| the SDK | the gate that evaluates one against the other |

You add an endpoint by editing **your repo**. No RealmID call, no config write,
no deploy coupling. RealmID stores no catalog of your scopes and never will.

### Three things that look alike, and are not

You will meet three "lists of permission strings" in this API. Getting them
mixed up is the most common integration mistake, so here they are side by side:

| | RealmID role `permissions` | key `permissions_cap` | token `scope` |
|---|---|---|---|
| Answers | what may my admin do **inside RealmID**? | what is the ceiling on this key? | what may this user do **inside MY product**? |
| Whose words | RealmID's, fixed catalog | **mine** (see below) | **mine** |
| Does RealmID check them? | yes, always | only for `realmid`-audience keys | never — shape only |
| Where's the other half? | n/a | my database, via `capAllows` | my route map |

**`permissions_cap` is the one that shifts.** A key's audience is the realm the
user lives in — you never set it. For a key minted in **your** realm the strings
are yours and we shape-check them only (count and length); we cannot validate
them, because the vocabulary and the second operand both live in your database.
The exception is a key minted in **RealmID's own base realm**, where the
vocabulary is our ADR-074 catalog and we do validate it (`400
unknown_permission`) — that is us being a platform on ourselves, not a rule
about you.

That is also why the scope rename below refuses a `realmid`-audience realm, and
why it never touches role `permissions`.

> **"Your roles" are not RealmID roles — do not reach for `permissions` here.**
> A RealmID custom role's `permissions` array (§4 above) is a closed catalog
> governing the **RealmID admin API**: `users:manage`, `signing_keys:rotate`,
> `platform:config`. It answers "what may my admin do inside RealmID?". A scope
> answers "what may this user do inside **my** product?". Different question,
> different system, different vocabulary — which is also why the scope rename
> below does not touch role permissions. Your role → scope map belongs in your
> database, next to your roles.

### How you get a scoped token

Ask for it on `POST /auth/token`, **from your backend**. Use your SDK:

```go
// Go — go/v0.49.0 and later
mint, err := realm.Auth.Token(ctx, realmid.TokenRequest{
    RefreshToken: rt,
    TenantID:     tenantID,
    Scope:        []string{"orders:read", "orders:write"},
})
```

```ts
// TypeScript — @realm-id/sdk@0.42.0 and later
const mint = await realm.auth.token({
  refreshToken: rt,
  tenantId,
  scope: ["orders:read", "orders:write"],
});
```

```java
// Java — dev.realmid:sdk:0.39.0 and later
TokenResponse mint = realm.auth().token(
        TokenRequest.of(rt, tenantId)
                    .withScope(List.of("orders:read", "orders:write")));
```

> ⚠️ **Before go `0.49.0` / ts `0.42.0` / java `0.39.0`, no SDK could send this
> field at all** — the enforcement half of ADR-097 shipped in all three and the
> mint half in none, so the example below was the only way to reach it. If you
> are pinned below those versions, either upgrade or use the raw call. Reported
> by an integrator; see `CHANGELOG.md`.

Or on the wire directly:

```json
{ "tenant_id": "…", "refresh_token": "…", "scope": "orders:read orders:write" }
```

Space-delimited string on the WIRE, RFC 9068 §2.2.3 (which defines the claim by
reference to RFC 8693 §4.2, in RFC 6749 §3.3 format). **The SDKs take a list and
join it for you**, and refuse an entry that would not survive the join — which is
the whole reason they take a list: a space inside one entry is not an error on
the wire, it splits one scope into two and mints authority you did not ask for.

- **Charset:** printable ASCII minus SPACE, `"` and `\`. Case-sensitive, no
  normalization. A malformed entry is refused (`invalid_scope`) rather than
  reshaped — a space would split one scope into two, silently changing what you
  granted.
- **Bounded** by your realm's `user_api_keys.max_permission_strings` /
  `max_permission_string_len` (32 / 128 by default) — `too_many_scopes`,
  `scope_too_long`.
- **Re-resolved every call.** The claim is never stored on the session. Send it
  each time; omit it and no `scope` is minted.
- **Intersected server-side** when the session came from a user API key: the
  minted claim is `scope ∩ permissions_cap`, exact match, no wildcards. We do
  this so a caller who bypasses the SDK still gets a narrowed token.

> **Why "from your backend" is not a request we are making.** The ADR-041 escort
> runs on `/auth/token` for every refresh class, so a browser cannot reach it
> directly and self-assert a scope. It is structural.

### `role_permissions` — narrowing a key's cap per org (ADR-100)

Send `role_permissions` on `/auth/login` and `/auth/token` and the minted
`permissions_cap` claim becomes `stored_cap ∩ role_permissions`. It is the list
**your** role model says the holder has **in this org**, from your own
role → permission map — RealmID stores no partner catalog and will not resolve
it for you.

- **Optional.** Omit it and the stored cap travels unnarrowed, which is exactly
  the pre-ADR-100 behaviour, so nothing you have today breaks.
- **Safe to assert.** `A ∩ B ⊆ A` for every `B`, so a wrong or hostile list can
  only NARROW, never widen past the stored cap. We audit it as caller-asserted
  and unverified, and that is why we can accept it at all.
- **Send it on refresh too.** A user-API-key session IS refreshable, and a
  refresh that omits the list comes back **wider** than the token it replaced —
  silently, and on a schedule.
- **Ignored for an uncapped key**, whose claim stays absent whatever you send.
- ⚠️ **An empty intersection is `403 no_permissions_in_org`, never an empty
  claim.** The narrowing is per-org, so the same key mints in one org and is
  refused in another; the error names the org.

**Retiring a scope needs no API call.** `POST /platforms/{id}/scopes/remove` is
**deleted** (ADR-100 D10). Stop emitting the string in `role_permissions`, map
no route to it, and a stale entry in a stored cap never survives the
intersection again. `/scopes/rename` stays — that is the one you cannot do by
hand.

### Get this wrong and the failure is silent — again

The mistake here is not the same as §4.1's, and it is easier to make:

```js
// ❌ WRONG — a default that lets a route through.
function requireScope(req, needed) {
  const scopes = (req.claims.scope ?? "").split(" ");
  if (needed.length === 0) return true;          // "no policy? fine."
  return needed.some((s) => scopes.includes(s)); // any-of, silently
}
```

Two defects, both of which pass every test you would think to write:

- **`needed.length === 0` returns true.** Add an endpoint, forget to add it to
  the map, and it is *open* — to anyone with any token at all. Nothing errors,
  nothing logs. The map's silence became a grant.
- **`some` instead of `every`.** You write
  `requireScope(req, ["orders:read", "orders:write"])` meaning both, and get
  through on either. Half the evidence you asked for.

### The correct version

```js
// ✅ RIGHT — default DENY, all-of unless you say otherwise.
import { decideScope, validateScopePolicy } from "@realm-id/sdk";

const POLICY = [
  { path: "/health", public: true },                            // SAID, not assumed
  { path: "/orders/*/export", scopes: ["orders:export"] },      // specific first
  { path: "/orders/**", method: "GET", scopes: ["orders:read"] },
  { path: "/orders/**", scopes: ["orders:write", "orders:read"] }, // ALL of them
  { path: "/reports/**", scopes: ["r:a", "r:b"], anyOf: true },   // any-of, named
];

for (const e of validateScopePolicy(POLICY)) throw new Error(e.message); // at boot
app.use(createScopeMiddleware(POLICY));
```

**Default deny** is the property, and `public: true` is the price of it:
"unauthenticated" is something you SAY, never something you get by forgetting.
**First match wins**, so a specific rule goes before the general one it narrows.
**`validate()` at boot** catches a scope RealmID would refuse to mint — which
would otherwise present as a route no token can ever satisfy.

| language | layer 1 | layer 2 | layer 3 |
|---|---|---|---|
| Go | `realmid.ScopeAllows(claims, …)` | `ScopePolicy{…}.Compile()` | `.Middleware(…)` — `net/http` |
| TypeScript | `scopeAllows(claims, …)` | `decideScope(policy, …)` | `createScopeMiddleware` · `fastifyScopeHook` |
| Java | `Scopes.scopeAllows(claims, …)` | `ScopePolicy.of(…)` | `ScopeFilter` (servlet — works in Spring unchanged) |

There is no Gin / Echo / Fiber / Spring-native adapter, deliberately: these SDKs
take zero external dependencies, and importing a framework would put it in
everybody's tree including the people who do not use it. SPEC §11.5 has the
three-line snippet for any framework.

### `scope` or `capAllows`? Decide per operation.

They trade different things, and mixing them without deciding gets you the worst
of both.

| | token scope | `capAllows` (§4.1) |
|---|---|---|
| per-request I/O | none | one live read |
| revocation lag | your realm's `access_ttl_seconds` (1–86400) | **zero** |

**Token scope by default. `capAllows` for operations where a stale grant is
unacceptable** — money movement, permission administration, data export.

`capAllows` is **not** deprecated and is not going away. Token-carried scope
turns zero-lag revocation from *impossible* into *bounded*; it does not replace
it. Set `access_ttl_seconds` to the lag you can accept, and say what that number
is out loud when you pick it.

### Renaming a scope

`POST /platforms/{id}/scopes/rename` (realm owner) rewrites one of your scope
strings across every user API key cap in the realm, in one transaction:
idempotent, deduping on collision, `?dry_run=true` for the counts.

**Preview first.** It is not reversible in general — where a key held both
`from` and `to`, the merge destroys what a reversal would need. Removal is not
offered at all; it needs its own confirmation design and does not have one yet.

`realm_roles.permissions` is not touched: that column is validated against
RealmID's own catalog on every write, so it holds *our* vocabulary rather than
yours, and renaming there would rewrite an enforced permission.

### One thing that changed for you: minting a user API key is now BFF-only

`POST /tenants/{tid}/users/{uid}/user-api-keys` requires a **platform bearer**
in `Authorization` carrying the user's access JWT in `X-User-Token` — the same
ADR-050 shape as the rest of the partner-mediated surface. A bare user token
answers `401 wrong_scope`, and a platform bearer from a different realm answers
`403 realm_mismatch`.

`GET` and `DELETE` on that collection are **unchanged**. Creating a long-lived
credential is the operation that must be mediated by a confidential backend;
reading and revoking one you already hold is not.

## 5. Sessions, logout, MFA

- **Sessions:** one RealmID session per login. Concurrent session limits configurable per realm (design.md §Session Management).
- **Logout:** call SDK `Logout(ctx, sessionID)`. Revokes in DB + Redis immediately.
- **MFA at login:** configurable per realm/tenant, delegated to the provider when it supports it natively (Firebase, Google); otherwise handled by RealmID TOTP (ADR-008).
- **First-login MFA self-enrollment (ADR-061):** when a user logs into an MFA-required tenant with no factor yet, `/auth/login` returns `412 mfa_registration_required` with an `mfa_challenge_token` and `tenant_id`. The user (via your BFF) enrolls a TOTP factor through **`POST /auth/mfa/enroll`** — this is **refresh-authed** (the request carries the login session's `refreshToken` + `tenant_id`), so the **same** endpoint serves first-login enrollment *and* a logged-in user switching into an MFA-required tenant. The enroll response returns `{ secret, qr_url, recovery_codes, mfa_challenge_token, tenant_id }`; complete it by passing the **enroll-scoped** `mfa_challenge_token` to **`POST /auth/mfa/verify`** — a single verify both confirms the new secret and mints the token pair. There is **no** `/auth/mfa/confirm` step (it was removed in ADR-061; confirmation folds into verify). SDK: `selfEnrollMfa` (SPEC §4.8). **Note:** `recovery_codes` ARE redeemable — `POST /auth/mfa/recovery` (ADR-077 §2), and `POST /auth/mfa/recovery/regenerate` rotates them. This bullet used to say they were "not yet redeemable"; that stopped being true when the redeem path shipped.
- **MFA freshness model (SPEC §10.4):** access tokens carry an `mfa_at` claim — the unix-seconds timestamp of the user's most recent successful MFA verify. SDK middleware reads `mfa_at` and enforces a per-route freshness window (`maxAgeSeconds` or `requireFresh`); on miss it returns `412 mfa_required` with a sibling `mfa_challenge_token`. The realm-wide default window lives at `realms.config.mfa_session_ttl_seconds` (default 900s). When fresh MFA is needed mid-session, partners call `POST /auth/mfa/challenge` (bearer = current access token) to mint a step-up challenge, then `POST /auth/mfa/verify` to complete it — verify returns a freshly-minted access + refresh pair carrying the new `mfa_at`. Full contract in [SDK SPEC §10.4](../../sdk/SPEC.md).

### 5.1 Operation step-up MFA — implementing it WITHOUT our SDK (ADR-096)

If you use one of our SDKs, `realm.middleware({ mfaProtectedPaths })` does all of
this for you and you can skip to §6. This subsection is the contract for a
backend that talks to `auth.realmid.dev` over plain HTTP.

**Read this first: the `412` is YOURS to emit, not ours.** RealmID stores no list
of which of your operations need a step-up (ADR-096 D2) — your routes are not
ours to enumerate. Your backend decides, and `mfa_required` / `stale_mfa` /
`fresh_required` are codes *your* backend returns to *your* client. What RealmID
supplies is exactly two things: the `mfa_at` claim on every access token, and the
challenge/verify pair that refreshes it. Nothing more.

(The issuer does run a small internal registry of MFA-protected routes, but only
for RealmID's own auth-surface operations — e.g. rotating recovery codes — where
RI is the enforcing party. It is not a backstop for your policy and cannot be.)

**The `mfa_at` claim.** Every access token carries `mfa_at`: unix seconds of the
user's most recent successful MFA verify. It is absent (or zero) when the user
has never completed one on this session.

**The rule people get wrong: MFA proof is per `(session, tenant)` (ADR-059).**
A proof completed while the user was acting in tenant A does **not** carry into
tenant B, and a new session starts with no proof. So compare `mfa_at` from *the
token in front of you* — never cache "this user did MFA at T" against the user id.
Two concrete consequences:

- After a tenant switch (`POST /auth/token` with a new `tenant_id`), re-read
  `mfa_at`. Assuming it survived is the most common hand-rolled bug.
- After a step-up verify, the tokens you get back are scoped to a tenant. Make
  sure it is the tenant the user was operating in, or your retry will fail the
  same gate again and the user sees an endless prompt.

**The freshness comparison**, per protected operation:

```
window  = the operation's max age in seconds
          (a "prove it again right now" operation uses ~30s;
           the realm default lives at realms.config.mfa_session_ttl_seconds,
           validated 60–86400, suggested 900)

if mfa_at is absent      -> step up, reason "no_mfa"
if now - mfa_at > window -> step up, reason "stale_mfa" (or "fresh_required")
otherwise                -> allow
```

**The step-up sequence.**

1. `POST /auth/mfa/challenge` — bearer is the user's *current* access token.
   Returns `{ mfa_challenge_token, tenant_id }`. Hand it to your client along
   with your own `412`.
2. Your client collects the TOTP code and calls
   `POST /auth/mfa/verify` with `{ mfa_challenge_token, code }`.
3. Verify returns a **fresh access + refresh pair** carrying the new `mfa_at`
   (plus `tenant_id`, `expires_in`, `refresh_exp`). **Adopt them before you
   retry** — the old pair is not upgraded in place, and on some paths the old
   session bearer is rotated away.
4. Retry the original operation **once**. Bound it: a retry loop against a gate
   the user cannot satisfy is an infinite prompt, not a security control.

**If the user has no enrollment**, `/auth/mfa/challenge` and the login path both
answer `412 mfa_registration_required` with an **enroll-scoped**
`mfa_challenge_token`. Route that to `POST /auth/mfa/enroll` (see the bullet
above) rather than to a code prompt — there is nothing to verify against yet.

**If the principal is a service account**, it is refused outright: a plain `412`
with **no** `mfa_challenge_token`. A bot has no human to hold an authenticator,
so handing it a challenge would be an invitation to a step-up it can never
complete (ADR-096 D4). Design M2M paths so they do not need one.

**Which operations to protect.** Our own rule (ADR-096 D6): an operation earns a
step-up when it is **irreversible** or **credential-affecting**. A rule outlives
a list — a list has to be revisited every time you add a route.


## 6. SDK methods you will actually call

From your partner API (holding a Service JWT obtained via API key at startup). The Go SDK exposes two top-level constructs:

### `realmid.Client` — calls RealmID from your backend

| Method | When |
| --- | --- |
| `AuthenticateUser(AuthenticateUserInput{Method, ProviderToken, Origin, MFAProof, CustomClaims})` | User login. `CustomClaims` is inlined into the issued JWT (§4 option a). |
| `Refresh(refreshToken)` | Refresh flow. Re-emits the original custom claims. |
| `Logout(refreshToken, all)` | Revoke current session; `all=true` kills every session for the user. |
| `Introspect(accessToken)` | `{active, revoked, jti, user_id, tenant_id}` — use for tighter-than-TTL revocation checks on high-privilege endpoints. |

### `realmid.Verifier` — validates incoming tokens on every request

| Option | Effect |
| --- | --- |
| `BaseURL`, `Audience` | Required. The verifier fetches JWKS from `BaseURL/{realmID}/.well-known/jwks.json` and checks `iss`-prefix + `aud`. |
| `StaticKeys: map[realmID]*signer.Keyring` | In-process keyring bypass — no HTTP fetch. Used by tests through `testsupport/issuer` (see [issuer README](../testsupport/issuer/README.md)). |
| `RevocationChecker` | Called after the stateless JWT check. Return `active=false` → Verify fails with `ErrRevoked`. Wire this to `Client.Introspect` when you want per-request revocation enforcement. |
| `CacheTTL`, `Leeway`, `Now` | JWKS cache lifetime, clock skew, time hook. |

> **Audience auto-discovery (ADR-064, issuer v0.14.0+).** If you call
> `Verify(ctx, token, nil)` without an explicit audience, the verifier reads the
> realm's audience from `Info().Audience` — which is now **always** populated with
> the intrinsic `realmid:<platform_ref>` (set at platform creation, backfilled for
> existing realms via migration `1780531200`). The pre-ADR-064 `→ Domain` fallback
> is **deleted** (`sdk/go/verifier.go`), so the empty-audience footgun on older
> SDKs is gone *by design* — the domain no longer participates in `aud` at all.
> Upgrade to `go/v0.19.0+` and confirm your realm carries an `audience` (it does on
> any realm running issuer v0.14.0+).

### Acting on behalf of a user (`X-User-Token`, ADR-056)

Your backend usually calls RealmID as *itself* — the platform principal. When a
call should instead authorize as **the signed-in user** (their tenant, their
role, their permissions), stash the user's verified access JWT on the context and
the Go SDK forwards it as `X-User-Token` alongside your platform bearer:

```go
realm, _ := realmid.NewRealm(cfg)             // the SDK handle

ctx = realmid.WithUserToken(ctx, userAccessJWT)
t, err := realm.Tenants.Get(ctx, tenantID)    // authorizes as the USER
```

Your platform token stays the wire bearer — this is **additive**, not a swap.

| Surface | Forwards `X-User-Token`? |
| --- | --- |
| Go — typed methods (`Tenants.*`, `Origins.*`, `Auth.*`) | **Yes**, since `go/v0.37.0` |
| Go — `Realm.Do` (raw escape hatch) | Yes |
| TypeScript, Java | **Not yet** — hand-roll the header, or call via `Do`-equivalent |

> **The bare `X-On-Behalf-Of-User` header is no longer an identity (issuer
> `v0.66.0`, SECURITY).** It used to be accepted as an on-behalf assertion, which
> let any holder of a realm's platform API key act as *any user in that realm*.
> Only the signed, verified `X-User-Token` asserts an identity now; a bare user id
> gets **`401 x_user_token_required`**, refused before any lookup so it can't be
> used as an existence oracle. The header survives only as a **domain parameter**
> on `POST /auth/otp/verify` (naming the OTP subject), never as authentication.
> If you are still sending the bare header on any other route, that call is
> already failing — switch to `X-User-Token`.

### Not-yet-in-SDK (call over HTTP)

`ListTenants`, `ListUsers`, `InviteUser`, `SetUserStatus`, cross-platform authorizations — on the HTTP surface; SDK wrappers are on the roadmap. (MFA *is* now wrapped: self-service `selfEnrollMfa` / `disableMfa` and the admin `tenants.users.{enrollMfa,confirmMfa,resetMfa}` surface — SPEC §4.8 / §6.2.)

> **Success-status convention (ADR-069).** If you call the HTTP surface
> directly, **accept the whole `2xx` class** — never hardcode `== 200`. RealmID
> uses a uniform `200` `{data:...}` envelope: every endpoint returns `200` on
> success, including all DELETEs (which carry a `{status:...}` body), EXCEPT
> genuine resource-creation POSTs (`POST /platforms`, `/identity-providers`,
> `/platforms/{id}/{api-keys,roles,origins,federation-bindings}`,
> `/platforms/{pid}/tenants`, and the invitation creates), which return
> `201 Created`. The RealmID SDKs already treat `2xx` as success, so this only
> matters for raw-HTTP integrations.

> **Invite identifier validation is format-only.** `InviteUser` classifies the
> identifier syntactically (email = contains `@`, phone = starts with `+`) and
> inserts it into `user_contacts`. There is **no** MX lookup, SMTP probe, or DNS
> reachability check — so a non-deliverable synthetic address (e.g.
> `sync-bot-<uuid>@sync.example.com`) **is accepted**. Caveat: an admin-invited
> contact is inserted `verified_at = NULL` and (per ADR-042) only flips to verified
> on a successful IdP login that asserts that same contact. A synthetic address that
> never logs in **holds the tenant-uniqueness slot but the user stays
> `status='invited'` and the contact stays unverified, indefinitely.** Do not
> use synthetic-address invites for machine principals — use **service
> accounts** (below) or pure M2M auth (`platform_api_key` / WIF).

### Service accounts (ADR-071)

For a headless/service principal that needs a real user row (a session,
a role, audit attribution), provision a first-class **service account**
(`users.kind='service'`) instead of inviting a synthetic address:

- **Provisioning** — `POST /tenants/{id}/service-accounts` (tenant
  owner/admin). The account is active-from-birth (no invite expiry, so
  the invite reaper never touches it), holds a unique email-shaped
  *handle* (not a mailbox), and takes any role except
  `owner`/`platform_api`.
- **Kind ↔ method invariant** — a `kind=service` account may
  authenticate **only** via a `view_bff`-delivery OTP
  (`grant_type=otp`); a human may **never** log in via that path. This
  is a fixed system invariant, enforced at the `Login()` chokepoint.
- **`view_bff` OTP flow** — issuing the login OTP with
  `delivery_mode=view_bff` returns the plaintext to your backend/BFF
  (show-once) instead of delivering it anywhere; the service account
  presents it via the OTP login grant.
- **Lifecycle** — `POST /tenants/{id}/service-accounts/{said}/suspend`
  / `unsuspend` / `revoke` / `reset-handle` / `deactivate`, plus
  list/get.
- **Sessions** — a service-account session is **class `service`**
  (`subject_type=service` on the wire) with its own refresh-TTL clamp
  and scheduled-cutoff behavior, and is attributed to the minting human
  via `initiated_by_user_id` for audit.

### OTP primitive for action-gated MFA (ADR-027)

> **Status (v0.6.0, 2026-05-08):** Shipped. Three HTTP routes plus
> two login integrations are live. Authoritative reference:
> `docs/proposals/partner-otp-primitive.md`. SDK surface is in
> `sdk/SPEC.md §OTP primitive`.

The OTP primitive lets one user (a manager) mint a short-lived
six-digit code and another user (an SA, a delivery agent, an
approver) consume it, with RealmID owning the hash, the consume,
and the audit trail. Three HTTP routes:

- `POST /auth/otp/issue { subject_ref, purpose }` — mint.
- `GET  /auth/otp/{id}` — re-display plaintext (issuer-scoped, until TTL).
- `POST /auth/otp/verify { subject_ref, purpose, presented }` —
  hash-match, consume, return the issuer for partner audit.

`subject_ref` and `purpose` are opaque to RealmID. Choose your own
namespace (`"user:<uuid>"`, `"booking:<uuid>"`, `"login"`,
`"delivery"`, …). RealmID enforces tenant isolation, lockout
(5 fails / 15 min per `(tenant, subject_ref, purpose)`), and the
audit envelope; **partner enforces hierarchy / role checks before
calling issue.**

#### Step-up auth & delegated login

The same primitive plugs into login as either a single factor or a
second factor. Both are realm-config gated.

**Two-factor (`realms.config.otp_mfa_enabled = true`).** Manager
issues an OTP after the SA's first-factor login fails open with
`mfa_required`:

```go
// Go SDK
sess, err := client.Auth.Login(ctx, realmid.LoginRequest{
    Method: "google", Token: googleIDToken,
})
// err is RealmError with code "mfa_required" + Details["mfa_challenge_token"]
// (manager-side) issue a login OTP for the SA
otp, err := client.OTP.Issue(ctx, tenantID, realmid.OTPIssueRequest{
    SubjectRef: "user:" + saUserID, Purpose: "login",
})
// (SA-side) complete the second factor
sess, err = client.Auth.MFAVerifyOTP(ctx, realmid.MFAVerifyOTPRequest{
    MFAToken: mfaChallengeToken, Presented: otp.Value,
})
```

```ts
// TS SDK
try {
  await realm.auth.login({ method: "google", token: googleIdToken });
} catch (e) {
  if (e instanceof RealmError && e.code === "mfa_required") {
    const mfaToken = String(e.details?.mfa_challenge_token);
    // (manager) issue
    const otp = await realm.otp.issue({ subjectRef: `user:${saUserId}`, purpose: "login" });
    // (SA) verify
    const session = await realm.auth.mfaVerifyOtp({ mfaToken, presented: otp.value });
  }
}
```

**Single-factor (`realms.config.otp_login_enabled = true`).** SA
types phone (or email) + the manager-issued code; no federated
provider:

```go
sess, err := client.Auth.OTPLogin(ctx, realmid.OTPLoginRequest{
    RealmID: realmID, Identifier: "+919999000011", Presented: otp.Value,
})
```

```ts
const session = await realm.auth.otpLogin({
  realmId,
  identifier: "+919999000011",
  presented: otp.value,
});
```

> **Wire note (raw HTTP):** the OTP login grant is
> `grant_type=otp` (ADR-071). The earlier internal name
> `otp_internal` was **removed with no dual-accept window** — update
> any raw-HTTP caller; the SDKs already send `otp`.

**Apps & sources (ADR-072).** Login eligibility is two intersected
mappings. Mapping-1 is the fixed kind↔method invariant above (service
accounts only via `view_bff` OTP; humans never). Mapping-2 is
platform-owned config: your realm's **`sources`** registry maps each
registered app to its allowed login methods, and a `client_id` is
accepted for a method **only if its source lists that method** (an app
with no source registration, legacy empty `app_id`, is unrestricted).
Additionally, once a provider has ≥1 app-bound `client_id`
registration, that provider flips into **hard allow-list** mode — only
the registered `client_id`s are accepted for it. Configure both in the
console's "Apps & sources" pane. Firebase remains project-coarse (no
per-app restriction).

For non-login step-up gates (delivery confirmation, payout approval,
…), use `OTP.Verify` directly with your own `subject_ref` /
`purpose`. The verify response carries `issuer_user_id` so the
partner-side audit log can record the gating actor without a join
back into RealmID.

The SPA / mobile client only talks to your partner API. It never
holds a RealmID API key and never calls RealmID directly except via
your API's proxying.

## 6.4 Provisioning your realm: credentials & the admin write-surface

Before §6.5, the thing that actually unblocks provisioning: **which
credential manages which part of your realm.** Partners (and RI
operators driving the CLI) hit this hard — there are **two** auth
guards on the `/platforms/{id}/...` admin surface, and they take
*different* credentials.

### Key class is derived from the bound bot user — not from `scope`

`POST /platforms/{id}/api-keys` mints a key whose **class** is decided
**solely by the role of the bot user it binds to**:

- binds to a user with role **`platform_api`** → **platform-class** key
  → exchanges at `/auth/login` with `grant_type=platform_api_key` →
  yields a `scope=platform` session.
- binds to **any other** user (a human owner, a `service` bot) →
  **service-class** key → `grant_type=api_key` → `scope=service`
  session.

The `scope` field on the create request (`--field scope=platform`) is
**cosmetic** — it's stored and echoed but the class check
(`isPlatformKey`) ignores it. Setting `scope=platform` does **not**
upgrade a service key. (This footgun is tracked for fix.)

How binding is chosen:

```bash
# No user_id → defaults to the realm's platform_api bot user → PLATFORM-class.
realm-id api-keys create --platform <realm-id> --field label=provisioning
# Explicit user_id → binds to THAT user (a human owner → service-class).
realm-id api-keys create --platform <realm-id> --field user_id=<bot-user-id>
```

**Revoking a key.** Keys are soft-revoked via
`DELETE /platforms/{id}/api-keys/{keyId}` (CLI: `realm-id api-keys
delete --platform <realm-id> --keyId <key-id>`). After revoke, both
`grant_type=api_key` and `grant_type=platform_api_key` exchanges for
that key return `401 revoked_api_key`. Use this to clean up any
service-class keys minted while sorting out the bot-user/class issue
above.

> ⚠️ The create response **always echoes `"scope":"service"`** regardless
> of the real class — ignore it. Confirm the real class by exchanging the
> key: `POST /auth/login {grant_type:"platform_api_key", api_key:"…"}`
> returning `200` + `subject_type:"platform"` means it's platform-class.

> **ADR-089 (issuer `v0.68.0`): the exchange returns NO `refresh_token`.**
> A platform / service / WIF login yields `{access_token, expires_in}` and
> nothing else — the credential you already hold *is* the way to get
> another token, so cache the access token and call `/auth/login` again
> shortly before it expires (default 5 min). Do **not** call
> `/auth/token` for this identity; it answers `401
> m2m_refresh_withdrawn`. If your client code requires `refresh_token` to
> be present in the response it will fail on the first call — the
> official SDKs handle this from go `0.40.0` / ts `0.31.0` / java
> `0.29.0`. The upside is that revoking a key or a federation binding now
> takes effect on the caller's very next acquisition, with no window.

### Prerequisite: your realm needs a `platform_api` bot user

The default-binding above only works if the realm **has** a
`platform_api` bot user. That user is provisioned automatically inside
`POST /platforms` (self-serve onboarding) — so any realm you create the
normal way already has it. **But a realm provisioned outside that path
(e.g. an early/partially-bootstrapped realm) may lack it**, and then:

- `api-keys create` with no `user_id` → **`400 no_default_bot_user`**
  ("realm has no platform_api bot user; pass user_id explicitly").
- passing a human owner's `user_id` succeeds but yields a
  **service-class** key — which `grant_type=platform_api_key` rejects
  with `key_class_mismatch`, and which `origins`/`domains` then reject
  for `wrong_scope`.

There is **no self-serve call** to backfill the bot user — it's an
**RI-side operation** (operator-runbook → "ensure platform_api bot
user", an idempotent repair job). If you hit `no_default_bot_user`,
ask RI to run it for your realm; once it exists you mint the platform
key yourself.

### Two guards: platform token vs owner user JWT

The **entire** `/platforms/{id}/...` admin surface — `roles`,
`identity-providers`, `federation-bindings`, `api-keys`, realm config,
**and `origins`/`domains`** — is guarded by `requireRealmAdmin`, which
accepts **either** credential for the target realm (ADR-047 amendment,
2026-06-29):

| Credential | How you present it |
| --- | --- |
| the realm's **owner user JWT** | directly, or through the BFF on-behalf passthrough (also the RI-staff cross-realm path) |
| a **realm-scoped platform token** (`scope=platform`, realm-matched) | exchange your realm's platform api-key / WIF, then bear it directly against `auth.realmid.dev` |

So you can provision a whole realm with **one** credential — either an
owner session (e.g. the CLI/BFF) or your realm's platform token driven
directly against the issuer. A platform token for a *different* realm is
still rejected.

> **History (why older runbooks split this).** Before the amendment,
> `origins`/`domains` required a realm-scoped platform token while the
> rest required the owner JWT — so an owner session got `realm_mismatch`
> on origins, and a platform token got `not a realm admin` on
> roles/IdP/federation. If you see that in an older runbook, it's stale;
> both now accept either credential. Partner-mediation still applies to
> **login + IdP discovery** (`/auth/login`, the public discovery GET),
> which remain platform-token-only. See `write-surface.md` for the
> authoritative per-endpoint guard map.

### 6.4.1 API key lifecycle: your key EXPIRES — plan the rotation

> **Read this if you use a static `rk_live_…` key.** As of issuer `v0.61.0`
> (ADR-085 §3) a platform api-key **expires by default**. A permanent key must
> be asked for explicitly, and your realm is allowed at most one. If you mint a
> key and do nothing else, it stops working — and every call your backend makes
> to RealmID fails with it.

#### What you get when you mint

`POST /platforms/{id}/api-keys` accepts:

| Field | Meaning |
| --- | --- |
| `label` | free text; the **only** handle you get on a key — the plaintext is echoed once and never again, and `prefix` is hash-derived. Name it for where it is deployed. |
| `ttl_seconds` | lifetime. Omit it and you get the built-in default of **90 days**. Minimum 300. |
| `non_expiring` | `true` for a permanent key. Mutually exclusive with `ttl_seconds`. |

The response carries `expires_at` (unix seconds, `null` if permanent), and so
does every row from `GET /platforms/{id}/api-keys`. **That list is your source
of truth for when your credential dies** — there is no email, no webhook, and no
console warning today. If you want a deadline alarm, build it off that field.

#### Two caps you will hit during rotation (ADR-085 §2)

Per realm, counting only **usable** keys (revoked and expired rows free their
slot immediately):

- at most **2 active** platform keys → `409 too_many_api_keys`
- at most **1 non-expiring** platform key → `400 non_expiring_not_allowed`

The second one is the trap. If your current key is the permanent one, minting a
second permanent key is **refused** — so the replacement you mint during a
rotation must be an *expiring* key. Plan for that rather than discovering it
mid-rotation.

#### Who may mint — and who deliberately may NOT

`platform_api_keys:manage` on the realm. Use **one of these two**:

1. **A WIF-bootstrapped platform session** (ADR-057) — ambient workload
   identity, no stored secret. This is the recommended automated path; see
   below.
2. **An owner / admin user JWT** holding `platform_api_keys:manage` — a human.

> ### ⚠️ Do NOT build rotation on "the old key mints the new key"
>
> It is tempting to exchange your current `rk_live_…` for a platform token and
> use that to mint the replacement — no human, fully headless. **Do not design
> for this, and do not rely on it continuing to work.**
>
> A credential that can mint its own successor **defeats revocation**. If your
> key leaks, the attacker mints a fresh key with a fresh lifetime; you then
> revoke the key you know about and the attacker's key survives, indefinitely,
> through as many successors as they like. Your containment step contains
> nothing, and — because a self-minted key is indistinguishable from a
> legitimately rotated one — you have no signal that it happened.
>
> This is the same failure shape ADR-089 removed elsewhere in RealmID: a
> credential-bootstrapped session used to receive a refresh token that outlived
> revocation of the credential behind it. The rule there is the rule here — **a
> credential you can present again must not also be able to renew itself.**
>
> **A leaked platform key must be a dead end:** it can do the job it was minted
> for, and revoking it ends that, completely. Rotation authority belongs to an
> identity that is *not* the thing being rotated.
>
> **Enforced since issuer `v0.70.0`.** A platform token bootstrapped from an
> `rk_live_…` key is refused at the mint with
> `403 api_key_cannot_mint_api_key`. WIF-bootstrapped sessions and human logins
> are unaffected. If you had automation relying on the old behaviour, move it to
> one of the two credentials above — the WIF channel below is the drop-in.

#### The rotation sequence

Never revoke first — a revoked key is gone and its replacement is not yet
deployed. Always overlap:

```
1. MINT      POST /platforms/{id}/api-keys   {label, ttl_seconds}
             -> capture `value` (shown exactly once) and `expires_at`
2. DEPLOY    write `value` into your secret store; roll your workload so it
             actually picks the new value up
3. VERIFY    make one real authenticated call with the new credential and
             assert it succeeds
4. RETIRE    DELETE /platforms/{id}/api-keys/{oldKeyId}
```

Steps 3 and 4 are not optional and their order is the whole point. **Skipping
step 4 is the failure we shipped ourselves**: our own rotation printed a
"revoke the old key manually" reminder that nobody performed, across five
rotations spanning three months, so "rotating" only ever *added* credentials.
Five full-power keys stayed live and nothing alerted. If your rotation does not
end with a revoke, it is not a rotation.

Via the CLI, the same four steps:

```bash
realm-id api-keys create --platform plt_abc --field label='prod-backend'
# ...deploy the returned value, roll the workload, verify...
realm-id api-keys revoke --platform plt_abc --keyId ak_OLD
```

#### Choosing a TTL and a cadence

Rotate on a **schedule strictly shorter than the TTL**, so a single missed run
is survivable instead of an outage. A 90-day key rotated every 60 days leaves a
30-day margin — one failed run is a warning, not a page. Rotating on the day of
expiry gives you zero margin, and rotating "when we remember" is how the
three-month drift above happened.

#### Recommended: use WIF as the *rotation channel* for your static key

If your workload can't use WIF everywhere — some runtimes can't, and some
partner systems need a literal string to inject — you can still use WIF for the
**one** call that mints the replacement. This is the answer to "then what
rotates the key, if not the key itself", and it is available today with no
extra setup beyond registering a binding:

```
WIF binding  ──(ambient OIDC, never expires, nothing stored)──►  platform token
                                                                      │
                                                    POST /platforms/{id}/api-keys
                                                                      ▼
                                                        fresh rk_live_… (expiring)
                                                                      │
                                              your secret store / config system
```

A federated login mints the **same** `class=platform`, `scope=platform` session
a static key does, and that session already carries realm-admin authority over
its own realm — so it can mint and revoke keys with no additional grant. The
practical effect:

- **The rotating identity is not a stealable secret.** Nothing in your secret
  store can be lifted to impersonate it, so the leak-mints-successor problem
  above cannot arise: a stolen `rk_live_…` still cannot renew itself.
- **It never expires**, because it is not a credential — it is your workload's
  own identity. So rotation cannot lock itself out, however long the static key
  has been dead.
- **The static key stays short-lived**, which is what you want anyway.
- **Distributing the new key inside your own systems is entirely your call** —
  RealmID's involvement ends when it returns the value.

> ⚠️ **Size the blast radius honestly: a WIF session is realm-admin, and you
> cannot currently narrow it.** Every federated login mints `scope=platform`,
> and `authorizeRealmPermission` short-circuits to implicit-all on
> `scope == "platform" && realm matches` **before** it consults the principal's
> role. So a binding's `mapped_role` does **not** restrict what the session can
> do on its own realm — pointing the binding at a `kind=service` principal
> holding only `platform_api_keys:manage` yields exactly the same authority as
> pointing it at the default bot.
>
> Practically: whoever can trigger the workflow holding that binding can
> administer your whole realm, not just rotate keys. Constrain it on the
> **claim** side instead, which does work — pin `repository`, and additionally
> `workflow_ref`, `environment` or `ref` so only one workflow on one branch can
> present it.
>
> A per-binding permission ceiling is a real gap, tracked on our side. Until it
> exists, treat a WIF binding as equivalent to a platform api-key in power and
> better only in *handling*: nothing at rest to steal, nothing to expire, and
> revocation is deleting the binding rather than hunting a copied string.

#### Or: don't have a key at all

If your workload runs on GCP (Cloud Run / GKE / GCE) or GitHub Actions, **WIF
removes this entire section** — there is no secret to store, expire, or rotate,
and the chicken-and-egg above cannot occur because your identity is ambient.
See §6.5 immediately below. If you are reading this because rotation is
annoying, that is the actual fix.

#### End-user API keys (`uk_live_…`) expire too — but by a different rule

ADR-084 end-user keys are governed by **per-realm policy** under
`realms.config.user_api_keys`, not the 90-day platform default:

| Knob | Effect |
| --- | --- |
| `default_ttl_seconds` | applied when the caller omits `ttl_seconds` |
| `max_ttl_seconds` | ceiling — exceeding it is `400 ttl_exceeds_max`; a default above the max is silently clamped down |
| `allow_non_expiring` | a non-expiring user key requires this on, else `400 non_expiring_not_allowed` |
| `allow_uncapped` | `uncapped: true` requires this on, else `403 uncapped_not_allowed`. Same argument as the row above, one word changed: an **unrestricted** user credential should be a conscious realm-level decision, not what you get by omitting a field |

So you set the lifetime policy for your users' keys; RealmID sets it for your
platform key. Both expire by default. Neither sends a reminder.

## 6.5 Workload Identity Federation (keyless M2M)

> **Status (ADR-057): shipped.** Backend, swagger, and all three SDKs
> are live; the credential-source API symbols below are stable. Released
> for Go (`go/v0.18.0`) and TS (`ts-v0.15.0`); the Java lockstep tag
> (`java-v0.11.0`) is still pending, so Java consumers track `main`.

### When to use it vs a static `rk_live_` API key

Workload Identity Federation lets a partner workload authenticate to
RealmID with the **ambient OIDC token it already has** — its GCP
service-account identity token (Cloud Run / GKE / GCE) or its GitHub
Actions OIDC token — **instead of a stored `rk_live_…` key**. There is
no long-lived secret to provision, inject, store, or rotate; the
trust is a registered binding, not a copied string.

| | Static API key | Workload identity federation |
| --- | --- | --- |
| Secret at rest | `rk_live_…` in your secret manager | **none** |
| Rotation | you rotate the key | nothing to rotate |
| Where it works | anywhere | GCP Cloud Run/GKE/GCE + GitHub Actions workloads |
| Setup | mint a key | register a binding keyed on a workload claim |

Both paths bootstrap the **same** `class="platform"` session — the one
pinned to your realm's `platform_api` bot user. Everything downstream
(the SDK auto-attaching the platform JWT, the admin surface you can
call) is identical. Federation only changes how the SDK obtains that
first platform session: it exchanges the workload's ambient OIDC token
via `grant_type=urn:ietf:params:oauth:grant-type:token-exchange` on
`/auth/login` instead of presenting `grant_type=platform_api_key`.

Use a static key when the workload runs somewhere with no ambient
federated identity (your own VM, a laptop, a non-Actions CI). Use
federation everywhere it's available — it removes the only standing
secret in the integration.

### How a binding works

A federation binding is a per-platform trust spec. An incoming
workload assertion is accepted for your realm **iff**:

1. its `iss` is an RI-known issuer (GCP or GitHub — see below),
2. its `aud` matches the global RI federation audience
   (`https://api.realmid.dev`; forced server-side, you don't set it),
   and
3. **every** entry in the binding's `match_claims` equals the
   corresponding claim on the assertion.

`match_claims` is the tenant boundary — it is an AND of exact-string
equalities and **must** constrain at least the provider's mandatory
claim. There is no get-by-id route; you `list`, `create`, and
`delete` (revoke). Revoke is a soft-delete: the binding flips to
`status:"revoked"` and immediately stops authenticating workloads, but
the row is retained for audit.

Register bindings against the admin surface (owner-gated, same auth as
the other `/platforms/{id}/...` routes):

- `GET    /platforms/{id}/federation-bindings` — list (paginated).
- `POST   /platforms/{id}/federation-bindings` — create → `201`.
- `DELETE /platforms/{id}/federation-bindings/{bid}` — revoke → `200`.

### GCP (Cloud Run / GKE / GCE)

The mandatory match claim for GCP is **`sub`**, and on a Google-minted
ID token `sub` is the service account's immutable **numeric
`uniqueId`** — not its email. Get it with:

```bash
gcloud iam service-accounts describe SA_EMAIL --format='value(uniqueId)'
# e.g. SA_EMAIL = my-workload@my-project.iam.gserviceaccount.com
# prints: 109876543210987654321
```

Then register a binding keyed on that `sub`:

```http
POST /platforms/{id}/federation-bindings
Authorization: Bearer <owner access token>
Content-Type: application/json

{
  "issuer": "https://accounts.google.com",
  "match_claims": { "sub": "109876543210987654321" }
}
```

The issuer for GCP workloads is the bare `https://accounts.google.com`
form (the issuer normalises `accounts.google.com` to it). Pin to the
numeric `uniqueId`, never the SA email — the email is mutable and
re-assignable, the `uniqueId` is not.

> ⚠️ **CLI gotcha — `match_claims` is a nested object, so inject it as
> raw JSON with `:=`, not `=`.** `--field match_claims={...}` sends the
> value as a *string* and the binding won't match; use the typed-injection
> form:
> ```bash
> realm-id federation-bindings create --platform <realm-id> \
>   --field issuer=https://accounts.google.com \
>   --field 'match_claims:={"sub":"109876543210987654321"}'
> ```
> (`k=v` infers scalars; `k:=rawjson` injects a typed value — see the CLI
> README "Body" note.)

Optional fields on the create body: `mapped_role` (the role stamped on
the minted platform session; defaults to `platform_api`) and `scope`.

### GitHub Actions

The mandatory match claim for GitHub is **`repository`** (the
`owner/repo` string). You may add further claims to narrow the trust
(e.g. `environment`, `ref`):

```http
POST /platforms/{id}/federation-bindings
Authorization: Bearer <owner access token>
Content-Type: application/json

{
  "issuer": "https://token.actions.githubusercontent.com",
  "match_claims": { "repository": "acme/billing", "environment": "prod" }
}
```

In the workflow, grant the job permission to mint an OIDC token:

```yaml
permissions:
  id-token: write   # required — without it no Actions OIDC token is issued
  contents: read
```

With that permission GitHub injects `ACTIONS_ID_TOKEN_REQUEST_URL` and
`ACTIONS_ID_TOKEN_REQUEST_TOKEN` into the runner environment. The SDK
**auto-detects** these (see snippets below): it fetches the OIDC token
for the RI federation audience and exchanges it — you don't read the
token yourself.

### SDK: picking a credential source

The SDK keeps your `RealmID`; only the bootstrap credential changes.
Leave it unset and the SDK **auto-detects** the ambient source (GitHub
Actions is probed first — it's a network-free env signal — then the
GCP metadata server). Or pin a source explicitly.

```go
// Go SDK
// Zero-config: omit APIKey + Credential, the SDK auto-detects.
realm, _ := realmid.New(realmid.Config{RealmID: realmID})

// Explicit GCP workload identity:
realm, _ = realmid.New(realmid.Config{
    RealmID:    realmID,
    Credential: realmid.GoogleWorkloadIdentity("", nil), // "" → default RI audience
})

// Explicit GitHub Actions OIDC:
realm, _ = realmid.New(realmid.Config{
    RealmID:    realmID,
    Credential: realmid.GitHubActionsOIDC("", nil),
})

// Static API key (the classic path):
realm, _ = realmid.New(realmid.Config{
    RealmID:    realmID,
    Credential: realmid.StaticAPIKey("rk_live_…"), // or just Config{APIKey: "rk_live_…"}
})
```

```ts
// TS SDK
import {
  Realm, staticApiKey, googleWorkloadIdentity, githubActionsOidc,
} from "@realm-id/sdk";

// Zero-config auto-detect:
const realm = new Realm({ realmId });

// Or pin a source:
new Realm({ realmId, credential: googleWorkloadIdentity() });
new Realm({ realmId, credential: githubActionsOidc() });
new Realm({ realmId, credential: staticApiKey("rk_live_…") }); // or { realmId, apiKey: "rk_live_…" }
```

(Java mirrors these as `CredentialSources.staticApiKey` /
`googleWorkloadIdentity` / `githubActionsOidc` / `autoDetect`.)

### Replay & security notes

The exchange validates the workload assertion against the **RI-pinned**
JWKS for its issuer (partners never supply a `jwks_uri`, so there is no
SSRF surface), then applies three replay defenses before selecting a
binding:

- **`aud`-pin** — the assertion's `aud` must equal the global RI
  federation audience; a per-platform audience is rejected
  (anti-confused-deputy).
- **`iat`-freshness** — the IdP's ~1h validity window is shrunk to a
  short freshness bound (default 5m + leeway); stale assertions are
  rejected.
- **one-time-use** — each assertion is consumed once, keyed on `jti`
  when present (GitHub) or `sha256(assertion)` when absent (GCP Google
  ID tokens carry no `jti`). A replay returns `401`.

Any of unknown issuer, invalid/stale/replayed assertion, audience
mismatch, or no matching binding fails the exchange with `401`.

### Out of v1: BYO-issuer

Only GCP and GitHub Actions are RI-pinned in v1. Bring-your-own issuer
(AWS, Azure, self-hosted Kubernetes OIDC) is **not** supported yet —
the nullable `jwks_uri` slot on the binding schema reserves the place
for that future tier but is unused today.

## 7. Migration checklist

If you are replacing an existing self-hosted auth stack, this section is the
end-to-end runbook: first the **identity model** you are mapping onto (§7.1),
then the **ordered checklist** (§7.2), the **bulk-import mechanics** that trip
most migrations (§7.3), and a **minimal-downtime cutover** strategy (§7.4).

### 7.1 The identity model you are mapping onto (read first)

RealmID uses **tenant-scoped users** (ADR-022, `design.md` §User). This is the
single most important thing to internalise before you plan an import, because it
usually differs from a self-hosted stack:

- A `users` row is **per-tenant** (`users.tenant_id` NOT NULL). The **same human
  in N tenants is N `users` rows** with N distinct ids and a role each. There is
  no global "user" row and no user↔tenant join table.
- The cross-tenant **spine for one person is their `provider_uid`** (Google
  `sub`, Firebase UID, …), custodied in `contact_verifications`. Login resolves
  a person to *all* their tenant-scoped users in the realm by `provider_uid`,
  then does tenant-pick (auto-selected for a custom domain or single tenant).

**Consequences for your migration:**
- If your source system has **one global user → many tenant memberships**, you
  drive the import off your **memberships**, not your users. Each
  `(source_user, tenant)` pair becomes one RealmID user.
- Your identity id map is therefore **`(source_user_id, source_tenant_id) →
  RealmID user UUID`**, not `source_user_id → UUID`. Derive the UUID with the
  tenant in the key (e.g. `uuidv5(NS, "user:"+src_tenant_id+":"+src_user_id)`).
  Putting the tenant in the hash is not cosmetic — it is what keeps the same
  human's ids distinct across tenants and satisfies the cross-tenant guard in
  §7.3.

### 7.2 The ordered checklist

1. **Create your realm** via `POST /platforms` (`slug`, optional custom
   `domain`). A custom domain is optional (ADR-073) — you can start on the
   `<slug>.realmid.dev` hosted-login subdomain and claim/verify your own domain
   later via the realm-origins flow. **Seed any non-system roles now:** pass
   `starter_roles` (e.g. `["admin"]`) — a role you import users into must already
   exist and be enabled in the realm catalog (only `owner`/`member`/`platform_api`
   are system roles; `admin`/`viewer` are opt-in since v0.54.0). See §7.3 for the
   role rules the import enforces.
2. **Audit your JWT claims.** If your tokens currently carry only `user_id`/`tenant_id`/`role`, you will gain `iss`, `aud`, `azp`, `sub` — update your verifier to expect and validate these. Note your **`sub` changes type to a UUID** — grep for anywhere you log, cache, or join on it.
3. **Create your tenants** via `POST /platforms/{pid}/tenants`. Since v0.59.0
   (ADR-073 Amendment C) the tenant id is **bring-your-own**: pass an optional
   `id` (any UUID — a derived UUIDv5 keyed on your source id is the intended
   shape) and the call is idempotent — an id that already exists **in this
   realm** reconciles, one that exists in another realm is rejected. Omit it and
   the server mints a UUIDv7. **Realm ids are still always server-minted.** A
   required inline `owner` seats the org's owner in the same transaction (an org
   is never ownerless — `owner_user_id` is `NOT NULL`, ADR-076), and an optional
   `created_at` preserves the source "org since" age. If you do *not* bring your
   own id, **capture the returned tenant id** into your map
   (`source_tenant_id → RealmID tenant UUID`) as you go; everything downstream is
   keyed on it.
4. **Bulk-import your existing users (ADR-073)** — see §7.3 for the full
   mechanics (id derivation, provider binding, idempotent reconcile, owner
   handling, row cap, and `created_at` passthrough).
5. **Map provider identity into `contact_verifications`.** If you store
   `firebase_uid`/`google_sub` directly on your `users` row (the common case),
   supply it as `provider` + `provider_uid` on the
   import row (§7.3) so first SSO binds exactly. Provider linkage now lives in
   `contact_verifications` (proof rows keyed `(tenant, method, provider_uid)`) —
   the old `user_auth_methods` table and `users.email`/`users.phone` columns were
   dropped in the v0.11.0 cutover (ADR-042 §4). *(The
   `migrations/from-firebase-uid-on-users.md` walkthrough predates that cutover
   and is being updated; treat this step + §7.3 as authoritative until then.)*
6. **Stop self-issuing JWTs.** If you currently exchange a Firebase token for your own RS256 JWT, switch to `AuthenticateUser({Method: "firebase", Token: firebaseIDToken})` and return the RealmID tokens upstream (ADR-024).
7. **Move tenant context into the JWT.** If you keep active-tenant in a server-side cache such as Redis, switch to re-issuing tokens via `POST /auth/token { tenant_id }` (ADR-031/032) and update your middleware to trust `tenant_id` off the verified claim (ADR-026). Keep a thin partner-side cache if you need fast UX; do not treat it as authoritative.
8. **Map your admin UI.** The surface you call "platform admin" is almost certainly the **Tenant Owner** surface. See `ui-web.md` (the single admin app) and `design.md` §Terminology.
9. **Decide on sub-tenant RBAC.** If you have an outlet-like concept, keep it in your DB. RealmID will not model it (ADR-025).
10. **Wire cross-platform data access** (if needed). Use `/tenants/:id/users/lookup` + cross-platform service tokens per ADR-018. Do not attempt to share user IDs across realms. **Status (v1, 2026-04-22):** these endpoints are **post-v1** — the `internal/xplatform` package is implemented but not mounted in `internal/httpapi/routes.go`, so both routes return 404 today. Plan cross-platform integrations as post-v1 work. See ADR-035. *(This is ADR-018 cross-**platform** data access — distinct from ADR-082/083 cross-**realm** org access, which shipped in issuer v0.58.0.)*

### 7.3 Bulk-import mechanics (`POST /tenants/{id}/users/import`, ADR-073)

Owner/admin only (`users:manage`), **per tenant**, **whole-file atomic**: the
response is HTTP 200 with a `committed` flag; `committed:false` means *nothing*
was written — fix the per-row errors and resubmit. Per row:

- **Identity (bring-your-own id).** A row may carry its own `user_id` (a
  well-formed UUID) which **becomes `users.id`** — so your platform stores only
  UUIDs, never PII. Omit it and RealmID mints a UUIDv7 and **returns it** in the
  row result, paired to your identifier, so you can store the mapping. Use the
  deterministic derivation from §7.1 so re-runs are stable.
- **Cross-tenant guard.** A `user_id` that already exists in **another** tenant
  **rejects the whole file** (per-tenant rows; no cross-tenant clobber). The
  tenant-in-the-hash derivation (§7.1) avoids this by construction.
- **Idempotent reconcile.** A `user_id` that already exists **in the target
  tenant** is an **update** (role/display_name), not an error — so the import is
  **safely re-runnable**. This is what makes a low-downtime delta re-sync trivial
  (§7.4): re-POST the current snapshot; existing users come back `updated`, new
  ones `created`.
- **Provider binding.** Supply `provider` (`google`/`microsoft`/`apple`/
  `facebook`/`firebase`) **and** `provider_uid` together to write an exact
  first-SSO anchor into `contact_verifications`; omit both to bind on first SSO
  by verified email/phone match. Imported contacts are written **verified**,
  users `status='active'`, `kind=human`.
- **Roles.** `role` must be registered + enabled in the realm catalog (seed via
  `starter_roles` at realm creation, §7.2 step 1). `owner` and `platform_api`
  are **rejected** — you cannot import an owner (next bullet).
- **Ownership is seated at create, not by import.** Ownership is the
  `tenants.owner_user_id` pointer (ADR-076), not a role. Since v0.59.0 the
  inline `owner` on `POST /platforms/{pid}/tenants` is **required** and
  provisions org + owner in one transaction, so a migrated org arrives already
  seated — the create-empty-then-invite flow is gone. To *change* the owner
  later, use **`PUT /tenants/{id}/owner`** (the target must already be a member
  of that tenant — a composite FK enforces it).
- **Row cap.** ≤ **1000 rows per call** — chunk larger tenants client-side.
- **`created_at` is preserved** (since v0.59.0, ADR-073 Amendment C). Pass an
  optional RFC3339 `created_at` on an import row to carry your historical
  "member since" timestamp, and on `POST /platforms/{pid}/tenants` to carry the
  org's. A malformed value fails the row with `invalid_created_at`; omit the
  field and the row is stamped with the import time, which resets "member since"
  and historical ordering (pagination is `(created_at, id)`) to migration day.

**The per-tenant sequence, end to end:** `POST /platforms/{pid}/tenants` →
capture tenant id → chunk memberships (≤1000) → `POST /tenants/{tid}/users/import`
with derived `user_id` + `provider`/`provider_uid` + `role` → `PUT
/tenants/{tid}/owner` for the owner.

### 7.4 Minimal-downtime cutover

The pieces above make a near-zero-downtime cutover possible — the switch becomes
a rolling deploy, not a data freeze:

1. **Shadow-import** everyone into RealmID while your existing stack still serves
   auth (RealmID isn't issuing your logins yet — importing has no user impact).
   Because the import reconciles (§7.3), re-run it on a schedule to keep the
   shadow current; a final run just before cutover catches the last delta.
2. **Expand/contract your app DB.** Add UUID identity columns beside your
   existing keys, backfill them online through the map, and dual-write the UUID
   on new rows — so the moment auth flips, the UUID reads already work. (If your
   app is UUID-native or single-tenant this is trivial; if it is int-keyed and
   multi-tenant, this is the bulk of the work.)
3. **Cut over auth with a rolling deploy** and a **dual-token grace window**:
   validate both your legacy tokens and RealmID tokens during rollout, so
   existing sessions expire naturally instead of being force-logged-out. New
   logins go through RealmID (realm-root SSO → tenant-pick).
4. **Contract:** make the UUID columns authoritative, stop writing the old keys,
   and decommission your legacy auth tables after a rollback window. Keep them
   read-only until then — the deterministic UUIDs make re-migration safe.

## 8. What RealmID will *not* do for you

To calibrate expectations:

- No billing, no plan management, no invoices. Partner-owned.
- No sub-tenant RBAC (ADR-025).
- No action-gated MFA (ADR-027).
- No custom-domain signup flow for end users beyond what ADR-019 documents.
- No automatic domain-ownership re-verification after the initial verify (design.md §Domain Verification).

## 9. Testing your integration

Don't stand up RealmID (or Firebase) to write tests. Use the `ritest`
helper:

- **Go partners**: `import "realmid.dev/auth/testsupport/issuer"`, mint
  tokens in-process, verify via `Verifier.StaticKeys` — zero HTTP, zero
  subprocess. Ideal for middleware unit tests and fast feedback loops.
- **Non-Go partners or compose stacks**: run `ritest` as a binary on a
  loopback port; point your partner API's `BaseURL` at it.
- **Cross-test-run persistence**: pass `--state-file <path>` (binary) or
  `Config.StateFile` (library) and the keypair + revoked-JTI set survive
  process restarts. Fixture tokens checked into your repo will continue
  to verify across CI runs.
- **Single-concurrent-session tests**: pass a fixed `jti` on `POST /mint`
  so two successive tokens share identity; one `POST /revoke` kills both.

Full reference: [`issuer/testsupport/issuer/README.md`](../testsupport/issuer/README.md).

`ritest` is **not** an auth issuer you point production clients at — it
has no authentication on `/mint`. Run it only in test/CI networks and
never on a non-loopback interface (the binary refuses unless you pass
`--unsafe-public`).

## 9.5 Discovering your platforms

Once you have at least one platform realm, the base-realm UI drives
admin operations via two endpoints (see `docs/diagrams/platform-discovery.md`):

- `GET /platforms/mine` — returns `{ platforms: [{ id, domain,
  admin_tenant_id, display_name }] }` for every platform whose admin
  tenant you own.
- `GET /platforms/{pid}/tenants` — child tenants of the platform
  realm `pid`.

`GET /platforms/mine` is caller-scoped by construction; service JWTs
get 401 because "my platforms" has no meaning for a service identity.

## 9.6 Error envelopes

Every 4xx/5xx carries `{"error": { "code", "message", ...sibling-fields }}`.
Branch on `error.code`. The canonical 412 shapes partners must handle
(see `design.md §Error envelope`):

```json
{ "error": { "code": "mfa_required",
             "mfa_challenge_token": "<jwt>", "tenant_id": "<uuid>" } }
```
```json
{ "error": { "code": "mfa_registration_required",
             "mfa_challenge_token": "<jwt>", "tenant_id": "<uuid>" } }
```
```json
{ "error": { "code": "session_limit_reached",
             "revocation_token": "<jwt>",
             "active_sessions": [{ "id": "<uuid>", "origin": "...",
                                   "created_at": 1716000000,
                                   "last_seen_at": 1716000100 }] } }
```

`revocation_token` scope = `session:list session:revoke`; TTL =
`realms.config.challenge_ttl_seconds` (default 5m; ADR-034).

## 9.7 Deferred features

Still deferred (in-tree library code, no HTTP surface) — see **ADR-035**:

- Cross-platform authorization endpoints (§7 step 9, §10 link):
  `internal/xplatform` is implemented but not mounted in
  `internal/httpapi/routes.go`.
- Per-realm invitation TTL override.

Previously listed here but **since shipped**: the HTTP rate limiter (a
per-IP token bucket now guards the public auth surface) and OTP login
(now a first-class `grant_type=otp`, ADR-071 — see §6).

## 10. See also

- `design.md` — full design, especially §Terminology, §MFA, §Tenant Switching.
- `ui-web.md` — the single RealmID admin app (supersedes the old
  `ui-platform-admin.md` / `ui-tenant-owner.md` silo docs; for the
  persona naming, see `design.md` §Terminology).
- ADR-020, ADR-021 — token audience, realm clients, signing.
- ADR-022 — tenant-scoped users.
- ADR-023 — the legacy `platform_admin` enum rename (proposed).
- ADR-024 — Firebase ID-token exchange.
- ADR-025 — sub-tenant scope decision.
- ADR-026 — tenant context in JWT.
- ADR-027 — action-gated MFA scope decision.
- ADR-057 — workload identity federation (keyless M2M; §6.5).
- `../testsupport/issuer/README.md` — `ritest` library + binary reference.
- `migrations/from-firebase-uid-on-users.md` — schema-migration recipe for partners arriving with `firebase_uid` on their `users` row.
