// RED tests: the five codes of issuer ADR-123 (emailed sign-in codes) and ADR-124 (lockout guards) reach
// callers as their own code (SPEC §3.1) instead of collapsing to the HTTP-status fallback.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { HttpClient } from "./http.js";
import { RealmError, isKnownCode } from "./errors.js";

const CODES: Array<[string, number]> = [
  ["acknowledgement_required", 400], ["email_otp_requires_identifying_email", 409],
  ["email_otp_rate_limited", 429], ["last_browser_sign_in", 409], ["last_machine_credential", 409],
];

for (const [code, status] of CODES) {
  test(`code ${code} is known and survives HttpClient mapping`, async () => {
    assert.equal(isKnownCode(code), true);
    const c = new HttpClient({
      baseUrl: "https://x.example",
      fetch: (async () => new Response(JSON.stringify({ error: { code, message: "m" } }), {
        status, headers: { "content-type": "application/json" },
      })) as typeof fetch,
    });
    await assert.rejects(() => c.request({ path: "/platforms/p/config", method: "PATCH" }), (e: Error) =>
      e instanceof RealmError && (e.code as string) === code && e.httpStatus === status);
  });
}
