# Integration Guide

This is the end-to-end guide for wiring a partner application onto
RealmID. It assumes nothing beyond a running RealmID install
(`auth.realmid.dev` or your own), an SDK in your language of choice,
and a partner application you control end-to-end. Read it once
top-to-bottom; you should be able to ship a full integration without
referring to anything else (server-side ADRs, support, etc.).

If anything in this guide disagrees with [`SPEC.md`](../SPEC.md), the
SPEC wins — file an issue.

> **Currency.** Audited line-by-line against the issuer source and the three
> published SDKs on 2026-08-31 (issuer `v0.114.0`, SDKs go `0.51.1` /
> ts `0.44.0` / java `0.41.0`). Where behaviour changed since an earlier
> revision of this guide, the text says what changed and when rather than
> silently rewriting, so a reader holding an old copy can diff their mental
> model.

---

## 0. What you'll have at the end

- A **realm** in RealmID, owned by you, with a verified custom domain,
  one or more tenants, and RealmID's fixed role catalog (your product
  roles ride the `scope` claim — §2.3).
- A **partner backend** that verifies RealmID-issued JWTs on every
  protected route and (optionally) proxies `/auth/*` so the SPA never
  talks to RealmID directly.
- A **partner frontend** that performs login via the SDK, handles
  multi-tenant pickers, MFA challenges, and session management.
- Optional: **long-lived clients** (desktop agents, CLI, mobile) that
  hold a refresh token and mint access tokens against RealmID
  directly.

---

## 1. Mental model

Three nouns and one rule.

**Realm** — your trust boundary. One per partner. Identified by a UUID
(`realmId`). All tokens you issue/verify are signed by the realm's
keys. The realm owns its JWKS, its role catalog, its domain claims,
and its API keys.

**Tenant** — an organizational unit inside a realm (a customer
company, a workspace, a project — model fits your domain). A tenant
has owners, members, invitations, and per-tenant config (MFA policy,
allowed signup domains, optional custom domain). Users live in
tenants, not in realms.

**User** — a person, identified by stable `sub`, scoped to one tenant
per session. Multi-tenant users get one `User` row per membership and
pick a tenant at login (or hit a picker).

**The rule** — RealmID issues identity. Your backend issues
*everything else*. RealmID never knows about your domain rows,
business invariants, or feature flags. It signs tokens that say "this
is `sub=X`, in `tenant_id=Y`, with `role=Z`, at this point in time."
You decide what that lets them do.

> **Two-level orgs (org → branch / outlet / workspace).** RealmID is
> single-level: one tenant per realm-membership, one role per
> `(user, tenant)`, no inter-user hierarchy. If your domain has a
> sub-unit layer below the org (branches, outlets, projects) with
> per-sub-unit roles or a reporting graph (`reports_to` and friends),
> model the **top-level org as the RealmID tenant** and keep the
> sub-unit membership + role matrix in your own database, resolved
> per-request from the verified `sub`. Carry only a coarse role in
> the token. Forcing sub-units up into RealmID tenants breaks
> org-level data isolation and org-wide roles, and is the most common
> integration anti-pattern.

### 1.1 Tokens

- **Access token** (RS256 JWT, default 15 min). Carries
  `iss=https://auth.realmid.dev/{realmId}`, `aud=<your audience>`,
  `sub`, `tenant_id`, `role`, plus any custom claims you allowed.
- **Refresh token** (opaque, default 30 days). Server-tracked. Used to
  mint access tokens via `/auth/token`. Rotates on every use.
- **Platform token** (short-lived JWT, ≤15 min). Server-only. Minted
  by exchanging a `rk_live_…` API key on `/auth/login` with
  `grant_type: "platform_api_key"` (the standalone `/auth/platform-token`
  endpoint was removed in server v0.7.0, ADR-051). **It has no refresh
  token** (ADR-089, issuer v0.68.0): cache it and re-mint from the
  credential shortly before expiry — `/auth/token` answers
  `401 m2m_refresh_withdrawn` for this identity. The SDKs do this for
  you from go `0.40.0` / ts `0.31.0` / java `0.29.0`. Used by your backend
  to authenticate to RealmID's management endpoints AND (in BFF mode) to
  authenticate the proxy itself.

The SDK manages platform tokens transparently. You never read them.

### 1.2 BFF mode (the only mode)

**BFF is no longer opt-in.** There used to be a per-realm flag
(`require_bff_login`) whose `false` value let a SPA call RealmID's
`/auth/*` directly. ADR-088 (2026-07-27) withdrew that integration
shape and removed the config key, and the base realm's own exemption
followed on 2026-08-03: **every** realm's `/auth/*` surface now
requires a partner platform token on every call, with no flag and no
exception. A caller without one gets `401 bff_bearer_required`. The
reasoning is structural — an `rk_live_…` shipped in a browser bundle
is a leaked secret, so there is no narrower enforcement that keeps
public clients working.

Concretely: your backend is the only caller. The SPA hits *your*
`/auth/*` routes, which proxy through to RealmID with the platform
token attached. Refresh tokens become HttpOnly cookies; access tokens
never touch JS storage.

> **BFF scope is realm-wide, not just `/auth/login`.** *Every*
> `/auth/*` call against the realm requires the partner platform token —
> `/auth/login`, `/auth/token` (refresh), `/auth/logout`,
> `/auth/sessions/*`, `/auth/mfa/*`. This is the right model: it
> means **long-lived clients** (desktop agents, sync workers, CLIs —
> §6) refresh through the same BFF proxy routes your SPA uses. The
> agent points at `https://api.partner.com/auth/token` instead of
> `https://auth.realmid.dev/auth/token`; the BFF attaches the
> platform token, forwards to RealmID, returns the response
> verbatim. No second realm, no per-client mode, no special-case
> code path.

There is no non-BFF mode left to choose. Plan every client — SPA,
desktop agent, CLI — to reach RealmID through your backend.

---

## 2. Realm bootstrap (one-time)

Operator runs these once per partner. They are not part of the
deploy pipeline.

### 2.1 Claim and verify a custom domain

```ts
// node script, run as a realm owner
import { createRealm } from "@realm-id/sdk";

const realm = createRealm({
  realmId: process.env.REALM_ID!,
  apiKey:  process.env.REALMID_OPS_API_KEY!,
});

const claim = await realm.domains.claim({ hostname: "partner.example.com" });
console.log("Add this DNS TXT record:", claim.txt_record); // { name, value }

// ...wait for DNS propagation, then:
await realm.domains.verify({ claimToken: claim.claim_token! });
```

```go
// go equivalent
realm, _ := realmid.NewRealm(realmid.Config{
    RealmID: os.Getenv("REALM_ID"),
    APIKey:  os.Getenv("REALMID_OPS_API_KEY"),
})
claim, _ := realm.Domains.Claim(ctx, "partner.example.com")
fmt.Println("Add this DNS TXT record:", claim.TxtRecord) // {Name, Value}
// ...
_, _ = realm.Domains.Verify(ctx, claim.ClaimToken)
```

A claimed-and-verified domain is the prerequisite for setting any
realm origins (the next step) and for issuing tokens whose `iss` is
your domain rather than `auth.realmid.dev`.

### 2.2 Create the realm and register origins

Realm creation itself happens out-of-band today (RealmID admin UI or
direct REST `POST /platforms`). The SDK does not expose it; this is
not a blocker for partners because realms are created by RealmID ops
when a partner signs up.

Once created, set the realm-level knobs via `realm.config`:

```ts
await realm.config.update({
  // see §8.4 for the key reference
  access_ttl_seconds: 900,
  refresh_ttl_seconds: 2592000,
  concurrent_session_limit: 0,             // 0 = unlimited
  default_invitation_role: "member",       // see warning below
});
```

`config.update` is a thin wrapper over `PATCH /platforms/{id}/config`.
The SDK takes a `Record<string, unknown>` / `map[string]any` because
the key set is server-owned and evolves; see §8.4 for the reference and
validation rules. (`require_bff_login` used to appear here; ADR-088
removed the key — the BFF requirement is unconditional, §1.2.)

**Origins are not a config key.** The origins RealmID accepts on login
traffic derive from the realm's claimed/bound domains
(`domain_mappings`); the SDK exposes them read-only as `realm.origins`
(`list` / `validate`). The related knob in `realm.config` is
`origin_enforcement`, which controls whether the browser `Origin`
header is checked against that list.

**Identity providers are rows, not a config blob.** An earlier revision
showed `auth_config: { firebase_project_id }` in the config patch; that
key was never patchable here. A provider (Google, Microsoft, Firebase,
Apple, Facebook) is enabled for login iff an enabled
`identity_providers` row resolves in scope — create one via
`realm.identityProviderConfig.create({ provider, clientType, clientId,
allowedOrigins })` (§3.7). For Firebase, the row's `client_id` is your
Firebase project id, so token verification runs against YOUR project's
keys and SMS billing stays on your Firebase account; the webapp still
talks to Firebase directly for the OTP round-trip and only the
resulting ID token is handed to RealmID.

> **`default_invitation_role` is a platform decision.** RealmID's
> roles carry no meaning in *your* product RBAC — `member` just means
> "exists in the tenant." `member` is the default and the right
> baseline for most apps; `admin` is the only alternative worth
> setting (the catalog is fixed — §2.3). RealmID rejects
> `default_invitation_role: "owner"` outright — it would turn every
> silent invitation into a privilege escalation. An org can also set
> its own default per tenant (`tenants.config.default_invitation_role`),
> which wins over the realm default.

### 2.3 The role catalog is RealmID's, not yours

An earlier revision of this guide told you to declare your product
roles (`accounts`, `salesman`, `dispatch`, …) here as a mandatory
bootstrap step. **ADR-101 (issuer `v0.113.0`, 2026-08-30) inverted
that: RealmID owns the role set, and a partner cannot author a role
at all.** `POST /platforms/{id}/roles` (and patch/delete/rename)
answer `403 role_authoring_retired` on every realm except RealmID's
own base realm.

