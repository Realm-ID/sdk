// Minimal example: verify a RealmID access token from the command line.
//
// Usage:
//   REALMID_BASE_URL=https://auth.realmid.dev \
//   REALMID_AUDIENCE=your-partner-audience \
//   npx tsx index.ts <jwt>
//
// Prints the verified claims as JSON, or exits 1 with the typed error code.

import { createVerifier, VerifyError } from "@realmid/sdk";

const baseUrl = process.env.REALMID_BASE_URL;
const audience = process.env.REALMID_AUDIENCE;
const token = process.argv[2];

if (!baseUrl || !audience || !token) {
  console.error(
    "usage: REALMID_BASE_URL=... REALMID_AUDIENCE=... npx tsx index.ts <jwt>"
  );
  process.exit(2);
}

const verifier = createVerifier({ baseUrl, audience });

try {
  const claims = await verifier.verify(token);
  console.log(JSON.stringify(claims, null, 2));
} catch (err) {
  if (err instanceof VerifyError) {
    console.error(`verify failed: ${err.code} — ${err.message}`);
    process.exit(1);
  }
  throw err;
}
