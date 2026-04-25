# Realm ID — Express example

Minimal Express server using `realm.middleware()`. The SDK handles
`/login`, `/logout`, `/token`, and `/mfa/verify` end-to-end (refresh
cookie included). Every other request requires a valid `Authorization:
Bearer <access-token>` header; the verified claims land on
`req.realmid`.

## Run

```bash
cd ts && npm install && npm run build      # build the SDK first
cd examples/express-app
npm install
REALM_ID=01HXYZ... API_KEY=rk_live_... npm run start
```

Then exercise it:

```bash
# health check (exempt)
curl localhost:3000/health

# login (server-issued provider token, e.g. Firebase ID token)
curl -i -X POST localhost:3000/login \
  -H 'content-type: application/json' \
  -d '{"method":"firebase","provider_token":"<id_token>"}'

# protected route — pass the access_token returned above
curl localhost:3000/me -H "authorization: Bearer <access_token>"
```

## What's actually happening

`createRealm()` builds the handle. `realm.middleware()` wires four
ingress routes plus a fall-through bearer verifier. Partners normally
do not call `realm.auth.login(...)` or `realm.verify(...)` directly —
the middleware does it for them.

For lower-level usage (CLI tools, workers, custom flows), every
operation is also exposed on the `realm` handle: `realm.auth.login()`,
`realm.tenants.list()`, `realm.verify()`, etc.