The reasoning: a RealmID role has only ever described what a user may
do **to RealmID** — manage members, mint keys, claim domains, revoke
sessions — via the fixed ADR-074 permission catalog. It never
described your product. The two sets are:

- **realm level** — `owner`, `admin`, `member`, `platform_api`,
  `platform_mgmt_api`
- **org (tenant) level** — `owner`, `admin`, `member`

(`viewer` is gone; `admin` is part of the floor rather than opt-in.)
A role's **name confers nothing** — authority derives from the
catalog grants behind it, and a malformed entry fails closed.

**Your product's roles live in your own system** and reach RealmID as
ADR-097 opaque **scopes**: your backend supplies its own role→scope
map on every `/auth/token` mint (`scope: [...]`, §4.2 of the partner
guide), the issuer copies it verbatim into the token's `scope` claim,
and the SDK's `ScopePolicy` / `scopeAllows` enforce it on your routes.
RealmID stores no partner catalog; a scope string is opaque there.

What a realm owner still controls:

- **Disable / enable** a role (`roles.disable/enable`). Disabling is
  not authoring — it cannot create or widen anything. Within the fixed
  set the only disable-able role is `admin`; switching it off says
  "this realm has exactly one administrator, its owner."
- **Read** the catalog — and drive every role picker from it:

```ts
const { items: roles } = await realm.roles.list();
// roles: [{ id, name, permissions, assignable_to, is_system, disabled?, ... }]
```

```go
page, _ := realm.Roles.List(ctx, nil)
for _, r := range page.Items {
    // r.Name, r.IsSystem, r.Permissions, r.AssignableTo, r.CreatedAt
}
```

Because a realm may have `admin` switched off, **do not hardcode the
five names** — `GET /roles` is the honest way to learn what a realm
offers. Use the SDK predicates when building pickers:
`isRoleSeatable` (go/ts/java) mirrors the server's seating rule and
additionally hides `owner`, which is never seatable via invite or
role update — ownership is set at tenant create and moved via
`Tenants.TransferOwner` (§5.3). Any invitation or role update naming
a role outside the catalog returns `RealmError(unknown_role)`.

### 2.4 Mint a partner API key

```ts
const key = await realm.apiKeys.create({
  scope: "platform",              // the key class; must match the bound
                                  // bot user's role (platform_api → "platform"),
                                  // else 400 scope_mismatch
  label: "partner-backend",
});
console.log("Save this — it will not be shown again:", key.value);
```

`value` is the raw `rk_live_…` secret, returned **only on create**.
Stash it in your secret store (GCP Secret Manager, AWS Secrets
Manager, Vault). RealmID stores only its hash; subsequent
`apiKeys.list` returns metadata only (`prefix`, `label`, `role`,
`created_at`, `last_used_at`, `expires_at`, `revoked_at`).

Three ADR-085 facts to plan around:

- **Keys expire by default** — 90 days unless you pass `ttl_seconds`
  (floor 300 s; a smaller value is rejected, not clamped) or
  `non_expiring: true`.
- **A realm holds at most 2 active platform keys**, and at most one
  of them non-expiring — so "mint the next key before revoking the
  old one" is exactly the headroom the cap leaves you
  (`too_many_api_keys` / `non_expiring_not_allowed` otherwise).
- The `label` is the only handle on a key in listings; the plaintext
  is never echoed again.

Every key is bound to a bot user (ADR-041); by default that is the
realm's provisioned "Platform API" user, so you rarely pass `user_id`.
One rotation trap is enforced server-side: **a platform API key cannot
mint another API key** (`403 api_key_cannot_mint_api_key`) — rotate
via a workload-identity-federation session or an owner login instead.

---

## 3. Backend integration

Two responsibilities: **verify tokens** on every protected route, and
(optionally) **proxy `/auth/*`** to RealmID under BFF mode.

### 3.1 Drop-in middleware

The fastest path. One line in your HTTP app.

```ts
// express
import express from "express";
import cookieParser from "cookie-parser";
import { createRealm } from "@realm-id/sdk";

const realm = createRealm({
  realmId: process.env.REALM_ID!,
  apiKey:  process.env.REALMID_API_KEY!,
});

const app = express();
app.use(express.json());
app.use(cookieParser());

app.use(realm.middleware({
  exemptPaths:       ["/health", "/public/*"],
  mfaProtectedPaths: ["/admin/*"],
}));

app.get("/me", (req, res) => res.json({ user: (req as any).realmid }));
```

```go
// stdlib net/http
mux := http.NewServeMux()
mux.HandleFunc("/me", func(w http.ResponseWriter, r *http.Request) {
    claims, _ := realmid.ClaimsFrom(r.Context())
    json.NewEncoder(w).Encode(claims)
})

handler := realm.Middleware(realmid.MiddlewareOptions{
    ExemptPaths:       []string{"/health", "/public/*"},
    MFAProtectedPaths: []realmid.MFARule{{Path: "/admin/*"}},
})(mux)

http.ListenAndServe(":3000", handler)
```

What the middleware does:

1. Pulls the bearer token from `Authorization: Bearer …`.
2. Verifies signature against the realm's JWKS (cached 10 min,
   unknown-kid forces refetch).
3. Verifies `iss`, `aud`, `exp`, `nbf`.
4. Mounts the four proxy routes the SPA will call: `POST /login`,
   `/token`, `/logout`, `/mfa/verify` (defaults — override with
   `loginPath` etc.; see `middleware.md`). Session listing/revocation
   is **not** auto-mounted — wire those proxies yourself if your UI
   needs them (§4.5).
5. Attaches verified claims to the request (`req.realmid` in TS,
   `realmid.ClaimsFrom(ctx)` in Go).
6. Honors `mfaProtectedPaths`: routes whose path matches return
   **412** `mfa_required` (with a fresh `mfa_challenge_token` in the
   body) when the token's MFA proof is absent or older than the
   rule's freshness window (`mfa_at` claim; falls back to the
   `amr`/`acr` marker for older tokens).

### 3.2 Verify-only mode

If your service only verifies tokens minted by an upstream gateway
(common in microservices), skip the middleware and use the verifier:

```ts
import { createVerifier } from "@realm-id/sdk";

const verifier = createVerifier({
  baseUrl:  "https://auth.realmid.dev",
  audience: process.env.REALM_AUDIENCE!,
});
// (No realmId parameter — the verifier reads the realm from the
// token's iss and fetches that realm's JWKS.)

const claims = await verifier.verify(token);
```

```go
// Go has no standalone NewVerifier — construct the handle and call
// Verify. A verifier-only handle needs no API key; pass the audience
// per-call via VerifyOptions so Verify never falls back to the
// credentialed Info() auto-discovery.
realm, _ := realmid.NewRealm(realmid.Config{
    BaseURL: "https://auth.realmid.dev",
    RealmID: os.Getenv("REALM_ID"),
})
claims, err := realm.Verify(ctx, token, &realmid.VerifyOptions{
    Audience: os.Getenv("REALM_AUDIENCE"),
})
```

Verifier-only mode does **not** need an API key. Use it for any
service that is downstream of your auth-bearing edge.

### 3.3 Custom middleware (when the drop-in isn't enough)

If you have a non-trivial existing middleware stack (Connect, Fiber,
GoFr, custom router), wrap the verifier yourself:

```go
// The Go SDK exports no standalone Verifier type and no WithClaims —
// verify through the realm handle and carry the claims under your own
// context key (realmid.ClaimsFrom only reads what the SDK's OWN
// middleware attached).
type claimsKey struct{}

func authMiddleware(realm *realmid.Realm, next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
        claims, err := realm.Verify(r.Context(), tok, nil)
        if err != nil {
            http.Error(w, err.Error(), http.StatusUnauthorized)
            return
        }
        ctx := context.WithValue(r.Context(), claimsKey{}, claims)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}
```

Use this when you need to coexist with an existing JWT verifier
(common during migrations — see §8.1) or interleave with your own
RBAC layer.

### 3.4 Claims you can rely on

Every verified access token gives you:

| Claim          | Type     | Notes                                                   |
|----------------|----------|---------------------------------------------------------|
| `sub`          | string   | User id, scoped to the (user, tenant) pair — see below. |
| `tenant_id`    | string   | The tenant the user picked at login.                    |
| `role`         | string   | Role name from the realm catalog (this tenant only). RealmID's vocabulary, not your product's — §2.3. |
| `iss`, `aud`, `exp`, `nbf`, `iat`, `jti`, `azp` | — | Standard JWT.     |
| `amr`          | string[] | Auth methods used; includes `"mfa"` if MFA was passed.  |
| `mfa_at`       | number   | Unix seconds of the last successful MFA verify; drives the middleware freshness gate. Absent without MFA. |
| `scope`        | string   | ADR-097 granted authority — YOUR scope strings, space-delimited, supplied by your BFF on `/auth/token` (§2.3). Absent when not supplied. |
| `token_class`  | string   | `"platform"` / `"integration"` on machine tokens; absent on ordinary user tokens. |
| `permissions_cap` | string[] | Only on user-API-key-derived tokens (§9.5): the cap, never a grant. |
| custom claims  | varies   | Any keys allowed by `access_token_custom_claim_keys`.   |

**There is no `email`, `phone`, or `display_name` claim** — an earlier
revision listed them, but the issuer has never minted identity contact
data into access tokens (contacts are `user_contacts` rows, fetched
via `tenants.users.get` when you need them). Do not fetch the user
from RealmID on every request for authorization, though — for that,
the token is the truth.

