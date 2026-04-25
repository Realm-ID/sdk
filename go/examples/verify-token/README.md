# verify-token (Go)

Minimal example: verify a RealmID access token from the command line and
print its claims.

## Run

```bash
# from this directory
cd go/examples/verify-token
go run . \
  -base-url https://auth.realmid.dev \
  -audience your-partner-audience \
  -token "<paste-jwt-here>"
```

The example uses a local `replace` directive to point at the sibling SDK
source in `../..`. In your own project you'd just `go get github.com/Realm-ID/sdk/go`
and drop the replace.

## What it shows

- Constructing a `Verifier` once with `realmid.NewVerifier(realmid.Config{...})`.
- Calling `v.Verify(token)` and branching on the typed `*realmid.Error`
  (`Code` is one of `malformed`, `wrong_audience`, `expired`,
  `unknown_kid`, etc. — same wire values as the TS and Java SDKs).
- Printing the verified `Claims` (incl. realm extras `TenantID`, `Role`,
  and any partner-supplied claims via `claims.Extra`).
