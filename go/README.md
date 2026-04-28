# @realmid/sdk — Go

Go SDK for verifying RealmID-issued JWTs. Sibling TypeScript SDK lives at
[`../ts/`](../ts).

## Install

```bash
go get github.com/Realm-ID/sdk/go
```

## Usage

```go
package main

import (
    "log"

    realmid "github.com/Realm-ID/sdk/go"
)

func main() {
    v, err := realmid.NewVerifier(realmid.Config{
        BaseURL:  "https://auth.realmid.dev",
        Audience: "your-partner-audience",
    })
    if err != nil {
        log.Fatal(err)
    }

    claims, err := v.Verify(accessToken)
    if err != nil {
        var verr *realmid.Error
        if errors.As(err, &verr) {
            // verr.Code in {malformed, wrong_algorithm, bad_signature,
            //   wrong_issuer, wrong_audience, expired, not_yet_valid,
            //   unknown_kid, jwks_fetch_failed}
        }
        return
    }

    // claims.Subject, claims.TenantID, claims.Role, claims.Extra["..."]
}
```

## Runtime

Stdlib only — no third-party dependencies. Go 1.22+.

## HTTP middleware

The full `Realm` handle (`realmid.New(...)`) ships an `http.Handler`
middleware that handles `/login`, `/logout`, `/token` (refresh), and
`/mfa/verify` end-to-end and verifies bearer tokens on every other
route. Mount it once on your mux:

```go
realm, err := realmid.New(realmid.Config{
    RealmID: os.Getenv("REALM_ID"),
    APIKey:  os.Getenv("REALM_API_KEY"),
})
if err != nil { log.Fatal(err) }

mw := realm.Middleware(realmid.MiddlewareOptions{
    ExemptPaths:       []string{"/health", "/public/*"},
    MFAProtectedPaths: []realmid.MFARule{{Path: "/admin/*"}},
    TokenDelivery:     "cookie", // or "body" for native / mobile clients
    // CookieName/Domain/Secure/SameSite all configurable; defaults are
    // realmid_refresh, HttpOnly, Secure=true, SameSite=Lax.
})

mux := http.NewServeMux()
mux.Handle("/me", mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
    claims, _ := realmid.ClaimsFrom(r.Context())
    json.NewEncoder(w).Encode(claims)
})))
http.ListenAndServe(":3000", mux)
```

In `"cookie"` mode (default) the refresh token is set as
`HttpOnly; Secure; SameSite=Lax` so browser JS can never read it and
XSS cannot exfiltrate it. Use `"body"` only when a cookie isn't
viable — native apps, CLIs, or truly cross-origin SPAs. See
[SPEC §10.2](../SPEC.md#102-configuration) for the full decision table.

## What's in scope

Verifier-only callers can stay on `realmid.NewVerifier(...)` — no
network calls beyond JWKS. The full handle (`realmid.New(...)`) layers
the auth surface, management API, and the middleware above.

## Tests

```bash
go test ./...
```

## License

MIT — see the [LICENSE](../LICENSE) at the repo root.
