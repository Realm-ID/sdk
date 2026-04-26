# realmid Go SDK — server example

Minimal `net/http` server using `realm.Middleware`. Mounts:

- `GET /health` — public, bypasses auth
- `POST /login`, `POST /logout`, `POST /token`, `POST /mfa/verify` — handled by the middleware
- `GET /me` — protected; reads verified `Claims` from `r.Context()` via `realmid.ClaimsFrom`

## Run

```sh
export REALM_ID=01HXYZ...
export REALM_API_KEY=rk_live_...
go run .
```

Defaults to port 3000 and `https://auth.realmid.dev` as the issuer. Override via `ADDR` and `BASE_URL`.
