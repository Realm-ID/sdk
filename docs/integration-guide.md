# Integration Guide

This is the end-to-end guide for wiring a partner application onto
RealmID. It assumes nothing beyond a running RealmID install
(`auth.realmid.dev` or your own), an SDK in your language of choice,
and a partner application you control end-to-end. Read it once
top-to-bottom; you should be able to ship a full integration without
referring to anything else (server-side ADRs, support, etc.).

If anything in this guide disagrees with [`SPEC.md`](../SPEC.md), the
SPEC wins — file an issue.

---

## 0. What you'll have at the end

- A **realm** in RealmID, owned by you, with a verified custom domain,
  one or more tenants, and a per-realm role catalog.
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

### 1.2 BFF mode (recommended)

By default RealmID's `/auth/*` endpoints accept calls from any origin
your realm has whitelisted. That is fine for greenfield apps but
forces the SPA to be the source of truth for "the user is logged in"
— which means the access token lives in JavaScript, refresh-on-401 is
your problem, and revocation is best-effort.

**BFF mode** flips a single config flag
(`require_bff_login=true`) on the realm. After that,
RealmID rejects any caller of `/auth/login` (and friends) that does
not present a valid platform token. Your backend becomes the only
caller. The SPA hits *your* `/auth/*` routes, which proxy through to
RealmID with the platform token attached. Refresh tokens become
HttpOnly cookies; access tokens never touch JS storage.

> **BFF scope is realm-wide, not just `/auth/login`.** Once
> `require_bff_login` is set, *every* `/auth/*` call
> against the realm requires the partner platform token —
> `/auth/login`, `/auth/token` (refresh), `/auth/logout`,
> `/auth/sessions/*`, `/auth/mfa/*`. This is the right model: it
> means **long-lived clients** (desktop agents, sync workers, CLIs —
> §6) refresh through the same BFF proxy routes your SPA uses. The
> agent points at `https://api.partner.com/auth/token` instead of
> `https://auth.realmid.dev/auth/token`; the BFF attaches the
> platform token, forwards to RealmID, returns the response
> verbatim. No second realm, no per-client mode, no special-case
> code path.

Use BFF unless you have a hard reason not to. The SDK supports both
modes from the same `Realm` handle.

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

const claim = await realm.domains.claim("partner.example.com");
console.log("Add this DNS TXT record:", claim.dnsRecord);

// ...wait for DNS propagation, then:
await realm.domains.verify(claim.claimToken);
```

```go
// go equivalent
realm, _ := realmid.NewRealm(realmid.Config{
    RealmID: os.Getenv("REALM_ID"),
    APIKey:  os.Getenv("REALMID_OPS_API_KEY"),
})
claim, _ := realm.Domains.Claim(ctx, "partner.example.com")
fmt.Println("Add this DNS TXT record:", claim.DNSRecord)
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

Once created, register the origins your SPA will load from
(`https://app.partner.com`, dev origins, etc.) via `realm.config`:

```ts
await realm.config.update({
  // see §9.2 for the full key reference
  access_ttl_seconds: 900,
  refresh_ttl_seconds: 2592000,
  concurrent_session_limit: 0,             // 0 = unlimited
  require_bff_login: true,   // BFF mode (§1.2)
  default_invitation_role: "viewer",       // see warning below
  // Per-realm Firebase project — RealmID verifies Firebase ID tokens
  // using YOUR project's keys. SMS billing stays on your account.
  // The webapp continues to call Firebase Auth directly to obtain
  // the OTP / ID token; only the verify step moves to RealmID.
  auth_config: { firebase_project_id: "partner-prod" },
});
```

`config.update` is a thin wrapper over `PATCH /platforms/{id}/config`.
The SDK takes a `Record<string, unknown>` / `map[string]any` because
the key set evolves; see §9.2 for the live list and validation rules.

> **`default_invitation_role` is a platform decision.** RealmID's
> two system roles (`owner`, `member`) carry no meaning in *your*
> RBAC — `member` just means "exists in the tenant." Setting
> `default_invitation_role: "member"` is a valid choice if your app
> treats "exists in tenant" as the lowest-privilege baseline and
> gates features one role at a time on top. If you want a richer
> baseline, declare a custom role (§2.3) and use that as the
> default. RealmID rejects `default_invitation_role: "owner"`
> outright — it would turn every silent invitation into a privilege
> escalation.

> **Firebase ownership.** RealmID's Firebase verifier is configured
> per-realm via `auth_config.firebase_project_id`. You hand over the
> *project ID only* — no service-account JSON — and RealmID verifies
> incoming Firebase ID tokens using Google's public keys. The webapp
> still talks directly to your Firebase project for OTP send/verify
> and Google sign-in; only the resulting ID token is handed to
> RealmID. SMS quota and billing stay on your Firebase project.

