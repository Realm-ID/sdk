# verify-token (TypeScript)

Minimal example: verify a RealmID access token from the command line and
print its claims.

## Run

```bash
# from this directory
cd ts/examples/verify-token
npm install
REALMID_BASE_URL=https://auth.realmid.dev \
REALMID_AUDIENCE=your-partner-audience \
npm start -- "<paste-jwt-here>"
```

## What it shows

- Constructing a `Verifier` once with `createVerifier({...})`.
- Calling `verify(token)` and handling the typed `VerifyError` with its
  stable `code` field (`malformed`, `wrong_audience`, `expired`,
  `unknown_kid`, etc.).
- Printing the verified `Claims` (incl. realm extras `tenant_id`, `role`,
  and any partner-supplied claims via the index signature).
