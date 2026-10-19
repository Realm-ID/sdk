/**
 * ADR-117 D6 browser surface: invitation inspect (anonymous) and accept (the login flow's tail),
 * through the BFF routes POST /auth/invitations/inspect|accept.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createRealm, RealmError, type GateRule } from "./index.js";

interface Call { url: string; method: string; body: unknown; credentials?: RequestCredentials }

function mock(handler: (c: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
      credentials: init?.credentials,
    };
    calls.push(call);
    const r = handler(call);
    return new Response(r.body !== undefined ? JSON.stringify(r.body) : null, {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { calls, fetch };
}

const LOGIN_OK = {
  accessToken: "at-1",
  expiresIn: 3600,
  user: { id: "u1", email: "u@x" },
  tenants: [{ id: "t1", role: "member" }],
  defaultTenantId: "t1",
};

test("inspectInvitation: anonymous POST, token in the body only, returns the org and expiry", async () => {
  const { calls, fetch } = mock((c) =>
    c.url.endsWith("/me")
      ? { status: 401 }
      : { status: 200, body: { tenant_id: "t9", tenant_display_name: "Acme", expires_at: "2026-11-01T00:00:00Z" } },
  );
  const realm = createRealm({ baseUrl: "https://bff.test", fetch });
  const out = await realm.inspectInvitation("tok-1");
  assert.deepEqual(out, { tenantId: "t9", tenantDisplayName: "Acme", expiresAt: "2026-11-01T00:00:00Z" });
  const c = calls.find((x) => x.url.endsWith("/auth/invitations/inspect"))!;
  assert.equal(c.method, "POST");
  assert.deepEqual(c.body, { token: "tok-1" });
  assert.equal(c.credentials, "omit");
  assert.ok(!c.url.includes("tok-1"));
});

test("inspectInvitation unwraps a data envelope", async () => {
  const { fetch } = mock(() => ({
    status: 200,
    body: { data: { tenant_id: "t", tenant_display_name: "A", expires_at: "x" } },
  }));
  const out = await createRealm({ baseUrl: "https://b", fetch }).inspectInvitation("t");
  assert.equal(out.tenantDisplayName, "A");
});

test("acceptInvitation: posts token+username+password and signs in like login", async () => {
  const { calls, fetch } = mock((c) =>
    c.url.endsWith("/auth/invitations/accept") ? { status: 200, body: LOGIN_OK } : { status: 401 },
  );
  const realm = createRealm({ baseUrl: "https://bff.test", fetch });
  const res = await realm.acceptInvitation({ token: "tok", username: "ann", password: "pw" });
  assert.equal(res.user?.id, "u1");
  const c = calls.find((x) => x.url.endsWith("/auth/invitations/accept"))!;
  assert.deepEqual(c.body, { token: "tok", username: "ann", password: "pw" });
  assert.equal(c.credentials, "include", "the session cookie is minted here");
  const s = realm.getState();
  assert.equal(s.status, "authenticated");
  assert.equal(s.currentTenantId, "t1");
});

test("acceptInvitation: a 412 mfa_required gate leaves the challenge pending, as login does", async () => {
  const gates: GateRule[] = [
    {
      status: 412,
      code: "mfa_required",
      gate: "mfa_required",
      extract: (b) => ({ challengeId: (b as { challenge_id?: string }).challenge_id, method: "totp" }),
    },
  ];
  const { fetch } = mock((c) =>
    c.url.endsWith("/auth/invitations/accept")
      ? { status: 412, body: { code: "mfa_required", challenge_id: "ch1" } }
      : { status: 401 },
  );
  const realm = createRealm({ baseUrl: "https://bff.test", fetch, gates });
  await assert.rejects(
    realm.acceptInvitation({ token: "t", username: "u", password: "p" }),
    (e: unknown) => e instanceof RealmError && e.code === "mfa_required",
  );
  assert.equal(realm.getState().status, "anonymous");
  assert.equal(realm.mfa.pending()?.challengeId, "ch1");
});

test("acceptInvitation: username taken is a 409 conflict", async () => {
  const { fetch } = mock((c) =>
    c.url.endsWith("/auth/invitations/accept")
      ? { status: 409, body: { code: "conflict", message: "taken", details: { server_code: "identifier_collision" } } }
      : { status: 401 },
  );
  const realm = createRealm({ baseUrl: "https://bff.test", fetch });
  await assert.rejects(
    realm.acceptInvitation({ token: "t", username: "u", password: "p" }),
    (e: unknown) => e instanceof RealmError && e.status === 409,
  );
});