### 2.3 Declare the role catalog

This is a **mandatory** bootstrap step, not an optional one. RealmID
ships with two system roles only — `owner` and `member` — and
neither carries any meaning in your application's RBAC. Every role
your app actually gates on (`admin`, `accounts`, `salesman`,
`dispatch`, whatever your domain calls them) must be declared here
before users can be invited with that role.

```ts
await realm.roles.create({ name: "admin",    permissions: [] });
await realm.roles.create({ name: "accounts", permissions: [] });
await realm.roles.create({ name: "salesman", permissions: [] });
await realm.roles.create({ name: "dispatch", permissions: [] });
```

```go
_, _ = realm.Roles.Create(ctx, realmid.RoleCreate{Name: "admin"})
_, _ = realm.Roles.Create(ctx, realmid.RoleCreate{Name: "accounts"})
// ...
```

Notes:
- `permissions` is stored but not yet surfaced as a JWT claim
  (roadmap). For now, gate authorization on the `role` name.
- `admin` typically already exists as a default custom role on new
  realms; the create call is idempotent — it returns
  `RealmError(role_exists)` which you can ignore.
- After this call, any invitation or role update referencing a name
  not in the catalog returns `RealmError(unknown_role)`.

**Driving partner UIs from the catalog.** Once declared, the role
catalog is queryable. Your invite-user and edit-user-role screens
should populate their role-picker dropdowns from the live catalog
rather than hard-coding role names — this way the UI stays in sync
when you add or rename a role:

```ts
const { items: roles } = await realm.roles.list();
// roles: [{ name: "owner", system: true, ... }, { name: "admin", ... }, ...]
```

```go
page, _ := realm.Roles.List(ctx, nil)
for _, r := range page.Items {
    // r.Name, r.System (true for owner/member), r.Permissions, r.CreatedAt
}
```

Filter out `owner` from the picker — it's not assignable via
invite or role update; ownership is set on tenant create and
transferred via `Tenants.TransferOwner` (§5.3).

### 2.4 Mint a partner API key

```ts
const key = await realm.apiKeys.create({ display_name: "partner-backend" });
console.log("Save this — it will not be shown again:", key.token);
```

`token` is the raw `rk_live_…` value. Stash it in your secret store
(GCP Secret Manager, AWS Secrets Manager, Vault). RealmID stores only
its hash; subsequent `apiKeys.list` returns metadata only.

You may want a second key for ops scripts and a third for any sync
clients. Each key is independently revocable and tracked with
`last_used_at`.

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
    MFAProtectedPaths: []string{"/admin/*"},
})(mux)

http.ListenAndServe(":3000", handler)
```

What the middleware does:

1. Pulls the bearer token from `Authorization: Bearer …`.
2. Verifies signature against the realm's JWKS (cached 10 min,
   unknown-kid forces refetch).
3. Verifies `iss`, `aud`, `exp`, `nbf`.
4. If BFF mode is on, also mounts `POST /auth/login`, `/auth/token`,
   `/auth/logout`, `/auth/mfa/verify`, `GET /auth/sessions`,
   `DELETE /auth/sessions/{id}`, `DELETE /auth/sessions`. These are
   the proxy routes the SPA will call.
5. Attaches verified claims to the request (`req.realmid` in TS,
   `realmid.ClaimsFrom(ctx)` in Go).
6. Honors `mfaProtectedPaths`: routes whose path matches return 401
   `mfa_required` if the access token lacks an `amr` claim including
   `mfa`.

### 3.2 Verify-only mode

If your service only verifies tokens minted by an upstream gateway
(common in microservices), skip the middleware and use the verifier:

```ts
import { createVerifier } from "@realm-id/sdk";

