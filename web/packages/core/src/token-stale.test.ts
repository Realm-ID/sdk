/**
 * ADR-107 on the browser side: `token_stale` is a 401 that must NEVER end the
 * session.
 *
 * The demotion window is not what this file is defending. It is the two ways a
 * naive 401 handler makes things WORSE than the window it closes:
 *
 *   1. Collapse `token_stale` into `unauthorized` and the user is signed out on
 *      PROMOTION — on a grant that just widened their access (D10).
 *   2. Refresh on every `token_stale` and a marker sitting ahead of the
 *      issuer's clock turns into an unbounded refresh loop aimed at the mint
 *      endpoint, from every tab (C5 / D13).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createRealm } from "./realm.js";
import { classifyHttpStatus, RealmError } from "./errors.js";

interface MockCall {
  url: string;
  method: string;
  body: unknown;
}

function mockFetch(handler: (call: MockCall) => { status: number; body?: unknown }) {
  const calls: MockCall[] = [];
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const call = {
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    const { status, body } = handler(call);
    return new Response(body !== undefined ? JSON.stringify(body) : null, {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetch: fn, calls };
}

const LOGIN_BODY = {
  accessToken: "at-1",
  expiresIn: 3600,
  user: { id: "u1" },
  tenants: [{ id: "t1", role: "owner" }],
  defaultTenantId: "t1",
};

/* ------------------------------------------------------------- classification */

test("classifyHttpStatus reads token_stale off the body, at both code paths", () => {
  // A plain 401 whose message is prose — nothing about the STATUS distinguishes
  // it, which is why the classifier has to read the code here.
  assert.equal(
    classifyHttpStatus(401, { code: "token_stale", message: "token minted before the subject's authority changed" }),
    "token_stale",
  );
  assert.equal(classifyHttpStatus(401, { error: { code: "token_stale", message: "x" } }), "token_stale");
});

test("classifyHttpStatus did not become a blanket trust-the-body rule", () => {
  // The control. token_stale is promoted BY NAME; every other 401 keeps the
  // classification the SDK already had, so `.code` stays a classification and
  // `.body.code` stays the fact.
  assert.equal(classifyHttpStatus(401, { code: "refresh_invalid", message: "x" }), "unauthorized");
  assert.equal(classifyHttpStatus(401, { message: "session was revoked" }), "session_revoked");
  assert.equal(classifyHttpStatus(401, { message: "nothing in particular" }), "unauthorized");
});

/* ------------------------------------------------------------------ the fetch */

test("realm.fetch: token_stale refreshes once and replays", async () => {
  let ordersCalls = 0;
  const { fetch } = mockFetch((call) => {
    if (call.url.endsWith("/me")) return { status: 401 };
    if (call.url.endsWith("/login")) return { status: 200, body: LOGIN_BODY };
    if (call.url.endsWith("/token")) return { status: 200, body: { accessToken: "at-2", expiresIn: 3600 } };
    if (call.url.includes("/api/orders")) {
      ordersCalls++;
      if (ordersCalls === 1) {
        return { status: 401, body: { code: "token_stale", message: "authority changed" } };
      }
      return { status: 200, body: { ok: true } };
    }
    return { status: 404 };
  });

  const realm = createRealm({ baseUrl: "https://bff.test", fetch });
  await realm.ready();
  await realm.login({ method: "google", providerToken: "x" });

  const res = await realm.fetch("https://api.test/api/orders");
  assert.equal(res.status, 200, "the demoted user's replay did not succeed");
  assert.equal(ordersCalls, 2);
  // D11: the session survives. Demotion narrows the token; it does not sign
  // anyone out.
  assert.equal(realm.getState().status, "authenticated");
  realm.close();
});

