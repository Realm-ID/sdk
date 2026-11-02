/**
 * RED tests for SPEC §15.8 — `realm.device.*` (0.13.0). Written before the implementation (W2-sdk).
 * Nothing here imports a symbol that does not exist yet except through `realm.device`, so every test
 * fails on the missing behaviour (`realm.device` is undefined), not on a compile error.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createRealm } from "./index.js";
import { withStepUpRetry } from "./stepup.js";

type Call = { url: string; method: string; body: any; headers: Record<string, string> };

function harness(handler: (c: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call: Call = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined, headers };
    calls.push(call);
    const r = handler(call);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fn, calls };
}

const VIEW = {
  id: "da1", status: "pending", clientId: "traide-cli", deviceName: "build-box", deviceNameSource: "client_declared",
  reportedIp: "203.0.113.9", reportedIpSource: "partner", createdAt: "2026-11-03T00:00:00Z", expiresAt: "2026-11-03T00:10:00Z",
  subjectType: "service", subjectLabel: "sync-bot in Acme", replaceExistingSessions: false, stepUp: true,
};

function stepUp412(code: string, token = "CHAL") {
  return {
    status: 412,
    body: { error: { code, message: "step up" }, mfa_challenge_token: token, methods: ["totp"], reason: "fresh_required", max_age_seconds: 300 },
  };
}

test("realm.device.inspect posts the user code as typed to the default path and returns the view", async () => {
  const { fetch, calls } = harness((c) => (c.url.endsWith("/me") ? { status: 401 } : { status: 200, body: VIEW }));
  const realm = createRealm({ baseUrl: "https://bff.test", fetch });
  const out = await realm.device.inspect("abcd-efgh");
  const call = calls.find((c) => c.url === "https://bff.test/device/inspect");
  assert.ok(call, "no request reached https://bff.test/device/inspect");
  assert.equal(call!.method, "POST");
  assert.equal(call!.body.userCode, "abcd-efgh");
  assert.equal(out.subjectLabel, "sync-bot in Acme");
  assert.equal(out.reportedIpSource, "partner");
  realm.close();
});

test("realm.device.approve / deny / signOut use their default paths and bodies", async () => {
  const { fetch, calls } = harness((c) => {
    if (c.url.endsWith("/device/approve")) return { status: 200, body: { id: "da1", status: "approved", subjectType: "service", expiresAt: "x" } };
    if (c.url.endsWith("/device/deny")) return { status: 200, body: { id: "da1", status: "denied" } };
    if (c.url.endsWith("/device/signout")) return { status: 200, body: { subjectType: "service", scope: "account" } };
    return { status: 404 };
  });
  const realm = createRealm({ baseUrl: "https://bff.test", fetch });
  const a = await realm.device.approve({ userCode: "ABCD-EFGH", tenantId: "t9", revokeExistingSessions: true });
  assert.equal(a.status, "approved");
  const d = await realm.device.deny("ABCD-EFGH");
  assert.equal(d.status, "denied");
  const s = await realm.device.signOut("ABCD-EFGH");
  assert.deepEqual([s.subjectType, s.scope], ["service", "account"]);
  const ap = calls.find((c) => c.url.endsWith("/device/approve"))!;
  assert.deepEqual(ap.body, { userCode: "ABCD-EFGH", tenantId: "t9", revokeExistingSessions: true });
  realm.close();
});

test("the `endpoints` setting renames the four device paths (and only those)", async () => {
  const { fetch, calls } = harness(() => ({ status: 200, body: VIEW }));
  const realm = createRealm({
    baseUrl: "https://bff.test",
    fetch,
    endpoints: { deviceInspect: "/x/i", deviceApprove: "/x/a", deviceDeny: "/x/d", deviceSignOut: "/x/o" } as any,
  });
  await realm.device.inspect("ABCD-EFGH");
  await realm.device.approve({ userCode: "ABCD-EFGH" });
  await realm.device.deny("ABCD-EFGH");
  await realm.device.signOut("ABCD-EFGH");
  const urls = calls.map((c) => c.url).filter((u) => u.includes("/x/"));
  assert.deepEqual(urls, ["https://bff.test/x/i", "https://bff.test/x/a", "https://bff.test/x/d", "https://bff.test/x/o"]);
  realm.close();
});

test("errors are RealmError carrying the SPEC 3.1 code and status", async () => {
  const { fetch } = harness(() => ({ status: 403, body: { error: { code: "device_approval_not_allowed", message: "no" } } }));
  const realm = createRealm({ baseUrl: "https://bff.test", fetch });
  await assert.rejects(
    () => realm.device.inspect("ABCD-EFGH"),
    (e: any) => e.name === "RealmError" && e.code === "device_approval_not_allowed" && e.status === 403,
  );
  realm.close();
});

test("the step-up 412 is NOT retried by the core: approve throws it with details.stepUp, no verify call is made", async () => {
  const { fetch, calls } = harness((c) => (c.url.endsWith("/device/approve") ? stepUp412("mfa_required") : { status: 404 }));
  let prompted = false;
  const realm = createRealm({ baseUrl: "https://bff.test", fetch, stepUpPrompt: async () => { prompted = true; return "123456"; } } as any);
  await assert.rejects(
    () => realm.device.approve({ userCode: "ABCD-EFGH", revokeExistingSessions: true }),
    (e: any) => {
      const s = e.details?.stepUp;
      return e.code === "mfa_required" && s?.kind === "verify" && s?.challengeToken === "CHAL" && s?.methods?.[0] === "totp";
    },
  );
  assert.equal(prompted, false, "a host-wide step-up prompt fired for a device call (R41)");
  assert.equal(calls.filter((c) => c.url.includes("/mfa/verify")).length, 0);
  realm.close();
});

test("an enroll 412 surfaces as mfa_registration_required with an enroll challenge", async () => {
  const { fetch } = harness(() => stepUp412("mfa_registration_required"));
  const realm = createRealm({ baseUrl: "https://bff.test", fetch });
  await assert.rejects(
    () => realm.device.approve({ userCode: "ABCD-EFGH" }),
    (e: any) => e.code === "mfa_registration_required" && e.details?.stepUp?.kind === "enroll",
  );
  realm.close();
});

test("a session_limit_reached 412 is never step-up: it carries the revocation token and sessions", async () => {
  const { fetch } = harness(() => ({
    status: 412,
    body: { error: { code: "session_limit_reached", message: "limit" }, revocation_token: "RV", sessions: [{ id: "s1", device: "Mac" }] },
  }));
  const realm = createRealm({ baseUrl: "https://bff.test", fetch });
  await assert.rejects(
    () => realm.device.approve({ userCode: "ABCD-EFGH", revokeExistingSessions: true }),
    (e: any) => e.code === "session_limit_reached" && !e.details?.stepUp && JSON.stringify(e.details ?? e.body).includes("RV"),
  );
  realm.close();
});

test("completeStepUp verifies the challenge, adopts the new bearer; the caller's ONE retry carries it", async () => {
  let approves = 0;
  const { fetch, calls } = harness((c) => {
    if (c.url.endsWith("/device/approve")) {
      approves += 1;
      return approves === 1 ? stepUp412("mfa_required") : { status: 200, body: { id: "da1", status: "approved", subjectType: "service", expiresAt: "x" } };
    }
    if (c.url.endsWith("/mfa/verify")) {
      return { status: 200, body: { session_token: "NEW_BEARER", expires_at: 9999999999, user: { id: "u1" }, tenants: [{ id: "t1", role: "owner" }] } };
    }
    return { status: 404 };
  });
  const realm = createRealm({ baseUrl: "https://bff.test", fetch });
  let challenge: any;
  await realm.device.approve({ userCode: "ABCD-EFGH", revokeExistingSessions: true }).catch((e: any) => { challenge = e.details?.stepUp; });
  assert.ok(challenge, "approve did not expose a step-up challenge");
  await realm.device.completeStepUp(challenge, "123456");
  const verify = calls.find((c) => c.url.endsWith("/mfa/verify"))!;
  assert.deepEqual([verify.body.mfa_challenge_token, verify.body.code], ["CHAL", "123456"]);
  const out = await realm.device.approve({ userCode: "ABCD-EFGH", revokeExistingSessions: true });
  assert.equal(out.status, "approved");
  const second = calls.filter((c) => c.url.endsWith("/device/approve"))[1];
  assert.equal(second.headers["authorization"], "Bearer NEW_BEARER");
  realm.close();
});

test("withStepUpRetry returns a caller-marked request's 412 untouched and never prompts", async () => {
  let prompted = false;
  const f = withStepUpRetry(
    async () => new Response(JSON.stringify({ error: { code: "mfa_required" }, mfa_challenge_token: "C", methods: ["totp"] }), { status: 412, headers: { "content-type": "application/json" } }),
    { baseUrl: () => "https://bff.test", currentBearer: () => "B", adopt: () => {}, prompt: async () => { prompted = true; return "1"; } } as any,
  );
  const res = await f("https://bff.test/device/approve", { method: "POST", realmidStepUp: "caller" } as RequestInit);
  assert.equal(res.status, 412);
  assert.equal(prompted, false);
});

test("an UNmarked request still gets the old behaviour (regression guard, passes before the change)", async () => {
  let prompted = false;
  const f = withStepUpRetry(
    async () => new Response(JSON.stringify({ error: { code: "mfa_required" }, mfa_challenge_token: "C", methods: ["totp"] }), { status: 412, headers: { "content-type": "application/json" } }),
    { baseUrl: () => "https://bff.test", currentBearer: () => "B", adopt: () => {}, prompt: async () => { prompted = true; return null; } } as any,
  );
  await f("https://bff.test/api/x", { method: "POST" });
  assert.equal(prompted, true);
});