const verifier = createVerifier({
  baseUrl:  "https://auth.realmid.dev",
  realmId:  process.env.REALM_ID!,
  audience: process.env.REALM_AUDIENCE!,
});

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
func authMiddleware(v *realmid.Verifier, next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
        claims, err := v.Verify(r.Context(), tok)
        if err != nil {
            http.Error(w, err.Error(), http.StatusUnauthorized)
            return
        }
        ctx := realmid.WithClaims(r.Context(), claims)
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
| `role`         | string   | Role name from the realm catalog (this tenant only).    |
| `email`        | string   | Verified by the upstream IdP. May be empty.             |
| `phone`        | string   | Same. May be empty.                                     |
| `display_name` | string   | Self-reported.                                          |
| `iss`, `aud`, `exp`, `nbf`, `iat`, `jti` | — | Standard JWT.            |
| `amr`          | string[] | Auth methods used; includes `"mfa"` if MFA was passed.  |
| custom claims  | varies   | Any keys allowed by `access_token_custom_claim_keys`.   |

Do not fetch the user from RealmID on every request. The token is the
truth.

> **Custom claims — who supplies values, when.** RealmID does not
> compute or persist custom-claim *values*. The allowlist
> (`access_token_custom_claim_keys`, §8.4) names the keys you are
> *permitted* to pass; values are supplied **per-call** by the BFF
> in the `custom_claims` field of the `/auth/token` request body,
> and the issuer copies them verbatim into the minted access token.
> Unknown keys (not in the allowlist) reject with `bad_request` at
> mint time; reserved JWT names (`iss`, `sub`, `aud`, `iat`, `nbf`,
> `exp`, `jti`, `azp`, `tenant_id`, `role`) are silently dropped.
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

> **Mutating a user's email or phone is not supported today.** There
> is no `PATCH /tenants/{id}/users/{uid}` surface that accepts an
> identifier change — only `status` and `role` are mutable. If a
> user's phone or email needs to change, the workaround is:
> deactivate the existing user, invite a fresh row with the new
> identifier, and have the user re-link their IdP identity on next
> login. **Caveat:** the per-tenant unique indexes
> (`UNIQUE (tenant_id, lower(email))`, `UNIQUE (tenant_id, phone)`)
> stay held by the deactivated row, so the *old* identifier slot is
> not reusable for a different person without a hard delete (RealmID
> ops). First-class identifier mutation is on the roadmap as part of
> ADR-042 (provider-anchored login + `user_auth_methods` cleanup);
> until then, treat phone/email as effectively immutable from the
> partner side.

> **Identifier uniqueness within a tenant.** RealmID enforces
> uniqueness of email and phone on the user record within a tenant
> (`UNIQUE (tenant_id, lower(email))` and `UNIQUE (tenant_id, phone)`).
> A duplicate user-row insert is rejected. Today's invitation create
> path does NOT pre-check against existing users in the tenant —
> the conflict surfaces at *accept* time with a generic 409 from
> the underlying constraint. A future change (ADR-042) generalizes
> this to "identifier uniqueness" across all contact kinds with a
> first-class `identifier_collision` error and an invite-time
> pre-check carrying the existing-user details. Until that ships,
> if your domain requires you to render "this phone is already
> mapped to user X" in the invite UI, do the pre-check on your side
> against your local users mirror.

### 3.5 BFF login proxy

If you set `require_bff_login=true`, the SPA cannot
talk to RealmID directly. Your backend proxies. The drop-in
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
`/tenants/…` writes — the issuer checks `tenant_id ==
realm.admin_tenant_id` and `role == "owner"`.

**Discovery — finding your realm and admin-tenant ids.** Two
endpoints the admin SPA calls after login:

```ts
const me = await realm.identity.me();
// me.userId, me.email, me.isRealmStaff, me.ownedPlatformsCount,
// me.memberships: [{ tenantId, platformId, displayName, role }]

const mine = await realm.platforms.mine({ pageSize: 50 });
// mine.items: [{ id, domain, adminTenantId, displayName, mfaSessionTtlSeconds }]
```

`me.memberships[].platformId === mine.items[].id` lets the SPA pair
the caller's tenant memberships with the realms they own; the
matching item's `adminTenantId` is what you pass to subsequent
admin-scoped calls (invitations, role updates, etc.).

**SDK shape — admin handle from a user token.** The browser SDK
constructed with `baseUrl` pointed at your BFF and a bearer-token
strategy attaches the caller's session token to every request.
The same resource classes (`realm.tenants`, `realm.roles`,
`realm.config`, `realm.tenants.invitations`,
`realm.tenants.updateUserRole`, `realm.tenants.users.resetMfa`, …)
that work with `apiKey` work here — the authorising token is just
different. **Do not pass `apiKey` in the browser**; let the BFF
proxy forward the user's `Authorization` header.

```ts
// admin SPA — admin tenant owner is logged in
const realm = createRealm({
  baseUrl: import.meta.env.VITE_API_BASE_URL,   // your BFF
});

// invite another platform-admin into the admin tenant
const { adminTenantId } = (await realm.platforms.mine()).items[0];
await realm.tenants.invitations.create(adminTenantId, {
  identifier: { email: "ops-2@partner.com" },
  role:       "owner",
});

// create a customer tenant
await realm.tenants.create({
  displayName: "Acme",
  signupMode:  "allowlist",
});
```

**Onboarding additional admin staff.** Use the same
`invitations.create` against the admin tenant id with `role:
"owner"`. The invitee logs in via the IdP, lands in the admin
tenant as an owner, and inherits the full management surface. The
**last-owner guard** prevents demoting or removing the final owner
(`RealmError(last_owner)`); plan for at least two owners per admin
tenant in production.

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
| Create / list / revoke API keys    | ✓              | ✓                   |
| Update realm config                | ✓              | ✓                   |
| Create / rename / delete roles     | ✓              | ✓                   |
| **Mutate user phone / email**      | —              | —                   |
| `/admin/*` cross-platform surface  | —              | —                   |

The two "—" rows are partner-uncallable today regardless of token:
identifier mutation is not implemented (§3.4 note), and `/admin/*`
is RealmID-ops only.

**Role catalog ownership split — confirmed.** The integration
contract is:

- The role **catalog** (names, the set itself) is created and
  assigned **in RealmID** via `realm.roles.create` and
  `realm.tenants.updateUserRole`.
- The role **definition** (which UI screens, API routes, or
  business operations each role can perform) is enforced **in your
  application** — RealmID does not enforce the `permissions[]`
  field; it's stored as opaque metadata for your own use.
- Renaming a role (planned roadmap; not all backends yet) preserves
  existing assignments and does **not** require re-issuing tokens
  to stay valid — the binding is by name, and the next mint after
  rename carries the new name.

This split is intentional: RealmID stays free of partner-specific
authorization semantics; your app stays free to evolve its
permission model without coordinating schema changes through
identity.

### 3.7 Identity provider restriction (per realm / per tenant)

`auth_config.firebase_project_id` (§2.2) names a single project for
the realm, but the issuer additionally lets you constrain **which
identity providers** are accepted, separately per realm and per
tenant. This is the surface you reach for when you want
"admin-tenant authenticates with Google only; end-user tenants
authenticate with phone OTP only," or any other per-tenant IdP
policy.

```ts
// realm-wide default
await realm.identityProviders.list();
// → [{ provider, clientType, clientId, allowedOrigins, ... }]

// tenant-specific override (admin tenant: Google web-only)
await realm.tenants.identityProviders.create(adminTenantId, {
  provider:        "google",
  clientType:      "web",
  clientId:        "…apps.googleusercontent.com",
  allowedOrigins:  ["https://admin.partner.com"],
});
```

Provider rows are scoped to a `(realm | tenant, client_type)` pair
(`web`, `ios`, `android`, `desktop`, `other`) so the same realm can
allow Google on the web app and Firebase on mobile. The login flow
filters available providers by the resolved scope of the login
attempt; an unrecognised provider returns
`RealmError(provider_not_enabled)`.

The current SDK surface for read is `realm.identityProviders.list`
(filters by tenant id when supplied); write (create / patch /
delete) is admin-tenant-owner gated and exposed on the admin SDK
handle (§3.6).

---

## 4. Frontend integration

The SDK ships a browser bundle that handles login, refresh, logout,
sessions, and MFA. Same interface whether you point it at RealmID
directly or at your BFF.

### 4.1 Configure

```ts
// src/auth/realm.ts
import { createRealm } from "@realm-id/sdk/browser";

export const realm = createRealm({
  // BFF mode: point at your own backend.
  baseUrl: import.meta.env.VITE_API_BASE_URL,
  // Direct mode: point at RealmID + the realm id.
  // baseUrl: "https://auth.realmid.dev",
  // realmId: import.meta.env.VITE_REALM_ID,
});
```

Browser-mode does not take an `apiKey`. It cannot mint platform
tokens. If you point it at RealmID directly with
`require_bff_login=true` set, login will fail with
`RealmError(missing_platform_token)`.

### 4.2 Login (Firebase example)

```ts
import { realm } from "./auth/realm";
import { signInWithPhoneNumber } from "firebase/auth";

async function loginWithPhone(phone: string, code: string) {
  // 1. Firebase OTP roundtrip — your existing code.
  const fbCredential = await confirmOtp(phone, code);
  const idToken = await fbCredential.user.getIdToken();

  // 2. Hand the Firebase id-token to RealmID via the SDK.
  const session = await realm.auth.login({
    method: "firebase",
    providerToken: idToken,
  });

  // 3. Single-tenant happy path: session.accessToken is set.
  if (session.accessToken) {
    return { tenantId: session.tenantId, role: session.role };
  }

  // 4. Multi-tenant: show a picker, then call /auth/token.
  return { tenantsToPick: session.tenants };
}

async function pickTenant(refreshToken: string, tenantId: string) {
  const out = await realm.auth.token({ refreshToken, tenantId });
  // out.accessToken, out.refreshToken, out.expiresIn
}
```

### 4.3 Multi-tenant flow

When the user belongs to more than one tenant in the realm, `login`
returns a `tenants` array but no `accessToken`. Your UI shows a
picker; once the user selects a tenant, you call `realm.auth.token`
with the chosen `tenantId`. The user can switch tenants later by
calling `realm.auth.token` again with a different `tenantId` — the
access token is rebound; the refresh token rotates.

A session is **tenant-locked** only when it was established via the
built-in OTP login (`method=otp_internal`). In that case
`realm.auth.token` rejects any `tenantId` switch with
`RealmError(tenant_locked_session)`; the UI should disable the
switcher. Sessions established via `firebase`, `google`, or any
external-IdP method are **not** locked and can switch tenant freely.

> **OTP-first partners read this twice.** If your *primary* login
> factor is `otp_internal` (a very common shape for SMS-first
> consumer / SMB apps), then **every** session you mint is
> tenant-locked, so multi-tenant users **cannot switch tenant
> without a full re-login**. Two valid patterns:
>
> 1. **Re-login on switch.** The user picks a tenant from a list
>    you maintain locally, you drop the current session, send a fresh
>    OTP, and `login` against the new tenant. UX-acceptable for most
>    SMS apps (sub-30-second round-trip).
> 2. **Use Firebase phone-OTP** (`method=firebase` with a Firebase
>    phone credential) instead of `method=otp_internal`. Firebase-
>    method sessions are not locked, so a single session can switch
>    tenant via `realm.auth.token({ tenantId })`. SMS billing stays
>    on your Firebase project; the verify step lives in RealmID.
>
> The choice is a billing/UX tradeoff, not a security one — both
> paths verify the same OTP. If you don't already operate Firebase,
> path 1 is simpler.

### 4.4 MFA challenge

If the realm or tenant has MFA enforced, `login` throws
`RealmError(mfa_required)` with `details.mfaChallengeToken`. Drive
the UX:

```ts
try {
  await realm.auth.login({ method: "firebase", providerToken: idToken });
} catch (e) {
  if (e instanceof RealmError && e.code === "mfa_required") {
    const challenge = e.details.mfaChallengeToken;
    const code = await promptUserForTotpCode();
    const session = await realm.auth.mfaVerify({
      challengeToken: challenge,
      code,
      method: "totp",
    });
    // session.accessToken is now set
  }
}
```

Self-enroll TOTP from the user's account screen:

```ts
const enroll = await realm.tenants.users.enrollMfa(tenantId, userId);
// enroll.secret + enroll.qrCodePng — show the QR.
const userCode = await promptUserForTotpCode();
await realm.tenants.users.confirmMfa(tenantId, userId, userCode);
```

`resetMfa` removes the user's TOTP and is admin-only by convention
(your backend should gate it on `role` before calling).

### 4.5 Sessions UI

```ts
const sessions = await realm.auth.listSessions();
for (const s of sessions) {
  // s.id, s.createdAt, s.lastUsedAt, s.userAgent, s.ip
}
await realm.auth.revokeSession(sessionId);
await realm.auth.revokeAllSessions();
```

Build the page once; it works for both web sessions and long-lived
desktop sessions (§6) — the latter show up with a stable `userAgent`
that you control at install time.

**Tagging desktop sessions** — the `userAgent` field on the session
record is the verbatim `User-Agent` HTTP header sent on `/auth/login`.
Set a deterministic value from your installer (e.g.
`MyAgent/1.4.0 (install=abc123; host=desktop-7)`) so admins can
identify it in the UI and revoke "the install on machine X" without
killing their own browser session.

**`lastUsedAt` semantics** — updates on every successful access-token
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
  identifier: { phone: "+15551234" },     // or { email: "x@y.com" }, or both
  role: "salesman",
});
```

**Identifier rules** — `identifier` accepts `{phone}`, `{email}`, or
both. At least one is required. When both are supplied, the
invitation will accept on a Firebase identity that matches *either*.
If the matched-on identifier is already in use by a different user
in the same tenant, the invitation is rejected at *accept* time
(not at create time) by the existing per-tenant unique index on
the user record — surfaces as a generic `409`. A future change
(ADR-042) adds an invite-time pre-check and a first-class
`identifier_collision` error code carrying the existing user's
details; until then, backfill loops should treat the 409 as a
per-user log entry, not a fatal error.

```go
_, _ = realm.Tenants.Invitations.Create(ctx, tenantID, realmid.InvitationCreate{
    Identifier: realmid.Identifier{Phone: "+15551234"},
    Role:       "salesman",
})
```

The invited user logs in via Firebase (or whatever IdP you've
configured). RealmID's login pipeline matches the invitation by
phone/email, links the IdP identity, and provisions the user. Your
lazy middleware (§5.1) picks them up on the first authenticated
request.

`role` must be in your realm's role catalog (§2.3). Unknown role
names return `RealmError(unknown_role)`.

Idempotent: repeated invitations to the same identifier in the same
tenant return `RealmError(invitation_exists)`. Safe to swallow if you
don't care about the duplicate.

**Multi-tenant accept precedence** — when a user's first Firebase
login produces an identity that matches pending invitations across
*multiple* tenants in the realm (e.g. invited by phone to tenant A
and by email to tenant B, and the Firebase identity carries both),
RealmID accepts *all* matching invitations atomically. The user is
provisioned into every matching tenant in one login round-trip; the
SDK's login response returns the full `tenants[]` array and the
SPA shows the multi-tenant picker (§4.3). There is no per-tenant
opt-in step.

### 5.3 Updating a user's role

```ts
await realm.tenants.updateUserRole(tenantId, userId, "admin");
```

```go
_, err := realm.Tenants.UpdateUserRole(ctx, tenantID, userID, "admin")
```

The role value is validated against the realm catalog (§2.3) — both
the invite-user and edit-user-role UI flows should populate their
role pickers from `realm.roles.list()` rather than hard-coding
names. Setting a user's role to `owner` is rejected — use
`Tenants.TransferOwner` instead. Demoting the last owner returns
`RealmError(last_owner)`.

Once updated, the change is reflected in the next access token your
user receives. If you mirror the role locally, refresh your local
copy from the JWT on every request (don't write a separate sync job).

### 5.4 Stashing partner-side metadata on a tenant

RealmID's `tenants.config` is a closed allowlist
(`mfa_policy`, `signup_mode` today). It is **not** a general
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
});
```

