# Middleware

Each SDK ships an HTTP middleware adapter for its language's standard
web stack. The middleware is the recommended way to integrate Realm
ID into a partner application — partners do not normally call
`auth.login` or `verify` directly.

| Language    | Adapter                                                       |
|-------------|---------------------------------------------------------------|
| TypeScript  | Connect-style `(req, res, next)` (Express, Polka, Connect).    |
| Go          | `func(http.Handler) http.Handler`                              |
| Java        | `jakarta.servlet.Filter` (with a Spring Security adapter planned). |

## Behavior, in order

For every inbound request, the middleware runs the following checks
in order. The first match handles the request; subsequent rules do
not run.

### 1. Exempt path

If the path matches `exemptPaths` (glob list, default
`["/health", "/public/*"]`), pass through. No auth header read, no
verification, no claims attached.

Globbing is intentionally tiny: `*` matches one path segment, `**`
matches any. No braces or alternation. If you need richer matching,
do it before invoking the middleware.

### 2. Login route

If `method + path` matches `loginPath` (default `POST /login`) the
middleware **handles** the request directly:

- Reads `{ method, providerToken }` from the JSON body.
- Calls `realm.auth.login(...)`.
- Returns the access token in the JSON body.
- Returns the refresh token via cookie (default) or body — see
  *Token delivery* below.

On a 412 `mfa_required` from the server, the middleware translates it
to a `200` response with body
`{ status: "mfa_required", mfa_challenge_token, methods }` so SPAs
that don't reject 4xx in the success path can still branch on
`status`.

Custom claims are **not** accepted on login. They belong on the
access token; pass them on `auth.token` (refresh) instead.

### 3. Logout route

If `method + path` matches `logoutPath` (default `POST /logout`):

- Reads the refresh token (cookie or body).
- Calls `realm.auth.logout(...)`.
- Clears the cookie if applicable.
- Returns `{ status: "ok" }`.

### 4. Refresh route

If `method + path` matches `refreshPath` (default `POST /token`):

- Reads the refresh token (cookie or body) and `{ tenant_id, custom_claims? }` from the body.
- Calls `realm.auth.token(...)`.
- Rotates the refresh token via cookie or body.
- Returns the new access token.

### 5. MFA verify route

If `method + path` matches `mfaVerifyPath` (default
`POST /mfa/verify`): reads `{ challenge_token, code }`, calls
`realm.auth.mfaVerify(...)`, behaves like login on success.

### 6. Otherwise — verify the bearer

The middleware requires `Authorization: Bearer <access-token>`,
calls `realm.verify(token)`, and:

- **On success**, attaches the verified `Claims` to the request
  context (`req.realmid` in TS, context value under the SDK's typed
  key in Go, request attribute `realmid.claims` in Java) and calls
  the next handler.
- **On verify failure** (bad signature, expired, malformed, unknown
  kid, missing header): returns **`401`** with
  `{ error: { code, message } }`.
- **On a path that requires MFA** (`mfaProtectedPaths` glob list)
  where the token verifies but its MFA proof is absent **or stale**:
  returns **`412`** with
  `{ error: { code: "mfa_required", message }, mfa_challenge_token, methods }`
  so the client can prompt and re-mint. Freshness is judged on the
  `mfa_at` claim (SPEC §10.4) against the rule's window — a bare-string
  rule inherits `mfaDefaultMaxAgeSeconds` (default 900 s), an `MFARule`
  object can set `maxAgeSeconds` or `requireFresh` (≈30 s, for
  irreversible operations) per route. Tokens from servers that predate
  `mfa_at` fall back to the legacy marker (`amr` containing `"mfa"`, or
  `acr === "urn:realmid:mfa"`), which satisfies age-based windows but
  never `requireFresh`.

## Configuration

```ts
const middleware = realm.middleware({
  exemptPaths: ["/health", "/public/*", "/webhooks/*"],
  mfaProtectedPaths: ["/admin/*", "/billing/*"],
  loginPath: "/login",
  logoutPath: "/logout",
  refreshPath: "/token",
  mfaVerifyPath: "/mfa/verify",

  tokenDelivery: "cookie",          // or "body"
  cookieName: "realmid_refresh",
  cookieDomain: ".acme.com",        // optional
  cookieSecure: true,               // default true in production
  cookieSameSite: "lax",            // "lax" | "strict" | "none"

  onAuthFailure: (req, err) => Response,  // optional override
});
```

Identical fields exist in the Go and Java SDKs with idiomatic types
(`time.Duration`, `Predicate<Request>`, etc.).

## Token delivery

| Mode     | Refresh location           | Access location | Best for                                                                  |
|----------|----------------------------|-----------------|---------------------------------------------------------------------------|
| `cookie` | `HttpOnly; Secure; SameSite=Lax` cookie | Returned in JSON body of login/refresh; client stores in memory or `localStorage` | Browser SPAs.                                                             |
| `body`   | Returned in JSON body      | Returned in JSON body | Mobile / native clients without browser cookie semantics. Server-rendered apps that proxy to a separate auth tier. |

The middleware reads the refresh token from the same place it wrote
it: cookie mode reads cookie, body mode reads `req.body.refresh_token`.

## What you get on a verified request

```ts
app.get("/me", (req, res) => {
  // req.realmid is the verified Claims object.
  // Per SPEC §5: iss, sub, aud, iat, exp, optional nbf, jti, azp,
  // tenant_id, role, plus any custom claims merged at refresh time.
  res.json(req.realmid);
});
```

```go
mux.HandleFunc("/me", func(w http.ResponseWriter, r *http.Request) {
    claims, ok := realmid.ClaimsFrom(r.Context())
    if !ok {
        http.Error(w, "no claims", 500)
        return
    }
    json.NewEncoder(w).Encode(claims)
})
```

```java
@Override
protected void doGet(HttpServletRequest req, HttpServletResponse res) {
    Claims claims = (Claims) req.getAttribute("realmid.claims");
    // ...
}
```

## Single-shot helpers

If you don't want the middleware (CLI scripts, queue workers, custom
auth schemes), every operation is also exposed directly on the
`realm` handle (`realm.auth.login(...)`, `realm.verify(...)`, etc.).
The middleware is sugar over those primitives, not a parallel
implementation.

## Roadmap

- **CSRF.** Cookie-mode middleware + state-changing routes is the
  classic CSRF target. A double-submit-cookie layer (SDK injects an
  `X-Realm-CSRF` header expectation with a `realmid_csrf`
  non-HttpOnly companion cookie) is on the roadmap; until it lands,
  partners using cookie mode for state-changing endpoints should
  layer their own CSRF defense or stick to `tokenDelivery: "body"`.
- **Spring Security adapter.** Java SDK ships
  `jakarta.servlet.Filter` today; a `SecurityFilterChain` adapter is
  planned.
- **Hono / Cloudflare Workers wrappers** for TS — the Connect-style
  middleware works in Workers as-is; idiomatic wrappers are roadmap.