test("realm.fetch: a second token_stale on the REFRESHED token does not refresh again (D13)", async () => {
  let tokenCalls = 0;
  const { fetch } = mockFetch((call) => {
    if (call.url.endsWith("/me")) return { status: 401 };
    if (call.url.endsWith("/login")) return { status: 200, body: LOGIN_BODY };
    if (call.url.endsWith("/token")) {
      tokenCalls++;
      return { status: 200, body: { accessToken: `at-${tokenCalls + 1}`, expiresIn: 3600 } };
    }
    // A marker sitting ahead of the issuer's clock: every token is stale,
    // including the one we just minted. This is C5's loop, reproduced.
    if (call.url.includes("/api/orders")) {
      return { status: 401, body: { code: "token_stale", message: "authority changed" } };
    }
    return { status: 404 };
  });

  const realm = createRealm({ baseUrl: "https://bff.test", fetch });
  await realm.ready();
  await realm.login({ method: "google", providerToken: "x" });

  const first = await realm.fetch("https://api.test/api/orders");
  assert.equal(first.status, 401);
  assert.equal(tokenCalls, 1, "the first token_stale should force exactly one refresh");

  // The token in hand was minted BY that forced refresh. Refreshing again
  // cannot help, and doing it on every call is the unbounded loop.
  const second = await realm.fetch("https://api.test/api/orders");
  assert.equal(second.status, 401);
  assert.equal(tokenCalls, 1, "a second token_stale minted again — the loop D13 exists to prevent");

  // Still signed in: a hard failure surfaces the 401, it does not tear the
  // session down.
  assert.equal(realm.getState().status, "authenticated");
  realm.close();
});

test("realm.fetch: an ORDINARY 401 still refreshes — the cap is token_stale-specific", async () => {
  let tokenCalls = 0;
  let ordersCalls = 0;
  const { fetch } = mockFetch((call) => {
    if (call.url.endsWith("/me")) return { status: 401 };
    if (call.url.endsWith("/login")) return { status: 200, body: LOGIN_BODY };
    if (call.url.endsWith("/token")) {
      tokenCalls++;
      return { status: 200, body: { accessToken: `at-${tokenCalls + 1}`, expiresIn: 3600 } };
    }
    if (call.url.includes("/api/orders")) {
      ordersCalls++;
      return { status: 401, body: { error: { message: "expired" } } };
    }
    return { status: 404 };
  });

  const realm = createRealm({ baseUrl: "https://bff.test", fetch });
  await realm.ready();
  await realm.login({ method: "google", providerToken: "x" });

  await realm.fetch("https://api.test/api/orders");
  await realm.fetch("https://api.test/api/orders");
  // Without this control, a cap that accidentally applied to every 401 would
  // look identical to a working one in the test above.
  assert.equal(tokenCalls, 2, "the D13 cap leaked onto ordinary 401s");
  assert.equal(ordersCalls, 4);
  realm.close();
});

/* --------------------------------------------------------------- the session */

test("restore(): token_stale does NOT drop the session to anonymous (D11)", async () => {
  const { fetch } = mockFetch((call) => {
    if (call.url.endsWith("/login")) return { status: 200, body: LOGIN_BODY };
    if (call.url.endsWith("/me")) {
      return { status: 401, body: { code: "token_stale", message: "authority changed" } };
    }
    return { status: 404 };
  });

  const realm = createRealm({ baseUrl: "https://bff.test", fetch });
  await realm.ready();
  await realm.login({ method: "google", providerToken: "x" });
  assert.equal(realm.getState().status, "authenticated");

  await realm.restore();
  // The blanket `err.status === 401` sign-out branch is exactly what would
  // swallow this. On a PROMOTION it would end the session on a grant that just
  // widened the user's access.
  assert.equal(realm.getState().status, "authenticated");
  assert.notEqual(realm.getState().user, null);
  realm.close();
});

test("RealmError carries token_stale as its own code", () => {
  const e = new RealmError("token_stale", "authority changed", 401);
  assert.equal(e.code, "token_stale");
  assert.equal(e.status, 401);
});