```go
tnt, err := realm.Tenants.Create(ctx, realmid.TenantCreate{
    DisplayName: "Acme",
    SignupMode:  realmid.SignupModeAllowlist,
})
```

The realm is implicit (the API key's realm). The SDK routes this to
`POST /platforms/{realmId}/tenants`; partners have one platform per
realm so no `platform` parameter is needed. The platform-token caller
satisfies the server's tenant-maintenance check via the service-JWT
branch — no extra grant required.

Bootstrap an owner in the same flow by following up with
`tenants.invitations.create(tnt.id, { identifier: { email: "founder@acme.com" }, role: "owner" })`.

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

> **API keys are realm-scoped, not tenant-scoped.** A `rk_live_…`
> minted for your realm can mint platform tokens that act on any
> tenant in that realm. There is no per-tenant or per-role scoping
> on API keys today. If you need to bound a sync agent to one
> tenant or one role, the user-refresh-token model (§6.1) is the
> only path — provision a dedicated "sync bot" user in that tenant
> with the role you want, and use its refresh token.

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

### 7.2 Backfill via invitations

Walk your existing users table and create RealmID invitations:

```go
for _, u := range existingUsers {
    _, err := realm.Tenants.Invitations.Create(ctx, u.TenantID,
        realmid.InvitationCreate{
            Identifier: realmid.Identifier{Phone: u.Phone},
            Role:       u.Role,
        })
    if errors.Is(err, realmid.ErrInvitationExists) {
        continue   // safe to re-run
    }
    if err != nil { log.Printf("backfill %s: %v", u.ID, err); continue }
}
```

You don't migrate `firebase_uid` or any other IdP-side identifier.
The invitation matches on phone/email when the user next logs in;
RealmID links the IdP identity at that moment. Idempotent: safe to
re-run; the cost is a no-op REST call per existing user.

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
const next = await realm.apiKeys.create({ display_name: "partner-backend (2026-Q3)" });
// Deploy `next.token` to your secret store; reload the backend.
// Confirm `realm.apiKeys.list()` shows a fresh `last_used_at` on the new key.
await realm.apiKeys.revoke(oldKeyId);
```

Rotate per-environment, not all at once. The platform-token cache in
the SDK invalidates on `unauthorized` automatically; one mint cycle
later your backend is on the new key.

### 8.2 Origin policy and dev realms

`realm.config.update({ origins: [...] })` registers the origins your
SPA may load from. There is no documented hard cap; keep the list
short for clarity. `localhost` and other private/loopback origins
are accepted in any realm — RealmID does not block them in
production realms — but the recommended pattern is **a separate dev
realm** for local + staging origins. Reasons:

- An incident or stolen API key in a dev realm has zero blast radius
  on production users.
- You can safely flip BFF mode, custom-claim allowlists, and other
  realm config in dev without coordinating with prod.
- JWKS rotation cadence and caching live at the realm level —
  testing rotation behavior in isolation is much easier with a
  dedicated realm.

### 8.3 Rate limits

Per-realm and per-IP rate limits apply on the auth surface. Treat
the following as defaults; check `error-reference.md` for the
`rate_limited` error and your `Retry-After` header response.

- `/auth/login`, `/auth/token`, `/auth/logout` — per-IP: ~10 req/sec
  burst, ~120 req/min sustained. Per-realm: generous; not the
  binding constraint for normal interactive traffic.
- `/auth/login` (`grant_type: "platform_api_key"`) — per-API-key:
  ~5 req/sec. The SDK's platform-token cache (4-min TTL) means well-behaved partner
  backends mint roughly once every 4 minutes per process; bursts
  only occur on cold start or after a 401 forces re-mint.
- `/platforms/{id}/api-keys` and other admin REST — per-realm: ~30
  req/min. Sized for ops scripts, not bulk operations.
- **Backfill loops** (`/tenants/{id}/invitations` in a tight
  loop) — sustained ~20/sec per realm is safe; the SDK does not
  auto-pace, so backoff on `rate_limited` is your responsibility.

These numbers are conservative defaults; if you have a one-off
operation that needs higher headroom (large backfill, mass invite
campaign), coordinate with RealmID ops in advance.

### 8.4 Realm config reference

`realm.config.update(patch)` accepts these keys:

| Key                                      | Type         | Default | Notes                                              |
|------------------------------------------|--------------|---------|----------------------------------------------------|
| `access_ttl_seconds`                     | int          | 900     | 60 ≤ x ≤ 3600                                      |
| `refresh_ttl_seconds`                    | int          | 2592000 | 3600 ≤ x ≤ 31536000                                |
| `concurrent_session_limit`               | int          | 0       | 0 = unlimited. Counted **per realm** (across all tenants the user belongs to in this realm), not per tenant. **Evict-oldest**: when a new login pushes the count over the limit, the oldest active sessions are revoked FIFO so the new login succeeds. The HTTP response is 412 `session_limit_reached` carrying a `revocationToken` + the list of sessions that *would* be evicted, so the client SDK can prompt the user before committing if it wants an interactive "kick a device" UX; calling `/auth/login` again with the `revocationToken` confirms eviction. |
| `require_bff_login`        | bool         | false   | BFF mode (§1.2)                                    |
| `default_invitation_role`                | string       | `member`| Must be in role catalog; can't be `owner`          |
| `access_token_custom_claim_keys`         | string[]     | `[]`    | Allowlist of keys you may pass to `/auth/token`    |
| `refresh_absolute_expiry`                | object       | `{}`    | ADR-054. Wall-clock scheduled refresh-token expiry. Shape: `{ mode: "rolling" \| "scheduled", daily_cutoff_local: "HH:MM", timezone: "<IANA>" }`. Default `mode: "rolling"` preserves the rolling-TTL behaviour. When `mode: "scheduled"`, every refresh token (user, service, platform) expires at `min(now + refresh_ttl_seconds, next daily_cutoff_local in timezone)`. Example for "force daily re-login at 8 PM IST": `{ mode: "scheduled", daily_cutoff_local: "20:00", timezone: "Asia/Kolkata" }`. Note: with scheduled mode, `refresh_ttl_seconds` reads as a *ceiling*, not a guaranteed lifetime — tokens minted close to the cutoff expire sooner. Realm-level only (no per-tenant override). |

Unknown keys return `RealmError(invalid_config_key)`; out-of-range
values return `RealmError(invalid_config_value)`.

### 8.5 Common errors

| Code                          | Cause                                                   | Remedy                                            |
|-------------------------------|----------------------------------------------------------|---------------------------------------------------|
| `unauthorized`                | API key invalid or revoked                               | Rotate key, redeploy                              |
| `missing_platform_token`      | BFF mode on, caller didn't attach platform token         | Use SDK `realm.Auth.*` methods, not raw HTTP      |
| `unknown_origin`              | Login `Origin` not registered on realm                   | Add origin via `realm.config.update`              |
| `realm_origin_mismatch`       | Body `realm_id` doesn't match Origin's resolved realm    | Drop one or fix the other                         |
| `mfa_required`                | Realm/tenant requires MFA                                | Drive `mfaVerify` flow (§4.4)                     |
| `unknown_role`                | Role name not in realm catalog                           | Create role via `realm.roles.create`              |
| `invitation_exists`           | Already invited that identifier                          | Safe to ignore                                    |
| `tenant_locked_session`       | Session was OTP- or custom-domain-bound; can't switch    | UI should disable switcher                        |
| `refresh_invalid`             | Refresh token expired or revoked                         | Redirect to login                                 |
| `role_exists`                 | Idempotent role create                                   | Safe to ignore                                    |

Full catalog: [`error-reference.md`](./error-reference.md).

### 8.6 Auditing and event export

`GET /platforms/{id}/audit-events` returns the RealmID-originated
events for your platform (ADR-055). Same row shape as the internal
ops console feed; scoped (and forced) to the platform in the path
so a caller can never read another platform's audit trail.

**Auth.** Either a platform admin user JWT, or a platform-scoped
service JWT minted from an API key (`/auth/token` with an API-key
bearer). Compliance ingest is typically a backend job — use the
API-key path.

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
events, cursor, err := client.Platforms.ListAuditEvents(ctx, platformID, realmid.AuditEventsQuery{
    Since:     lastPullUnix,
    Kinds:     []string{"auth.login.success", "auth.login.failure"},
    Limit:     200,
})
```

**Mirror writes you initiate (still useful).** The pull feed covers
RealmID-side events. For writes your BFF makes through the SDK, you
can still emit a row in your own audit log at the call site — every
call from your BFF is attributable to a request id you already
track. This complements (rather than replaces) the pull feed.

---

## 9. Cross-realm integrations (`realm.integrations.*`, ADR-082/083)

When one platform on RealmID needs to call **another** platform's APIs —
Hiring Motion driving Quizzing Pro, say — you do **not** share credentials
or invent a cross-tenant superuser role. Instead:

1. The **source** platform *publishes* an integration (once, at realm level).
2. The **target** org's owner *installs* it, choosing the exact role the
   integration acts as. This admits a `kind=service` principal into their org.
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
  slug: "hiring-motion",
  displayName: "Hiring Motion",
});
// integration.id → hand to the target org owner out-of-band so they can install it.