> **Custom claims — who supplies values, when.** RealmID does not
> compute or persist custom-claim *values*. The allowlist
> (`access_token_custom_claim_keys`, §8.4) names the keys you are
> *permitted* to pass; values are supplied **per-call** by the BFF
> in the `custom_claims` field of the `/auth/token` request body,
> and the issuer copies them verbatim into the minted access token.
> Unknown keys (not in the allowlist) reject with `400 bad_request` at
> mint time. Reserved JWT names used to be silently dropped; since
> ADR-097 they are **refused** with `400 reserved_claim_key` — a
> dropped claim is indistinguishable from an honoured one, and once
> `scope` carries authority that difference matters. The reserved set
> is the token's own claim set: `iss`, `sub`, `aud`, `iat`, `nbf`,
> `exp`, `jti`, `azp`, `tenant_id`, `role`, `amr`, `acr`, `mfa_at`,
> `scope`, `token_class`.
>
> Worked example — BFF carries derived authz context:
>
> ```go
> // /auth/token proxy handler in your BFF, after looking up the
> // user's outlet list and reports-to graph in YOUR database.
> outlets, _ := db.OutletsFor(userID, tenantID)         // []string
> managerSub, _ := db.ManagerOf(userID, tenantID)       // string
>
> out, err := realm.Auth.Token(ctx, realmid.TokenRequest{
>     RefreshToken: req.RefreshToken,
>     TenantID:     req.TenantID,
>     CustomClaims: map[string]any{
>         "outlets":     outlets,      // key must be in allowlist
>         "manager_sub": managerSub,
>     },
> })
> ```
>
> Set the allowlist once at bootstrap:
> `realm.config.update({ access_token_custom_claim_keys: ["outlets", "manager_sub"] })`.
> Token verifiers downstream see these as plain claims; no extra
> SDK call needed.

> **`sub` is per-(user, tenant), not per-human.** Each tenant
> membership has its own user record, so the same human in tenants
> A and B presents two different `sub` values across the two access
> tokens you receive. Treat `sub` as your local user-table primary
> key (it's stable across role changes, email/phone updates, and
> session revocations within that tenant), but don't try to use it
> as a cross-tenant identifier for the same person.

> **Removing and re-adding a user — reactivate, don't re-invite.**
> RealmID does not hard-delete users. `DELETE` on a user (or
> `PATCH … status=deactivated`) is a soft delete: the row stays,
> the email/phone slot stays held by the per-tenant unique index. A
> subsequent invitation to the same identifier in that tenant would
> fail at accept time with a 409. The supported way to re-onboard a
> removed user is to flip `status` back to `active` — `sub`, role,
> and any FK relationships in your DB stay intact across
> reactivation. If you genuinely need a brand-new `sub` for the same
> identifier, that's a hard-delete operation today coordinated with
> RealmID ops.

> **Tenant rename — JWT carries `tenant_id` only.** The access
> token does NOT include the tenant's `display_name`. Renaming a
> tenant in the admin UI takes effect immediately for any caller
> that fetches `realm.tenants.get(tenantId)`; existing JWTs are
> unaffected (nothing to invalidate). If you mirror `display_name`
> in your local tenants table for UI rendering, refresh it on a TTL
> (24h is fine) or on a cache miss. No push notification today.

> **Mutating a user's email or phone IS supported** — an earlier
> revision said it wasn't; the ADR-042 contact model shipped it.
> `PATCH /tenants/{id}/users/{uid}` accepts `{email?, phone?}`
> (`tenants.users.updateContact` in the SDKs). One semantic to
> respect: an address written by an admin is an **assertion**, not an
> identity — it becomes login-capable only when the address-holder
> proves it (verified IdP assertion or OTP). The surrounding
> machinery (provider re-bind approval, drift review, contact
> delink/hand-back) is on `tenants.users.*` / `tenants.driftReviews`.

> **Identifier uniqueness within a tenant.** RealmID enforces
> uniqueness of each contact (email, phone) within a tenant via the
> ADR-042 `user_contacts` model. The invite-time pre-check this note
> once promised **has shipped**: a colliding invitation is refused at
> *create* time with a first-class `409 identifier_collision`, and a
> live membership answers `409 already_member`. You no longer need a
> partner-side pre-check to render "this phone is already mapped" —
> though keeping one as UX sugar is harmless.

### 3.5 BFF login proxy

The SPA cannot talk to RealmID directly (§1.2 — the requirement is
unconditional). Your backend proxies. The drop-in
middleware (§3.1) does this for you. If you have a custom HTTP layer,
wire the routes by hand:

```go
mux.HandleFunc("POST /auth/login", func(w http.ResponseWriter, r *http.Request) {
    var req realmid.LoginRequest
    json.NewDecoder(r.Body).Decode(&req)
    if req.Origin == "" {
        req.Origin = r.Header.Get("Origin")
    }
    sess, err := realm.Auth.Login(r.Context(), req)
    if err != nil { writeRealmError(w, err); return }
    json.NewEncoder(w).Encode(sess)
})

mux.HandleFunc("POST /auth/token", func(w http.ResponseWriter, r *http.Request) {
    var req realmid.TokenRequest
    json.NewDecoder(r.Body).Decode(&req)
    out, err := realm.Auth.Token(r.Context(), req)
    if err != nil { writeRealmError(w, err); return }
    json.NewEncoder(w).Encode(out)
})

mux.HandleFunc("POST /auth/logout", func(w http.ResponseWriter, r *http.Request) {
    var req realmid.LogoutRequest
    json.NewDecoder(r.Body).Decode(&req)
    realm.Auth.Logout(r.Context(), &req)
    w.WriteHeader(204)
})

// /auth/sessions, /auth/mfa/verify, etc. follow the same shape.
```

`realm.Auth.Login` / `Token` / `Logout` / `MFAVerify` automatically
attach a cached platform token. You do not need to mint or refresh it
yourself.

The proxy handlers are pure pass-throughs — request body in, response
body out, no business logic. Do **not** mutate the response (the SPA
SDK will fail to parse it). Add your domain-row provisioning (§6) on
the access-token verification path, not here.

### 3.6 Admin consoles: managing the realm as a user

