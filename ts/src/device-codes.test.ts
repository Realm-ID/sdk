// RED tests (W2-sdk): the twelve device-authorization codes of SPEC §3.1 reach ts callers as their own code
// (Q8), and device_approval_not_allowed has the R86 typed error. Written before the implementation.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { HttpClient } from "./http.js";
import { RealmError } from "./errors.js";
import * as sdk from "./index.js";

const CODES: Array<[string, number]> = [
  ["authorization_pending", 400], ["slow_down", 400], ["access_denied", 400], ["expired_token", 400],
  ["device_code_attempts_exceeded", 429], ["subject_suspended", 409], ["device_authorization_not_pending", 409],
  ["device_authorization_collected", 409], ["revoke_existing_sessions_required", 400], ["invalid_client_id", 400],
  ["tenant_not_member", 400], ["device_approval_not_allowed", 403],
];

for (const [code, status] of CODES) {
  test(`device code ${code} survives HttpClient mapping instead of collapsing to the status fallback`, async () => {
    const c = new HttpClient({
      baseUrl: "https://x.example",
      fetch: (async () => new Response(JSON.stringify({ error: { code, message: "m" } }), {
        status, headers: { "content-type": "application/json" },
      })) as typeof fetch,
    });
    await assert.rejects(() => c.request({ path: "/auth/token", method: "POST" }), (e: Error) =>
      e instanceof RealmError && (e.code as string) === code && e.httpStatus === status);
  });
}

test("device_approval_not_allowed decodes to DeviceApprovalNotAllowedError and isDeviceApprovalNotAllowed matches", async () => {
  const S = sdk as unknown as Record<string, any>;
  assert.equal(typeof S.DeviceApprovalNotAllowedError, "function", "DeviceApprovalNotAllowedError is not exported (R86)");
  assert.equal(typeof S.isDeviceApprovalNotAllowed, "function", "isDeviceApprovalNotAllowed is not exported (R86)");
  const c = new HttpClient({
    baseUrl: "https://x.example",
    fetch: (async () => new Response(JSON.stringify({ error: { code: "device_approval_not_allowed", message: "m" } }), {
      status: 403, headers: { "content-type": "application/json" },
    })) as typeof fetch,
  });
  await assert.rejects(() => c.request({ path: "/x" }), (e: Error) => e instanceof S.DeviceApprovalNotAllowedError && S.isDeviceApprovalNotAllowed(e));
  assert.equal(S.isDeviceApprovalNotAllowed(new Error("x")), false);
  assert.equal(S.isDeviceApprovalNotAllowed(null), false);
});
