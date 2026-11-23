/**
 * `realm.mfa.recover(code)` (SPEC §4.3b): completes the pending MFA challenge
 * with a single-use recovery code, through the same transport and gates as
 * `mfa.verify`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRealm, RealmError } from "./index.js";
import type { GateRule, RequestAdapters, ResponseAdapters } from "./types.js";

interface MockCall {
  url: string;
  method: string;
  body: unknown;
}

function mockFetch(handler: (call: MockCall) => { status: number; body?: unknown; headers?: Record<string, string> }) {
  const calls: MockCall[] = [];
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const call = { url, method: init?.method ?? "GET", body };
    calls.push(call);
    const res = handler(call);
    return new Response(res.body !== undefined ? JSON.stringify(res.body) : null, {
      status: res.status,
      headers: { "Content-Type": "application/json", ...(res.headers ?? {}) },
    });
  };
  return { fetch: fn, calls };
}

const mfaGate: GateRule[] = [
  {
    status: 412,
    code: "mfa_required",
    gate: "mfa_required",
    extract: (b) => ({ challengeToken: (b as Record<string, unknown>).mfa_challenge_token, method: "totp" }),
  },
];

const loginOk = {
  accessToken: "at-1",
  expiresIn: 300,
  user: { id: "u1" },
  tenants: [{ id: "t1", role: "member" }],
  defaultTenantId: "t1",
};

/** A realm whose login is held by an MFA gate, with `/mfa/recovery` answered by `recovery`. */
async function pendingRealm(
  recovery: (call: MockCall) => { status: number; body?: unknown; headers?: Record<string, string> },
  extra: { requestAdapters?: RequestAdapters; responseAdapters?: ResponseAdapters; endpoints?: Record<string, string> } = {},
) {
  const m = mockFetch((call) => {
    if (call.url.endsWith("/me")) return { status: 401 };
    if (call.url.endsWith("/login")) return { status: 412, body: { code: "mfa_required", mfa_challenge_token: "ch-1" } };
    return recovery(call);
  });
  const realm = createRealm({ baseUrl: "https://bff.test", fetch: m.fetch, gates: mfaGate, ...extra });
  await realm.ready();
  await assert.rejects(() => realm.login({ method: "google", providerToken: "g" }));
  return { realm, calls: m.calls };
}

test("mfa.recover sends the challenge token and code to /mfa/recovery and flags re-enrollment", async () => {
  const { realm, calls } = await pendingRealm(() => ({ status: 200, body: { ...loginOk, reenroll_required: true } }));
  const out = await realm.mfa.recover("abcd-efgh");
  const sent = calls.find((c) => c.url.endsWith("/mfa/recovery"));
  assert.ok(sent, "the recovery endpoint was called");
  assert.equal(sent.method, "POST");
  assert.deepEqual(sent.body, { challengeToken: "ch-1", code: "abcd-efgh" });
  assert.equal(out.reenrollRequired, true);
  assert.equal(realm.mfa.pending(), null);
  realm.close();
});

test("mfa.recover without a pending challenge throws mfa_failed and sends nothing", async () => {
  const m = mockFetch((call) => (call.url.endsWith("/me") ? { status: 401 } : { status: 200, body: loginOk }));
  const realm = createRealm({ baseUrl: "https://bff.test", fetch: m.fetch });
  await realm.ready();
  const before = m.calls.length;
  await assert.rejects(
    () => realm.mfa.recover("x"),
    (e) => e instanceof RealmError && e.code === "mfa_failed" && e.message === "no challenge pending",
  );
  assert.equal(m.calls.length, before);
  realm.close();
});

test("mfa.recover uses the mfaRecovery request adapter and endpoint override", async () => {
  const { realm, calls } = await pendingRealm(() => ({ status: 200, body: loginOk }), {
    requestAdapters: {
      mfaRecovery: (c) => ({ mfa_challenge_token: c.challengeToken, code: c.code }),
    },
    endpoints: { mfaRecovery: "/api/auth/mfa/recovery" },
  });
  const out = await realm.mfa.recover("abcd-efgh");
  const sent = calls.find((c) => c.url.endsWith("/api/auth/mfa/recovery"));
  assert.deepEqual(sent?.body, { mfa_challenge_token: "ch-1", code: "abcd-efgh" });
  assert.equal(out.reenrollRequired, true, "a successful redeem asks the app to enroll a new factor");
  realm.close();
});

test("mfa.recover: the wire value of reenroll_required wins", async () => {
  const { realm } = await pendingRealm(() => ({ status: 200, body: { ...loginOk, reenroll_required: false } }));
  assert.equal((await realm.mfa.recover("x")).reenrollRequired, false);
  realm.close();
});

test("mfa.recover failure keeps the pending challenge; lockout surfaces the retry delay", async () => {
  let n = 0;
  const { realm } = await pendingRealm(() => {
    n++;
    return n === 1
      ? { status: 401, body: { error: { code: "mfa_failed", message: "bad code" } } }
      : { status: 429, body: { error: { code: "mfa_too_many_fails", message: "locked" } }, headers: { "Retry-After": "30" } };
  });
  await assert.rejects(() => realm.mfa.recover("wrong"), (e) => e instanceof RealmError);
  assert.equal(realm.mfa.pending()?.challengeToken, "ch-1", "the challenge survives a failed attempt");
  await assert.rejects(
    () => realm.mfa.recover("wrong-again"),
    (e) => {
      if (!(e instanceof RealmError) || e.status !== 429) return false;
      const code = ((e.body as { error?: { code?: string } }).error ?? {}).code;
      return code === "mfa_too_many_fails";
    },
  );
  assert.equal(realm.mfa.pending()?.challengeToken, "ch-1");
  realm.close();
});
