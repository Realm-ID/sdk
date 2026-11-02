/**
 * RED tests for SPEC §15.9 — `useDeviceApproval(userCode)` (web-react 0.6.0). Every state of the table.
 * They fail on the missing hook (`R.useDeviceApproval` is undefined), not on a compile error.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mountHook, fakeRealm, realmErr, view, settle, VERIFY, ENROLL } from "./device-test-harness.js";

const CODE = "ABCD-EFGH";

test("loading, then ready when inspect answers pending", async () => {
  const { realm, calls } = fakeRealm();
  const h = await mountHook(realm, CODE);
  assert.equal(h.out.current.state, "loading");
  await settle();
  assert.equal(h.out.current.state, "ready");
  assert.equal(h.out.current.request.deviceName, "build-box");
  assert.deepEqual(calls.inspect, [CODE]);
  await h.unmount();
});

test("a malformed or empty code never calls the BFF: ready, request null, error.code bad_request", async () => {
  for (const bad of ["", "ABC", "ABCD-EFGHX"]) { // empty, too short, too long (the alphabet itself is the issuer's, ADR-122 D4)
    const { realm, calls } = fakeRealm();
    const h = await mountHook(realm, bad);
    await settle();
    assert.equal(h.out.current.state, "ready", `code ${JSON.stringify(bad)}`);
    assert.equal(h.out.current.request, null);
    assert.equal(h.out.current.error?.code, "bad_request");
    assert.equal(calls.inspect.length, 0);
    await h.unmount();
  }
});

test("approve sends the code, the chosen workspace and the revoke choice, then state approved", async () => {
  const { realm, calls } = fakeRealm();
  const h = await mountHook(realm, CODE);
  await settle();
  await h.out.current.approve({ tenantId: "t9", revokeExistingSessions: true });
  await settle();
  assert.deepEqual(calls.approve, [{ userCode: CODE, tenantId: "t9", revokeExistingSessions: true }]);
  assert.equal(h.out.current.state, "approved");
  await h.unmount();
});

test("needs_mfa (verify): submit completes step-up with the challenge and code, then retries approve ONCE", async () => {
  let n = 0;
  const { realm, calls } = fakeRealm({
    approve: async () => {
      n += 1;
      if (n === 1) throw realmErr("mfa_required", 412, { details: { stepUp: VERIFY } });
      return { id: "da1", status: "approved", subjectType: "service", expiresAt: "x" };
    },
  });
  const h = await mountHook(realm, CODE);
  await settle();
  await h.out.current.approve({ revokeExistingSessions: true });
  await settle();
  assert.equal(h.out.current.state, "needs_mfa");
  assert.equal(h.out.current.mfa.kind, "verify");
  assert.deepEqual(h.out.current.mfa.methods, ["totp"]);
  await h.out.current.mfa.submit("123456");
  await settle();
  assert.deepEqual(calls.completeStepUp.map((c) => c.code), ["123456"]);
  assert.equal(calls.completeStepUp[0].challenge.challengeToken, "CHAL");
  assert.equal(calls.approve.length, 2, "approve must be retried exactly once");
  assert.equal(h.out.current.state, "approved");
  await h.unmount();
});

test("needs_mfa cancel returns to ready", async () => {
  const { realm } = fakeRealm({ approve: async () => { throw realmErr("mfa_required", 412, { details: { stepUp: VERIFY } }); } });
  const h = await mountHook(realm, CODE);
  await settle();
  await h.out.current.approve({ revokeExistingSessions: true });
  await settle();
  h.out.current.mfa.cancel();
  await settle();
  assert.equal(h.out.current.state, "ready");
  await h.unmount();
});

test("needs_mfa (enroll): mfa_registration_required has no submit", async () => {
  const { realm } = fakeRealm({ approve: async () => { throw realmErr("mfa_registration_required", 412, { details: { stepUp: ENROLL } }); } });
  const h = await mountHook(realm, CODE);
  await settle();
  await h.out.current.approve({ revokeExistingSessions: true });
  await settle();
  assert.equal(h.out.current.state, "needs_mfa");
  assert.equal(h.out.current.mfa.kind, "enroll");
  assert.equal(h.out.current.mfa.submit, undefined);
  await h.unmount();
});

test("a verify challenge with an EMPTY token is treated as enroll", async () => {
  const { realm } = fakeRealm({ approve: async () => { throw realmErr("mfa_required", 412, { details: { stepUp: { ...VERIFY, challengeToken: "" } } }); } });
  const h = await mountHook(realm, CODE);
  await settle();
  await h.out.current.approve({ revokeExistingSessions: true });
  await settle();
  assert.equal(h.out.current.mfa.kind, "enroll");
  await h.unmount();
});

test("approved: inspect answering approved or collected drives the state; collected enables signOut (Q7)", async () => {
  const { realm, calls } = fakeRealm({ inspect: async () => view({ status: "collected", collectedSessionId: "sx" }) });
  const h = await mountHook(realm, CODE);
  await settle();
  assert.equal(h.out.current.state, "approved");
  assert.equal(h.out.current.request.status, "collected");
  await h.out.current.signOut();
  await settle();
  assert.deepEqual(calls.signOut, [CODE]);
  await h.unmount();
});

test("signOut is a no-op unless the request is collected", async () => {
  const { realm, calls } = fakeRealm();
  const h = await mountHook(realm, CODE);
  await settle();
  await h.out.current.signOut();
  await settle();
  assert.equal(calls.signOut.length, 0);
  await h.unmount();
});

test("denied: deny succeeds, inspect says denied, or failed with failureReason", async () => {
  const a = fakeRealm();
  const h1 = await mountHook(a.realm, CODE);
  await settle();
  await h1.out.current.deny();
  await settle();
  assert.deepEqual(a.calls.deny, [CODE]);
  assert.equal(h1.out.current.state, "denied");
  await h1.unmount();

  const b = fakeRealm({ inspect: async () => view({ status: "denied" }) });
  const h2 = await mountHook(b.realm, CODE);
  await settle();
  assert.equal(h2.out.current.state, "denied");
  await h2.unmount();

  const c = fakeRealm({ inspect: async () => view({ status: "failed", failureReason: "subject_suspended" }) });
  const h3 = await mountHook(c.realm, CODE);
  await settle();
  assert.equal(h3.out.current.state, "denied");
  assert.equal(h3.out.current.request.failureReason, "subject_suspended");
  await h3.unmount();
});

test("expired: inspect expired, approve answering device_authorization_not_pending, and the local countdown", async () => {
  const a = fakeRealm({ inspect: async () => view({ status: "expired" }) });
  const h1 = await mountHook(a.realm, CODE);
  await settle();
  assert.equal(h1.out.current.state, "expired");
  await h1.unmount();

  const b = fakeRealm({ approve: async () => { throw realmErr("device_authorization_not_pending", 409); } });
  const h2 = await mountHook(b.realm, CODE);
  await settle();
  await h2.out.current.approve({ revokeExistingSessions: true });
  await settle();
  assert.equal(h2.out.current.state, "expired");
  await h2.unmount();

  const c = fakeRealm({ inspect: async () => view({ expiresAt: new Date(Date.now() - 1000).toISOString() }) });
  const h3 = await mountHook(c.realm, CODE);
  await settle();
  assert.equal(h3.out.current.state, "expired");
  await h3.unmount();
});

test("not_owner (device_approval_not_allowed) and not_found (forbidden) are distinct states", async () => {
  const a = fakeRealm({ inspect: async () => { throw realmErr("device_approval_not_allowed", 403); } });
  const h1 = await mountHook(a.realm, CODE);
  await settle();
  assert.equal(h1.out.current.state, "not_owner");
  await h1.unmount();
  const b = fakeRealm({ inspect: async () => { throw realmErr("forbidden", 403); } });
  const h2 = await mountHook(b.realm, CODE);
  await settle();
  assert.equal(h2.out.current.state, "not_found");
  await h2.unmount();
});

test("recoverable errors keep state ready with error set (DQ2, Q2, R41)", async () => {
  const cases: Array<[string, number, Record<string, unknown>]> = [
    ["subject_suspended", 409, {}],
    ["tenant_not_member", 400, {}],
    ["device_code_attempts_exceeded", 429, { retryAfter: 120, details: { retryAfter: 120 } }],
  ];
  for (const [code, status, extra] of cases) {
    const { realm } = fakeRealm({ approve: async () => { throw realmErr(code, status, extra); } });
    const h = await mountHook(realm, CODE);
    await settle();
    await h.out.current.approve({ revokeExistingSessions: true });
    await settle();
    assert.equal(h.out.current.state, "ready", code);
    assert.equal(h.out.current.error?.code, code);
    if (code === "device_code_attempts_exceeded") assert.equal(h.out.current.error.retryAfter, 120);
    await h.unmount();
  }
});

test("session_limit_reached: ready with sessionLimit set; revokeAndRetry revokes then retries approve once", async () => {
  let n = 0;
  const { realm, calls } = fakeRealm({
    approve: async () => {
      n += 1;
      if (n === 1) {
        throw realmErr("session_limit_reached", 412, {
          details: { revocation_token: "RV", sessions: [{ id: "s1", device: "Mac", last_active: "2026-11-03T00:00:00Z" }] },
        });
      }
      return { id: "da1", status: "approved", subjectType: "user", expiresAt: "x" };
    },
  });
  const h = await mountHook(realm, CODE);
  await settle();
  await h.out.current.approve({ revokeExistingSessions: false });
  await settle();
  assert.equal(h.out.current.state, "ready");
  assert.equal(h.out.current.error?.code, "session_limit_reached");
  assert.equal(h.out.current.sessionLimit.sessions.length, 1);
  await h.out.current.sessionLimit.revokeAndRetry(["s1"]);
  await settle();
  assert.ok(calls.fetch.some((u) => u.includes("/sessions")), "no revoke request was made");
  assert.equal(calls.approve.length, 2);
  assert.equal(h.out.current.state, "approved");
  await h.unmount();
});

test("a changed userCode returns the hook to loading and inspects the new code", async () => {
  const { realm, calls } = fakeRealm();
  const h = await mountHook(realm, CODE);
  await settle();
  await h.unmount();
  const h2 = await mountHook(realm, "WXYZ-2345");
  await settle();
  assert.deepEqual(calls.inspect, [CODE, "WXYZ-2345"]);
  await h2.unmount();
});