The `rk_live_…` API-key flow (§2, §3) is one way to call the
management surface — appropriate for ops scripts and headless backends.
There is a second, equally first-class path: a **human platform-admin
logged in as a user**, calling the same management endpoints with
their own access token. This is the right model for a
partner-operated admin console ("manage tenants, invite owners,
change roles, reset MFA" UI staffed by your humans). Do **not** ship
the `rk_live_…` to the admin SPA — that key authorises every tenant
in your realm and cannot be self-serve revoked.

**The admin tenant.** Every realm is provisioned with one
**admin tenant** that lives in RealmID's base realm. Your
platform-admin staff are **owner users in that admin tenant**. They
log in via the same `/auth/login` flow as end users (whatever IdP
your realm is configured for), receive a normal user access token,
and that token authorises the privileged `/platforms/{id}/…` and
`/tenants/…` writes. Authorization is the ADR-074 permission catalog
resolved from the DB per request — the admin tenant's `owner` is
implicit-all, and an `admin` there holds whatever the catalog grants
that role — never a bare string compare on the role name.

**SDK shape — act as the verified user, not as the platform.** The
server SDK's on-behalf mode is `realm.withUserToken(accessJWT)`
(go/ts/java): it returns a derived handle whose every call keeps the
platform token as the wire bearer and additionally forwards the
user's *verified* access JWT as `X-User-Token`, so the issuer
authorizes the human, not the key. (A bare user id is not an
identity — the issuer removed that mode in v0.66.0.)

```ts
// In your BFF, per admin request:
const asUser = realm.withUserToken(req.session.accessToken);
await asUser.tenants.invitations.create(adminTenantId, {
  identifier: "ops-2@partner.com",
  role:       "admin",            // owner is never invitable — see below
});
await asUser.tenants.create({
  displayName: "Acme",
  signupMode:  "allowlist",
  owner: { email: "founder@acme.com" },   // required at create — §5.6
});
```

For the console frontend itself, use the dedicated admin browser SDK
`@realm-id/web-admin` (pointed at your BFF), which wraps the same
resource surface plus the discovery calls (who am I, which platforms
are mine). **Never pass `apiKey` in a browser.** (An earlier revision
showed `realm.identity.me()` / `realm.platforms.mine()` on the server
SDK — neither exists there; discovery beyond `realm.info()` is the
admin browser SDK's job.)

**Onboarding additional admin staff.** Invite them into the admin
tenant with `role: "admin"` (or `member`). **`role: "owner"` is
refused** (`400 owner_not_invitable`) — ownership is a pointer set at
tenant create and moved via `transferOwner`, never an invitable role
(ADR-076). The **last-owner guard** still protects the final owner
(`RealmError(last_owner)`).

**The boundary — partner-admin vs RealmID-ops.** A user JWT with
admin-tenant ownership authorises **your realm's** management
surface (`/platforms/{your-id}/…`, `/tenants/{id-in-your-realm}/…`).
It does **not** authorise the cross-platform `/admin/*` surface
(`GET /admin/platforms`, `/admin/stats`, platform-notes,
signing-key rotation, suspend-other-platform) — those are reserved
for RealmID's own ops and return 403 for partner admins. Use
`platforms.mine()` and `identity.me()` for discovery; ignore
`AdminPlatformsResponse` / `AdminStats` types in the SDK
(they're shaped for RealmID ops).

**Lifecycle parity — which token authorises what.** For partners
moving all user-lifecycle management into RealmID, both auth modes
cover the same surface; pick per call site:

| Operation                          | Admin user JWT | `rk_live_…` API key |
|------------------------------------|:--------------:|:-------------------:|
| Create tenant                      | ✓              | ✓                   |
| List / get tenants                 | ✓              | ✓                   |
| Invite user (any role except owner)| ✓              | ✓                   |
| Update user role                   | ✓              | ✓                   |
| Set user status (deactivate / reactivate) | ✓       | ✓                   |
| Reset user MFA                     | ✓              | ✓                   |
| Transfer tenant owner              | ✓              | ✓                   |
| Suspend / soft-delete tenant       | ✓              | ✓                   |
| Create / list / revoke API keys    | ✓              | ✓ (mint needs a non-key session — §2.4) |
| Update realm config                | ✓              | ✓                   |
| Mutate user phone / email          | ✓              | ✓                   |
| Disable / enable a role            | ✓              | ✓                   |
| **Create / rename / delete roles** | —              | —                   |
| `/admin/*` cross-platform surface  | —              | —                   |

The two "—" rows are partner-uncallable today regardless of token:
role authoring is retired for every non-base realm (ADR-101,
`403 role_authoring_retired` — §2.3), and `/admin/*` is RealmID-ops
only.

**Role catalog ownership split — updated for ADR-101.** The
integration contract is:

- The role **catalog** (the set itself) is RealmID's, fixed and
  RI-authored (§2.3). Assignment stays yours:
  `realm.tenants.updateUserRole` seats a member at a catalog role.
- A role's `permissions[]` is RealmID's ADR-074 catalog — what the
  holder may do **to RealmID** — and RealmID enforces it.
- What each user can do **in your product** is enforced in your
  application, carried as ADR-097 `scope` strings your BFF supplies
  at mint time and reads back with the SDK's `ScopePolicy`.

The split is still intentional — RealmID stays free of
partner-specific authorization semantics — but the mechanism moved:
your vocabulary now rides the `scope` claim, not the role name.

### 3.7 Identity provider restriction (per realm / per tenant)

`auth_config.firebase_project_id` (§2.2) names a single project for
the realm, but the issuer additionally lets you constrain **which
identity providers** are accepted, separately per realm and per
tenant. This is the surface you reach for when you want
"admin-tenant authenticates with Google only; end-user tenants
authenticate with phone OTP only," or any other per-tenant IdP
policy.

```ts
// realm-admin CRUD over provider rows
await realm.identityProviderConfig.list();
// → { items: [{ id, provider, clientType, clientId, allowedOrigins, enabled, ... }] }

// tenant-scoped row (admin tenant: Google web-only)
await realm.identityProviderConfig.create({
  tenantId:        adminTenantId,   // omit for a realm-level row
  provider:        "google",
  clientType:      "web",
  clientId:        "…apps.googleusercontent.com",
  allowedOrigins:  ["https://admin.partner.com"], // required for clientType "web"
});
```

Provider rows are scoped to a `(realm | tenant, client_type)` pair
(`web`, `ios`, `android`, `desktop`, `other`) so the same realm can
allow Google on the web app and Firebase on mobile. The login flow
filters available providers by the resolved scope of the login
attempt; an unrecognised provider returns
`RealmError(provider_not_enabled)`.

Two SDK surfaces, deliberately distinct: `realm.identityProviderConfig`
is the realm-admin CRUD shown above; `realm.identityProviders.discover()`
is the **public** login-time discovery list a SPA reads (SPEC §6.10),
filtered by the resolved scope of the login attempt.

---

## 4. Frontend integration

The SDK ships a browser bundle that handles login, refresh, logout,
sessions, and MFA. Same interface whether you point it at RealmID
directly or at your BFF.

### 4.1 Configure

```ts
// src/auth/realm.ts — the browser SDK is its own package, @realm-id/web
// (there is no "@realm-id/sdk/browser" subpath; @realm-id/sdk is the
// SERVER SDK and exports no browser bundle).
import { createRealm } from "@realm-id/web";

export const realm = createRealm({
  // Always your own backend — baseUrl is required and it is the BFF.
  baseUrl: import.meta.env.VITE_API_BASE_URL,
});
```

The browser SDK takes no `apiKey` and no issuer URL: there is no
direct-to-issuer browser mode any more (§1.2 — a browser caller of
RealmID's own `/auth/*` gets `401 bff_bearer_required`). Full browser
API — session restore, multi-tab sync, step-up retry, membership
self-service — is documented in `web/README.md` / `web/BFF-SPEC.md`.

### 4.2 Login (Firebase example)

```ts
import { realm } from "./auth/realm";
import { signInWithPhoneNumber } from "firebase/auth";

async function loginWithPhone(phone: string, code: string) {
  // 1. Firebase OTP roundtrip — your existing code.
  const fbCredential = await confirmOtp(phone, code);
  const idToken = await fbCredential.user.getIdToken();

  // 2. Hand the Firebase id-token to your BFF via the browser SDK
  //    (@realm-id/web — note: realm.login, not realm.auth.login).
  const session = await realm.login({
    method: "firebase",
    providerToken: idToken,
  });

  // 3. Single-tenant happy path: session.accessToken is set.
  if (session.accessToken) {
    return { tenantId: session.tenantId, role: session.role };
  }

  // 4. Multi-tenant: show a picker, then settle it.
  return { tenantsToPick: session.tenants };
}

async function pickTenant(tenantId: string) {
  // resolveTenant re-submits the RETAINED provider credential with the
  // chosen tenant — never re-run the IdP round-trip for a pick.
  const out = await realm.resolveTenant(tenantId);
  // out.accessToken, out.tenantId, out.role
}
```

### 4.3 Multi-tenant flow

When the user belongs to more than one tenant in the realm, `login`
returns a `tenants` array but no `accessToken`. Your UI shows a
picker; settle it with `realm.resolveTenant(tenantId)`. The user can
switch tenants later via `realm.switchTenant(tenantId)` — under the
hood that is a `/auth/token` mint with the new `tenant_id`, so the
access token is rebound and the refresh token rotates. Membership is
re-resolved at every mint; a tenant the user no longer belongs to
answers `tenant_invalid`.

> **Correction (2026-08-31).** An earlier revision described OTP-
> established sessions as "tenant-locked" with a
> `tenant_locked_session` error on switch. Neither the lock nor the
> error code exists in the issuer or any SDK today: the built-in OTP
> grant is `grant_type=otp` (the old `otp_internal` name was retired
> in the ADR-071 cutover, and the issuer no longer accepts it), it is
> gated per-realm by `otp_login_enabled`, and the session it creates
> refreshes and switches tenants under the same membership rules as
> any other user session. If you shipped a disabled tenant-switcher
> for OTP users on this guide's advice, you can remove it.

### 4.4 MFA challenge

If the realm or tenant has MFA enforced, login fails with a **412**
whose envelope carries the challenge as a sibling; the SDK lifts the
siblings into `error.details` under their **wire names**
(`mfa_challenge_token`, `methods` — not camelCase):

```ts
try {
  await realm.login({ method: "firebase", providerToken: idToken });
} catch (e) {
  if (e instanceof RealmError && e.code === "mfa_required") {
    const challenge = e.details?.mfa_challenge_token as string;
    const code = await promptUserForTotpCode();
    const session = await realm.mfaVerify({
      challengeToken: challenge,
      code,
      method: "totp",     // optional; defaults to "totp"
    });
    // session.accessToken is now set
  }
}
```

Self-enroll TOTP from the user's account screen — via your BFF, using
the server SDK's self surface (`auth.selfEnrollMfa` / the follow-up
`mfaVerify` with the enroll-scoped challenge, ADR-061), or the admin
surface when an admin drives it:

```ts
const enroll = await realm.tenants.users.enrollMfa(tenantId, userId);
// enroll.secret + enroll.otpauth_uri — render the QR yourself from the
// otpauth:// URI (there is no server-rendered qrCodePng).
const userCode = await promptUserForTotpCode();
await realm.tenants.users.confirmMfa(tenantId, userId, userCode);
```

`resetMfa` removes the user's TOTP and is admin-only by convention
(your backend should gate it before calling).

### 4.5 Sessions UI

```ts
// Server SDK, in your BFF, on behalf of the signed-in user: pass the
// user's access JWT so the issuer resolves THAT user's sessions.
// listSessions returns Paginated<SessionInfo> and follows next_cursor
// for you (ts 0.37.0; it was a bare first-page array through 0.36.0).
for await (const s of realm.auth.listSessions(userJwt)) {
  // s.id, s.created_at, s.last_seen_at, s.user_agent, s.ip, s.device_name
}

// …or take one page at a time, for a table with a "load more" control:
const page = await realm.auth.listSessions(userJwt).page({ limit: 25 });
// page.items, page.next_cursor, page.total

await realm.auth.revokeSession(sessionId, userJwt);
await realm.auth.revokeAllSessions({ userBearer: userJwt });
```

> Field names on `SessionInfo` are the issuer's **wire** names, not camelCase —
> TS returns the parsed server JSON unmapped. The last-used timestamp is
> `last_seen_at` (unix seconds); there is no `last_used_at` on this DTO. (Go and
> Java do map them: `SessionInfo.LastUsedAt` / `Session.lastUsedAt()`.)

Build the page once; it works for both web sessions and long-lived
desktop sessions (§6) — the latter show up with a stable `userAgent`
that you control at install time.

**Tagging desktop sessions** — the `userAgent` field on the session
record is the verbatim `User-Agent` HTTP header sent on `/auth/login`.
Set a deterministic value from your installer (e.g.
`MyAgent/1.4.0 (install=abc123; host=desktop-7)`) so admins can
identify it in the UI and revoke "the install on machine X" without
killing their own browser session.

**Last-used semantics** (`last_seen_at` on the ts wire shape,
`LastUsedAt`/`lastUsedAt()` in Go/Java) — updates on every successful access-token
mint (i.e. on `/auth/token` calls), not just on the initial login.
Granularity is per-second. Use it for "last seen" UX; don't build
hard SLAs on sub-second precision.

**Revocation propagation** — `DELETE /auth/sessions/{id}` invalidates
the refresh server-side immediately; the very next `/auth/token` call
against that refresh returns `RealmError(refresh_invalid)`. Already-
issued **access** tokens remain valid until their natural `exp`
(default 15 min) unless you also wire the optional revocation cache
(see `dual-token.md`), which the SDK consults on every verify when
configured.

### 4.6 Refresh and logout

The SDK's token manager refreshes 60 s before expiry. You don't write
refresh-on-401 logic. Failed refreshes throw
`RealmError(refresh_invalid)` — catch it, clear local UI state,
redirect to login.

```ts
await realm.auth.logout();      // current session
```

Under BFF mode, `logout` clears the refresh cookie too.

---

## 5. Domain row provisioning

RealmID owns identity. Your database owns everything else. You need a
strategy for keeping local rows (tenants, users, beats, projects,
whatever) in sync with what RealmID provisions.

### 5.1 Lazy is the right default

Don't try to mirror RealmID writes into your DB synchronously.
RealmID has no webhook surface today, and trying to dual-write from
your invite handler invites consistency bugs. Instead, populate local
rows on the verification path:

```go
func provisionMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        claims, _ := realmid.ClaimsFrom(r.Context())

        // Local tenant row missing? Pull from RealmID, insert.
        if !tenantExistsLocal(claims.TenantID) {
            t, err := realm.Tenants.Get(r.Context(), claims.TenantID)
            if err != nil { http.Error(w, err.Error(), 500); return }
            insertLocalTenant(t.ID, t.DisplayName)
        }

        // Local user row missing? Insert from JWT claims.
        if !userExistsLocal(claims.Subject, claims.TenantID) {
            insertLocalUser(claims.Subject, claims.TenantID, claims.Role,
                            claims.Email, claims.Phone, claims.DisplayName)
            // Run any "first time we've seen this user" side effects here:
            // create their default workspace, seed their inbox, etc.
            if claims.Role == "salesman" {
                createDefaultBeats(claims.Subject, claims.TenantID)
            }
        }

        next.ServeHTTP(w, r)
    })
}
```

This pattern auto-recovers from drift between RealmID and your DB,
fires on first login (so you get a natural hook for side effects),
and costs one extra SELECT per request (cache it in-process for 60 s
if that bothers you).

### 5.2 Inviting users

Direct user-create is not supported. Send an invitation:

```ts
await realm.tenants.invitations.create(tenantId, {
  identifier: "+15551234",     // ONE string: an email or an E.164 phone
  role: "member",              // a catalog role — your product roles are scopes, §2.3
});
```

**Identifier rules** — `identifier` is a single **string**: an email
or an E.164 phone (an earlier revision showed an `{email, phone}`
object; that shape was never the wire contract — anything else is
`400 invalid_identifier`). One invitation binds one contact; invite
twice if you want either contact to work. Collisions are checked at
**create** time (ADR-042 shipped): an identifier already held in the
tenant answers `409 identifier_collision`, and a live membership
answers `409 already_member`. Omit `role` and the org's
`default_invitation_role` (falling back to the realm's, then
`member`) applies. Invitations expire after 30 days.

```go
_, _ = realm.Tenants.Invitations.Create(ctx, tenantID, realmid.InvitationCreate{
    Identifier: "+15551234",
    Role:       "member",
})
```

The invited user logs in via Firebase (or whatever IdP you've
configured). RealmID's login pipeline matches the invitation by
phone/email, links the IdP identity, and provisions the user. Your
lazy middleware (§5.1) picks them up on the first authenticated
request.

`role` must be in the catalog (§2.3) — unknown names return
`RealmError(unknown_role)` — and `owner` is refused outright
(`owner_not_invitable`; ownership moves by transfer, never
invitation). Seating an authority-conferring role is additionally
gated by the ADR-101 seating rule (§5.3).

Idempotent: re-inviting a still-pending identifier is a **success**
that bumps the expiry (and role), not an error — an earlier revision
documented a `RealmError(invitation_exists)`; no such code exists.
A rejected, expired, or deactivated former invitee can be re-invited;
only a live membership conflicts (`409 already_member`).

**Multi-tenant accept** — how a login turns pending invitations into
memberships is governed by the realm's `invitation_acceptance` config
(ADR-095): `"auto"` (the default) flips an invited membership to
active on the invitee's next sign-in in the realm with no prompt;
`"explicit"` requires the invitee to accept (via the `realm.me`
membership self-service surface / your UI), except when the
invitation is their only membership in the realm. Either way a
multi-tenant user's login response returns the full `tenants[]` array
and the SPA shows the picker (§4.3).

### 5.3 Updating a user's role

```ts
await realm.tenants.updateUserRole(tenantId, userId, "admin");
```

```go
_, err := realm.Tenants.UpdateUserRole(ctx, tenantID, userID, "admin")
```

The role value is validated against the realm catalog (§2.3) — both
the invite-user and edit-user-role UI flows should populate their
role pickers from `realm.roles.list()` (filtered through the SDK's
`isRoleSeatable`) rather than hard-coding names. Setting a user's
role to `owner` is rejected — use `Tenants.TransferOwner` instead.
Demoting the last owner returns `RealmError(last_owner)`.

**Who may seat whom (ADR-101 D6, issuer `v0.112.0`):** all four
seating paths — invite, role change, bulk import, service-account
create — share one rule. The tenant **owner** may seat anyone
(except `owner`); anyone else with the relevant manage permission may
seat only roles that confer **no** authority (derived from the
ADR-074 catalog — any grant whose action is not `read` counts), so a
`users:manage` holder can no longer promote themselves. Build your
role pickers to expect the `403` rather than special-casing names.

Once updated, the change is reflected in the next access token your
user receives. If you mirror the role locally, refresh your local
copy from the JWT on every request (don't write a separate sync job).

### 5.4 Stashing partner-side metadata on a tenant

RealmID's `tenants.config` is a closed allowlist
(`mfa_policy`, `signup_mode`, `role_overrides`,
`default_invitation_role` today). It is **not** a general
metadata bag — you cannot stash partner-side foreign keys
(e.g. `external_company_id`, `crm_account_uuid`) on the RI tenant.
Keep that mapping in your own database, keyed on the RI tenant UUID
(which you receive in the JWT and in `realm.tenants.get`).

If you need a free-form metadata bag on RI tenants, file a feature
request — this is on the open list.

### 5.5 Tenant deletion and suspension

RealmID tenants have a `status` column with three values:
`active`, `suspended`, `deactivated`. Lifecycle:

- **Suspend** (`PATCH /tenants/{id}` with `status: "suspended"`) —
  blocks new logins for the tenant and rejects `/auth/token` calls
  for refresh tokens scoped to it. Existing access tokens stay
  valid until natural expiry. Pending invitations are not auto-
  revoked. Reversible: flip `status` back to `active`.
- **Soft delete** (`DELETE /tenants/{id}`) — sets
  `status: "deactivated"` and stamps `deleted_at`. Same auth-blocking
  semantics as suspend, plus the tenant disappears from
  `tenants.list`. Pending invitations remain in the DB but cannot
  be accepted (login pipeline filters by status). Recoverable only
  via direct SQL.
- **Hard delete** — not exposed via the SDK or REST. If you need
  GDPR-style data erasure, use the soft-delete + a separate
  scrubbing job; coordinate with RealmID ops.

Outstanding refresh tokens for a suspended/deactivated tenant
become unusable on the next mint attempt. Sessions remain in
`/auth/sessions` listings until they're explicitly revoked or
expire — the tenant status doesn't auto-revoke them.

### 5.6 Tenant create

```ts
const tnt = await realm.tenants.create({
  displayName: "Acme",
  signupMode: "allowlist",
  owner: { email: "founder@acme.com" },   // REQUIRED — see below
});
```

```go
tnt, err := realm.Tenants.Create(ctx, realmid.TenantCreate{
    DisplayName: "Acme",
    SignupMode:  realmid.SignupModeAllowlist,
    Owner:       &realmid.TenantOwner{Email: "founder@acme.com"},
})
```

The realm is implicit (the API key's realm). The SDK routes this to
`POST /platforms/{realmId}/tenants`; partners have one platform per
realm so no `platform` parameter is needed.

**The owner is seated inline, in the same transaction, and is
REQUIRED** (`400 owner_required` otherwise) — `tenants.owner_user_id`
is NOT NULL since ADR-073 Amendment C. An earlier revision said to
follow up with an invitation carrying `role: "owner"`; that back door
was retired (`owner_not_invitable`, §5.2). The `owner` block takes at
least one of `email`/`phone`, optionally a bring-your-own `user_id`
(useful for migrations — it becomes the `sub`), a `display_name`, and
optionally the exact first-SSO `provider`/`provider_uid` binding.
There is deliberately no role on it: ownership is the pointer, and
the owner's row holds the dormant `member` role.

Create is **idempotent on a caller-supplied `id`**: an existing
tenant in this realm reconciles instead of erroring; an id that
exists in another realm is `cross_realm_tenant_id`.

---

## 6. Long-lived clients (desktop, CLI, sync agents)

Desktop agents and headless sync workers can't run a browser-mode
SDK. Two patterns:

> **All long-lived clients refresh through the BFF.** Whether your
> realm has BFF mode on or not, the cleanest pattern is for desktop
> agents and CLIs to call your partner backend's `/auth/token` proxy
> route — the same one your SPA uses (§3.5). The agent never holds
> a `rk_live_…`; only your backend does. Point the agent at
> `https://api.partner.com` and the SDK's token manager (below)
> works without modification. This eliminates the "different
> endpoints for browsers vs agents" footgun and means revoking the
> partner API key has no effect on user sessions.

### 6.1 User-refresh-token model (recommended)

The agent holds a refresh token obtained via an interactive
install-time browser login. The agent mints access tokens against
RealmID directly using the SDK's verify-and-token surface.

**Install-time flow:**

1. Installer launches the system browser to a setup page in your SPA
   (`https://app.partner.com/agent/setup`).
2. Installer opens a one-shot loopback HTTP listener on
   `127.0.0.1:<random-port>`.
3. The setup page (already authed by the user via your normal login
   flow) calls `realm.auth.token({ tenantId })` to mint a fresh
   refresh+access pair, POSTs the refresh token to the loopback URL,
   shows "you can close this tab now."
4. Agent persists the refresh token (DPAPI on Windows, Keychain on
   macOS, libsecret on Linux). Never write it to plain disk.

**Runtime:**

```go
realm, _ := realmid.NewRealm(realmid.Config{
    // Point at YOUR backend, not auth.realmid.dev. The BFF proxy
    // route forwards /auth/token to RealmID with the platform
    // token attached. Same as the SPA's setup.
    BaseURL: "https://api.partner.com",
    RealmID: cfg.RealmID,
    // No APIKey — agent operates as a user, not a platform.
    // Your BFF holds the rk_live_…; the agent never touches it.
})

mgr := realm.Auth.NewTokenManager(refreshToken)
for {
    accessToken, err := mgr.AccessToken(ctx)
    if err != nil { /* refresh died — re-launch install flow */ }
    callPartnerBackend(accessToken)
    time.Sleep(...)
}
```

The token manager refreshes 60 s before expiry, rotates the persisted
refresh on every call, and surfaces `RealmError(refresh_invalid)` if
the user revokes the session (§4.5) — your agent should treat this as
"re-auth required" UI state and re-run the install-time flow.

> **Crash window during refresh rotation.** RealmID rotates the
> refresh token on every successful `/auth/token` call and
> invalidates the old one **immediately** — there is no grace
> period today. If your agent crashes between RI's response and the
> on-disk persist, the next start has the old (now-invalid) refresh
> and is locked out. Two mitigations:
>
> 1. **Persist before use.** Write the new refresh token to disk
>    *before* the agent starts using the new access token; treat the
>    persist as the commit point. The token manager in the SDK does
>    this when you give it a `RefreshSink` callback.
> 2. **Loopback re-onboarding fallback.** Treat
>    `RealmError(refresh_invalid)` exactly like a revoked session:
>    surface "re-auth required" and re-run the install-time browser
>    flow. This is a once-per-incident UX cost, not a steady-state
>    cost.

### 6.2 API-key model

If the long-lived caller is a service-to-service integration with no
human owner, mint a dedicated API key (§2.4) and have the caller
exchange it for a platform token via `grant_type: "platform_api_key"`
on `/auth/login`. The Go and TS SDKs do this transparently when
constructed with `apiKey`.

Don't use this pattern for human-installed agents — API keys can't be
self-serve revoked from the sessions UI, and `last_used_at` is the
only telemetry you get.

> **A platform API key is realm-wide.** A `rk_live_…` bound to the
> realm's `platform_api` user mints platform tokens that act across
> every tenant in the realm — that is what makes it the BFF
> credential, and why it must never reach a client. To bound a
> long-lived caller to one tenant or a narrower authority you now
> have two first-class options: the user-refresh-token model (§6.1)
> with a dedicated `kind=service` account seated in that tenant, or
> an **end-user API key** (§9.5, ADR-084/100) — org-pinned,
> capped (`permissions_cap`), individually revocable, and minted by
> the user it acts as.

---

## 7. Migrating from a self-issued auth system

The common case: you already have an auth system that mints its own
JWTs (or sessions, or Firebase-backed bespoke tokens) and want to
move identity onto RealmID without forcing every user to re-login at
the same instant.

### 7.1 Dual-verifier mode

Make your backend accept tokens from *both* sources for a window:

```go
func authMiddleware(legacyVerify, realmVerify VerifyFunc, next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        tok := bearerFrom(r)
        // Try RealmID first — its tokens have a recognizable iss.
        if claims, err := realmVerify(r.Context(), tok); err == nil {
            next.ServeHTTP(w, r.WithContext(realmid.WithClaims(r.Context(), claims)))
            return
        }
        // Fall back to your legacy verifier.
        if claims, err := legacyVerify(r.Context(), tok); err == nil {
            next.ServeHTTP(w, r.WithContext(legacyClaimsCtx(r.Context(), claims)))
            return
        }
        http.Error(w, "unauthorized", 401)
    })
}
```

Ship this *before* any frontend starts asking for RealmID tokens.
Once your frontend is flipped, the legacy path keeps existing
sessions alive until they expire naturally; new sessions are
RealmID-issued.

### 7.2 Backfill via bulk import (or invitations)

**The first-class migration path is the ADR-073 bulk import**, which
this section predates: `tenants.create` with a bring-your-own tenant
id + inline owner (§5.6), then `tenants.users.importUsers` — a
two-phase, whole-file-atomic import whose rows may bring their own
`user_id` (it becomes `users.id`, and therefore the future `sub`) so
every FK in your database survives the move. When `committed` is
false **nothing** was written and each failing row carries
`error` + `error_hint`. Users land `active`, not `invited`.

Invitations remain the right tool for a *trickle* migration:

```go
for _, u := range existingUsers {
    _, err := realm.Tenants.Invitations.Create(ctx, u.TenantID,
        realmid.InvitationCreate{
            Identifier: u.Phone,   // one string: email or E.164 phone
            Role:       u.Role,    // a CATALOG role (§2.3), not your product role
        })
    if err != nil { log.Printf("backfill %s: %v", u.ID, err); continue }
}
```

Re-running is safe: a still-pending duplicate is an idempotent
success, and only a live membership errors (`409 already_member` — an
earlier revision checked a `realmid.ErrInvitationExists` sentinel
that has never existed in the Go SDK). You don't migrate
`firebase_uid` or any other IdP-side identifier: the invitation
matches on phone/email when the user next logs in, and RealmID links
the IdP identity at that moment.

### 7.3 Cutover and rollback

When the dual-verifier has been in production for a few days and
backfill has run, flip the SPA to talk to RealmID (or your BFF).
Existing sessions die at the flip — their legacy-issued tokens won't
verify against the RealmID JWKS. Users re-login once via the IdP
(typically sub-30-second OTP). UX-acceptable for almost every app.

Rollback: flip the SPA flag back. The legacy verifier is still in
your middleware; legacy issuance still works. Anyone who joined
during the RealmID window can still log in via your legacy
`/auth/login` (which they'll already be in your DB for, post-
backfill).

After a clean soak (recommend 7 days), delete the legacy issuer,
verifier, refresh-token store, and any IdP-verification code. From
that point, RealmID owns identity exclusively.

---

## 8. Operations

### 8.1 API key rotation

```ts
const next = await realm.apiKeys.create({ scope: "platform", label: "partner-backend (2026-Q3)" });
// Deploy `next.value` to your secret store; reload the backend.
// Confirm `realm.apiKeys.list()` shows a fresh `last_used_at` on the new key.
await realm.apiKeys.revoke(oldKeyId);
```

Rotate per-environment, not all at once. The platform-token cache in
the SDK invalidates on `unauthorized` automatically; one mint cycle
later your backend is on the new key. Two constraints shape the
choreography (§2.4): keys **expire after 90 days by default**, so
rotation is a calendar obligation rather than good hygiene; and the
mint must come from a WIF session or an owner login — a platform key
cannot mint its successor (`api_key_cannot_mint_api_key`).

### 8.2 Origin policy and dev realms

Origins are not a config key (an earlier revision showed
`config.update({ origins })` — no such key exists): the accepted
origins derive from the realm's claimed/bound domains and are read
back via `realm.origins.list()`; the `origin_enforcement` config key
controls whether they are enforced on browser login traffic. The
recommended pattern for local + staging work is **a separate dev
realm**. Reasons:

- An incident or stolen API key in a dev realm has zero blast radius
  on production users.
- You can safely experiment with custom-claim allowlists, TTLs, and
  other realm config in dev without coordinating with prod.
- JWKS rotation cadence and caching live at the realm level —
  testing rotation behavior in isolation is much easier with a
  dedicated realm.

### 8.3 Rate limits

One limiter exists today, and an earlier revision of this section
invented several that don't — corrected to what the service actually
enforces:

- **Public auth surface** (`/auth/login`, `/auth/token`,
  `/auth/refresh`, `/auth/otp/*`) — **per-IP token bucket: 5 req/s
  sustained, burst 20** (operator-tunable). Generous for a human or a
  SPA, hostile to credential stuffing. It is per-IP and per-replica,
  so a well-behaved BFF is effectively never the party throttled.
- The SDK's platform-token cache means a healthy backend mints
  roughly once per token TTL (default 5 min) per process; bursts only
  occur on cold start or after a 401 forces a re-mint.
- **Admin REST** (`/platforms/*`, `/tenants/*`) has **no
  service-level rate limit today** — a backfill loop is bounded by
  the database, not a throttle. Pace large imports anyway (or better,
  use the atomic bulk import, §7.2), and still handle `rate_limited`
  + `Retry-After` defensively: a shared, Redis-backed budget is a
  known follow-up and these numbers are not contractual.

### 8.4 Realm config reference

`realm.config.update(patch)` accepts these keys:

| Key                                      | Type         | Default | Notes                                              |
|------------------------------------------|--------------|---------|----------------------------------------------------|
| `access_ttl_seconds`                     | int          | 900     | 60 ≤ x ≤ 3600                                      |
| `refresh_ttl_seconds`                    | int          | 2592000 | 3600 ≤ x ≤ 31536000                                |
| `concurrent_session_limit`               | int          | 0       | 0 = unlimited. Counted **per realm** (across all tenants the user belongs to in this realm), not per tenant. **Evict-oldest**: when a new login pushes the count over the limit, the oldest active sessions are revoked FIFO so the new login succeeds. The HTTP response is 412 `session_limit_reached` carrying a `revocationToken` + the list of sessions that *would* be evicted, so the client SDK can prompt the user before committing if it wants an interactive "kick a device" UX; calling `/auth/login` again with the `revocationToken` confirms eviction. |
| `default_invitation_role`                | string       | `member`| Must be in role catalog; can't be `owner`          |
| `access_token_custom_claim_keys`         | string[]     | `[]`    | Allowlist of keys you may pass to `/auth/token`    |
| `refresh_absolute_expiry`                | object       | `{}`    | ADR-054. Wall-clock scheduled refresh-token expiry. Shape: `{ mode: "rolling" \| "scheduled", daily_cutoff_local: "HH:MM", timezone: "<IANA>" }`. Default `mode: "rolling"` preserves the rolling-TTL behaviour. When `mode: "scheduled"`, every refresh token (user, service, platform) expires at `min(now + refresh_ttl_seconds, next daily_cutoff_local in timezone)`. Example for "force daily re-login at 8 PM IST": `{ mode: "scheduled", daily_cutoff_local: "20:00", timezone: "Asia/Kolkata" }`. Note: with scheduled mode, `refresh_ttl_seconds` reads as a *ceiling*, not a guaranteed lifetime — tokens minted close to the cutoff expire sooner. Realm-level only (no per-tenant override). |

Unknown keys return `RealmError(unknown_config_key)`; out-of-range
values return `RealmError(invalid_config_value)`. (`require_bff_login`
used to sit in this table; ADR-088 removed the key — §1.2.)

This table is the subset most partners touch, not the whole surface —
the key set is server-owned and larger (session/idle TTLs, OTP knobs,
MFA policy, signing-key rotation, `origin_enforcement`, the
`user_api_keys.*` group, `invitation_acceptance`, …). Read the live
set back with `realm.config.get()`: every allowlisted key is always
present, and the zero value means "unset".

### 8.5 Common errors

| Code                          | Cause                                                   | Remedy                                            |
|-------------------------------|----------------------------------------------------------|---------------------------------------------------|
| `unauthorized`                | API key invalid or revoked                               | Rotate key, redeploy                              |
| `bff_bearer_required`         | Caller hit `/auth/*` without a platform token (§1.2)     | Use SDK `realm.auth.*` methods, not raw browser HTTP |
| `realm_origin_mismatch`       | Body `realm_id` doesn't match Origin's resolved realm    | Drop one or fix the other                         |
| `mfa_required`                | Realm/tenant requires MFA (HTTP 412)                     | Drive `mfaVerify` flow (§4.4)                     |
| `unknown_role`                | Role name not in realm catalog                           | Read the catalog (`realm.roles.list`) — authoring is retired, §2.3 |
| `identifier_collision`        | Identifier already held in the tenant (409)              | Look up the existing member                       |
| `already_member`              | Invitee already holds a live membership (409)            | Safe to treat as done                             |
| `owner_not_invitable`         | Invitation or role update named `owner`                  | Use `transferOwner` (§5.3)                        |
| `refresh_invalid`             | Refresh token expired or revoked                         | Redirect to login                                 |
| `role_authoring_retired`      | Role create/patch/delete/rename on a partner realm (403) | Product roles are scopes (§2.3)                   |

(`missing_platform_token`, `unknown_origin`, `invitation_exists` and
`tenant_locked_session` appeared in earlier revisions; none of those
codes exist in the issuer today.)

Full catalog: [`error-reference.md`](./error-reference.md).

### 8.6 Auditing and event export

`GET /platforms/{id}/audit-events` returns the RealmID-originated
events for your platform (ADR-055). Same row shape as the internal
ops console feed; scoped (and forced) to the platform in the path
so a caller can never read another platform's audit trail.

**Auth.** Either a platform admin user JWT, or a platform token
minted from an API key (`/auth/login` with
`grant_type: "platform_api_key"` — the SDK does this for you).
Compliance ingest is typically a backend job — use the API-key path.

**Pagination.** Cursor-paginated; `cursor` is opaque (do not parse
it as a timestamp). Filter with `kind` (repeatable), `tenant_id`,
`actor_id`, `since`, `until` (unix seconds, half-open).

**Retention.** RealmID retains 400 days of events. Pull at least
once per quarter to maintain a complete archive on your side. There
is no backfill; the feed begins at the moment the endpoint was
deployed in your environment.

**Delivery.** Pull only. Push-based webhooks / event streams are
**not** on the v1 roadmap.

**Event taxonomy** (kinds you'll see):

- `auth.login.success`, `auth.login.failure`, `auth.logout`,
  `auth.token.refresh`, `auth.token.revoke`, `auth.platform_token.mint`,
  `auth.otp.*`
- `mfa.enroll`, `mfa.confirm`, `mfa.disable`, `mfa.verify.success`,
  `mfa.verify.failure`, `mfa.lockout`
- `user.create`, `user.update`, `user.delete`, `user.role_change`,
  `user.invite`, `user.invite_accept`
- `tenant.create`, `tenant.update`, `tenant.delete`, `tenant.suspend`,
  `tenant.resume`
- `apikey.create`, `apikey.revoke`
- `role.create`, `role.update`, `role.delete`, `role.assign`,
  `role.unassign`
- `idp.create`, `idp.update`, `idp.delete`, `idp.toggle`
- `domain.claim`, `domain.verify`, `domain.bind`, `domain.detach`
- `platform.suspend`, `platform.unsuspend`, `platform.signup_mode_change`,
  `platform.note.create`, `platform.signing_keys.rotate`

> **Coverage note (updated 2026-05-26):** the auth-flow and
> user-lifecycle write sites are now wired and emitting:
> `auth.login.success`/`failure`, `auth.token.refresh`, `user.invite`,
> `user.invite_accept`, and `user.role_change` all land in the feed.
> The taxonomy and contract are stable — newly wired sites appear
> without any partner-side change.

**Example pull (Go):**

```go
resp, err := realm.AuditEvents.List(ctx, realmid.ListAuditEventsParams{
    Since: lastPullUnix,
    Kind:  []string{"auth.login.success", "auth.login.failure"},
    Limit: 200,
})
// resp.Items, resp.NextCursor — pass NextCursor back as Cursor until nil.
```

**Mirror writes you initiate (still useful).** The pull feed covers
RealmID-side events. For writes your BFF makes through the SDK, you
can still emit a row in your own audit log at the call site — every
call from your BFF is attributable to a request id you already
track. This complements (rather than replaces) the pull feed.

---

## 9. Cross-realm integrations (`realm.integrations.*`, ADR-082/083)

When one platform on RealmID needs to call **another** platform's APIs —
a recruiting product driving an assessment product, say — you do **not**
share credentials or invent a cross-tenant superuser role. Instead:

1. The **source** platform *publishes* an integration (once, at realm level).
2. The **target** org's owner *installs* it, **stating the exact ADR-074
   permissions** the integration may exercise. This admits a
   `kind=service` principal into their org.
3. The source platform *mints* short-lived access tokens against the
   installation to call the target's APIs.

It is GitHub-App-shaped: register once, install per org, mint on demand.
RealmID hosts no consent screen — **your console is the consent surface**, so
these methods are how you build install/uninstall UI (target) and the mint
call (source).

> The SDK is per-realm. `register`/`mintToken` run on the **source** realm's
> client; `install`/`listInstallations`/`uninstall` run on the **target**
> realm's client. The same method names exist on go (`realm.Integrations`),
> ts/web-admin (`realm.integrations` / `admin.integrations`) and java
> (`realm.integrations()`).

### 9.1 Source side — publish, then mint

```ts
// One-time: publish the integration in YOUR realm.
const integration = await sourceRealm.integrations.register({
  slug: "acme-recruiter",
  displayName: "Acme Recruiter",
});
// integration.id → hand to the target org owner out-of-band so they can install it.

// Per call into the target: mint a token. Authenticated by YOUR platform_api
// key (the raw key, NOT a user/session token). source_org_id names which of
// your orgs is acting — it is recorded in the target's audit.
const { access_token, expires_in } = await sourceRealm.integrations.mintToken({
  apiKey: process.env.REALMID_PLATFORM_API_KEY!,   // rk_live_…
  installationId,                                   // from the target's install
  sourceOrgId: "org-uuid-on-source",
});
// Call the target platform's API with `Authorization: Bearer ${access_token}`.
```

**The minted token is an access token only — there is no refresh token, and
it lasts a fixed 600 s (10 min).** This is deliberate and matches the
machine-to-machine standard (OAuth 2.0 client-credentials, GitHub App
installation tokens, AWS STS): the credential-holder (your backend, holding the
platform key) is always present to re-authenticate, so a refresh token would
add a standing cross-realm credential and buy nothing. **Do not wrap
`mintToken` in a token manager** — the token cannot be refreshed. Instead:

- call `mintToken` when you need a token and **cache it in memory for
  `< expires_in`** (e.g. re-mint at ~9 min), or
- simply re-mint per batch of calls; the mint is cheap.

Every mint re-validates the whole grant on the server (the installation is
still live, the chosen role still exists and is still service-typed, neither
org is suspended), so a token you get is always currently-valid — you never
have to check drift yourself.

Lifecycle of a published integration (source): `list()`, `update(id, patch)`,
`disable(id)` / `enable(id)` (reversible halt of all mints), and `remove(id)`
(permanent disable — your half of revocation; it does **not** erase the target
orgs' record that the integration existed).

### 9.2 Target side — install, review, uninstall

```ts
// The org owner installs a foreign integration into their org, STATING the
// exact ADR-074 catalog permissions it may exercise (ADR-101 D7). The old
// role-based install — author a ["service"] role, pass roleId — is gone:
// role authoring is retired (§2.3), and the issuer now takes a permissions
// list directly. Non-empty, every entry a real catalog key, and never
// exceeding what the installing owner could grant — all fail closed
// (permissions_required / permissions_exceed_grantor / install_grants_nothing).
// ⚠️ SDK lag (2026-08-31): the published go/ts/java `install()` clients
// still send the pre-ADR-101 `role_id` body, which a current issuer
// refuses with `400 permissions_required`. Until the SDKs re-release,
// POST the route directly (platform-token auth, like any admin call):
//
//   POST /tenants/{orgTenantId}/integration-installations
//   { "integration_id": integrationId,
//     "permissions": ["users:read"] }   // only what the integration needs

// The inbound-access list: who can act in my org, as what, last used.
const { items } = await targetRealm.integrations.listInstallations(orgTenantId);

// Withdraw consent. Future mints fail immediately; any token minted in the last
// ≤600 s stays valid until it expires (tokens are signature-verified, not
// revocable mid-life) — so treat 600 s as the revocation window.
await targetRealm.integrations.uninstall(orgTenantId, installationId);
```

**Surface the inbound list at ownership transfer.** When an org changes owner,
standing installations are carried over (they are not silently dropped), so the
new owner can inherit foreign access they never personally approved. Show a
non-zero `listInstallations` count prominently after a transfer so they can
review it.

### 9.3 Error codes

| Code | HTTP | Where |
| --- | --- | --- |
| `slug_taken` | 409 | `register` — slug already used in the realm |
| `permissions_required` | 400 | `install` — the stated grant is empty (or the pre-ADR-101 `role_id` body was sent) |
| `permissions_exceed_grantor` | 403 | `install` — the list names permissions the installing owner could not grant |
| `install_grants_nothing` | 403 | `install` — nothing in the list survives validation |
| `integration_disabled` | 400/403 | `install` / `mintToken` — the source disabled it |
| `already_installed` | 409 | `install` — a live installation already exists for this org |
| `installation_revoked` | 403 | `mintToken` — the target uninstalled |
| `key_class_mismatch` | 401 | `mintToken` — not a platform-class api key |
| `installation_not_found` | 404 | `mintToken` — unknown installation, **or a platform key from the wrong realm** |

(`role_not_service_typed`, `role_not_installable` and
`role_unavailable` belonged to the retired role-based install; current
issuers no longer emit them, though the SDK error unions still name
them for older servers.)

All surface on the usual `RealmError.code` / `RealmException.getCode()`.

## 9.5 End-user API keys (ADR-084)

Your users mint keys so third-party apps can call **your** API on their behalf:
*"User A mints Key 1 for a reporting bot with reports access only, Key 2 with
full access."* RealmID stores the key, enforces expiry, revocation and org
pinning, and hands you a token. **You enforce the scope.**

Two ADR-100 facts govern the mint itself: a key's authority is
**stated, never inferred** — `uncapped` is a required field on create
(`400 uncapped_required` without it), and `uncapped: true` additionally
needs the realm's `user_api_keys.allow_uncapped`, which defaults off
(`403 uncapped_not_allowed`). At exchange time the stored cap is
narrowed per-org against the `role_permissions` list your backend
supplies (`stored_cap ∩ role_permissions`); an empty intersection is a
`403` naming the org.

### 9.5.1 The one rule: `permissions_cap` is a CAP, not a grant

The key carries a `permissions_cap` array, and the minted access token repeats it
as a claim. It is a **ceiling on** the user's authority, never a source of it:

> **Effective authority = `permissions_cap` ∩ what the user is allowed RIGHT NOW.**

Both operands, every request. A cap can therefore only ever *under*-grant: demote
a user and every key they hold shrinks with them, automatically.

**Vulnerable — do not do this:**

```ts
// WRONG. Treats the cap as a grant.
function can(claims, permission) {
  return claims.permissions_cap.includes(permission);
}
```

That reads fine and is wrong in a way that will not show up in testing. The cap
was written when the key was minted. Demote the user, remove them from a team,
narrow a role — the token still asserts the old list, and this function still says
yes. You have built a credential that outlives the authority it was issued
against. (This is exactly why the field is named `permissions_cap` and not
`permissions`: the wrong version should *look* wrong.)

**Correct:**

```ts
import { capAllows } from "@realm-id/sdk";

const allowed = await capAllows(claims, "reports:read", () =>
  myDb.permissionsFor(claims.sub, claims.tenant_id), // YOUR live source of truth
);
```

```go
allowed := realmid.CapAllows(ctx, claims, "reports:read",
    func(ctx context.Context) ([]string, error) {
        return myDB.PermissionsFor(ctx, claims.Subject, claims.TenantID)
    })
```

```java
boolean allowed = CapCheck.capAllows(claims, "reports:read",
        () -> myDb.permissionsFor(claims.subject(), claims.tenantId()));
```

The resolver is a **required** argument in all three languages. That is
deliberate: the one-operand version above is not expressible through our API, so
you cannot reach for it by accident.

`capAllows` fails **closed** — false if the cap omits the permission, if your live
set omits it, or if your resolver throws. An unavailable live operand means the
intersection is unknown, and the only safe reading of an unknown intersection is
empty.

### 9.5.2 If you have no live permission model — read this

Be honest with yourself about which case you are in.

If your backend has no per-user permission store to intersect against, then
`capAllows` degenerates: the cap becomes your **whole** authority, which is the
stale-grant hole above with extra steps. **The cap is not self-securing.** What
still protects you in that situation is what RealmID enforces regardless:

- **Revocation** — a revoked key stops working at the next exchange, and it also
  kills sessions already minted from it.
- **Expiry** — enforced at create, at exchange, and on every refresh.
- **Org pinning** — a key can only ever mint into orgs its holder still belongs
  to, re-resolved at every exchange.
- **The revoke sweep** — keys whose whole scope became unreachable get retired.

Those are real controls. They are just not *authorization*. If you need per-key
authorization, build the live permission model first; treat the cap as a
convenience for narrowing, not a substitute.

### 9.5.3 The vocabulary is yours

For a partner-audience key, RealmID treats `permissions_cap` entries as **opaque
strings** — validated for count and length only, never interpreted. Use whatever
vocabulary your API already speaks (`reports.read`, `invoices:list`, anything).

RealmID never pattern-matches, expands, or orders them: **no wildcards, no
hierarchy, no implied `*`**. `users:*` does not satisfy `users:read`, `users` does
not match `users:read`, and comparison is case-sensitive. If you want hierarchy,
expand it yourself in your live resolver.

We deliberately do **not** store your catalog. The second operand of the
intersection — what a user may do right now — lives in your database, which we
never see, so we could not do the intersection for you under any storage scheme.
A stored copy would only go stale.

### 9.5.4 Staleness, and why every case fails closed

| Event | Effect |
|---|---|
| A role loses a permission | Live resolution shrinks on the next request |
| You rename a permission | The old cap string goes inert → under-grant |
| A role is deleted and recreated broader | The key tracks the user's new authority **up to the cap** |
| A key is revoked | Next exchange fails, and existing sessions stop refreshing |
| The user leaves a pinned org | That org drops out at the next exchange |

The third row is inherent and correct: **a cap is not a snapshot.** It is
documented so nobody reads it as a bug.

### 9.5.5 MFA

A key is used with **no human present**, so MFA can only bind at mint time. Two
consequences:

- Minting is a step-up operation under
  `user_api_keys.require_mfa_at_mint`, which **defaults ON** (unset
  means on; a realm must explicitly set it false to opt out) — expect
  a `412 mfa_required` with a challenge.
- A key-derived token carries `amr: ["api_key"]` with **no** `mfa` entry, so it
  can never satisfy a step-up gate. If your API step-ups an operation, a key
  cannot perform it. That is intended, not a limitation to work around.

## 10. Known SDK gaps

These SPEC capabilities are not yet first-class methods. None block
the integration patterns in §1–§8; workarounds are noted inline.

- **MFA enroll/disable as BFF proxy routes** — the SDK ships
  the *admin* surfaces (`tenants.users.enrollMfa` etc.) and the
  self-service `selfEnrollMfa` / `disableMfa` (SPEC §4.8). If you need
  to mount the raw `/auth/mfa/enroll` server route as a partner-proxy
  for a hand-rolled self-service TOTP flow, the underlying endpoint
  exists. (There is no `/auth/mfa/confirm` — confirmation folds into
  `/auth/mfa/verify` via the enroll-scoped challenge per ADR-061.)
- **Realm / platform create** — partner onboarding (creating a brand
  new realm) is operator-driven via the RealmID admin UI or direct
  REST. The SDK does not expose realm create today; it isn't needed
  for in-realm work.
- **Pre-provisioning at invite time (stable user id).** As of the
  v0.11.x contact model (ADR-042), `invitations.create(...)` allocates
  the user's **final, stable `users.id` up front** — it does not change
  on first login. The invite inserts a `users` row in `status='invited'`
  plus a `user_contacts` row; first successful login resolves that same
  row by contact, flips it to `active`, and reuses the id. That id
  equals the `sub` claim in the user's first access token, so it is safe
  to key partner-side records (e.g. per-user child rows) on it at invite
  time. The invited user already appears in `tenants.users.list` (status
  `invited`); no separate placeholder list is required.
- **No cross-tenant person identity.** RealmID's `sub` is
  per-`(user, tenant)` by design — the same human in tenants A and B
  has two distinct `sub` values, and there is no first-class
  `person_id` that links them. This is a deliberate privacy
  boundary: it prevents a compromised or curious tenant admin from
  enumerating "which other tenants is this user a member of?" via
  identity alone. Partners that need a single durable per-human
  identifier (e.g. for a global directory, cross-org reporting, or
  consent ledgers) maintain that mapping locally: key on the
  verified IdP identifier (Firebase UID, Google sub, verified phone),
  store `person_id → [sub, …]` in your DB, and look it up at
  request time. The `tenants[]` array returned from `/auth/login`
  for a multi-tenant user gives you the full set of
  `(tenant_id, sub)` pairs for the same Firebase identity in one
  round-trip — that's the join point.

Check `sdk/CHANGELOG.md` for the latest status. File issues at
https://github.com/Realm-ID/sdk.
