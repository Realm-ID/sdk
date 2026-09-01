import { test } from "node:test";
import assert from "node:assert/strict";
import type { IdentityProvidersResponse } from "./identity-providers.js";

/**
 * Pins the defect that shipped in ts 0.46.0 / go 0.53.0 / java 0.43.0.
 *
 * A BFF built on this SDK decodes the issuer's discovery response into
 * IdentityProvidersResponse and re-serialises it to the browser. Any field the
 * type omits is therefore DELETED from what the login screen receives, with no
 * error at any layer — which is how ADR-103/104 credential sign-in shipped
 * unreachable from every BFF-fronted console.
 *
 * TypeScript erases types at runtime, so a structural assertion cannot catch
 * this on its own; what CAN drop the field is a re-serialisation that copies
 * named properties. So the round trip below is written the way a BFF writes it.
 */
test("credential_methods survives a decode → re-encode round trip", () => {
  const upstream = `{"providers":[{"type":"google"}],"credential_methods":["password","otp"]}`;
  const decoded = JSON.parse(upstream) as IdentityProvidersResponse;

  assert.deepEqual(decoded.credential_methods, ["password", "otp"]);

  // A BFF re-serialising the typed shape must carry the field onward.
  const forwarded: IdentityProvidersResponse = {
    tenant_id: decoded.tenant_id,
    providers: decoded.providers,
    credential_methods: decoded.credential_methods,
  };
  const wire = JSON.parse(JSON.stringify(forwarded));
  assert.deepEqual(wire.credential_methods, ["password", "otp"]);
});

test("an absent credential_methods stays absent, and is not an empty list", () => {
  const decoded = JSON.parse(`{"providers":[]}`) as IdentityProvidersResponse;
  assert.equal(decoded.credential_methods, undefined);

  const wire = JSON.parse(JSON.stringify({ providers: decoded.providers }));
  assert.equal("credential_methods" in wire, false);
});