// Per call into the target: mint a token. Authenticated by YOUR platform_api
// key (the raw key, NOT a user/session token). source_org_id names which of
// your orgs is acting — it is recorded in the target's audit.
const { access_token, expires_in } = await sourceRealm.integrations.mintToken({
  apiKey: process.env.REALMID_PLATFORM_API_KEY!,   // rk_live_…
  installationId,                                   // from the target's install
  sourceOrgId: "org-uuid-on-hm",
});
// Call Quizzing Pro's API with `Authorization: Bearer ${access_token}`.
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
// The org owner installs a foreign integration into their org. The chosen role
// MUST be one authored specifically for service use — its `assignable_to` must
// be exactly ["service"]. A human/admin role is rejected (`role_not_service_typed`).
const svcRole = await targetRealm.roles.create({
  name: "hm-integration",
  displayName: "Hiring Motion integration",
  assignableTo: ["service"],
  permissions: [/* only what the integration needs */],
});

await targetRealm.integrations.install(orgTenantId, {
  integrationId,              // from the source platform, out-of-band
  roleId: svcRole.id,
});

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
| `role_not_service_typed` | 400 | `install` — role is not exactly `["service"]` |
| `role_not_installable` | 400 | `install` — role is `owner`/`platform_api` |
| `integration_disabled` | 400 | `install` — the source disabled it |
| `already_installed` | 409 | `install` — a live installation already exists for this org |
| `installation_revoked` | 403 | `mintToken` — the target uninstalled |
| `role_unavailable` | 403 | `mintToken` — the role was disabled/narrowed after approval |
| `key_class_mismatch` | 401 | `mintToken` — not a platform-class api key |
| `installation_not_found` | 404 | `mintToken` — unknown installation, **or a platform key from the wrong realm** |

All surface on the usual `RealmError.code` / `RealmException.getCode()`.

## 9.5 End-user API keys (ADR-084)

Your users mint keys so third-party apps can call **your** API on their behalf:
*"User A mints Key 1 for AutoMahn with reports access only, Key 2 with full
access."* RealmID stores the key, enforces expiry, revocation and org pinning, and
hands you a token. **You enforce the scope.**

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

- Minting is a step-up operation when the realm sets
  `user_api_keys.require_mfa_at_mint` (the default whenever the realm has MFA
  enabled) — expect a `412 mfa_required` with a challenge.
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
