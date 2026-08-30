/**
 * The pre-session revocation-token flow: the companion to the session-limit
 * 412 gate (BFF-SPEC item 6). The credential is the ONE-SHOT `revocation_token`
 * off that envelope, not a session — so every call here must be anonymous with
 * an explicit bearer, or the SDK attaches a session that does not exist yet.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createRevocationSessions } from "./revocation-sessions.js";

type Call = { url: string; init: (RequestInit & { anonymous?: boolean }) | undefined };

function fakeRealm(answer: () => Response) {
  const calls: Call[] = [];
  return {
    calls,
    realm: {
      async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
        calls.push({ url: String(input), init });
        return answer();
      },
    },
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const ROWS = [
  { id: "s1", origin: "https://app.example", created_at: 1, last_seen_at: 2 },
  { id: "s2", created_at: 3, device_name: "laptop" },
];

test("list hits the BFF's typed /sessions and returns the items", async () => {
  const { realm, calls } = fakeRealm(() => json(200, { data: { items: ROWS } }));
  const out = await createRevocationSessions(realm, { baseUrl: "https://bff.example" }).list("REV");
  assert.equal(calls[0].url, "https://bff.example/sessions");
  assert.equal(calls[0].init?.method, "GET");
  assert.deepEqual(out, ROWS);
});

test("the one-shot revocation_token is the bearer, and the SDK session is bypassed", async () => {
  const { realm, calls } = fakeRealm(() => json(200, { data: { items: [] } }));
  await createRevocationSessions(realm, { baseUrl: "https://bff.example" }).list("REV");
  const h = new Headers(calls[0].init?.headers);
  assert.equal(h.get("authorization"), "Bearer REV");
  assert.equal(calls[0].init?.anonymous, true,
    "this runs BEFORE a session exists — the SDK must not try to attach one");
});

test("revoke DELETEs one session by id, url-encoded", async () => {
  const { realm, calls } = fakeRealm(() => new Response(null, { status: 204 }));
  await createRevocationSessions(realm, { baseUrl: "https://bff.example" }).revoke("s/1", "REV");
  assert.equal(calls[0].url, "https://bff.example/sessions/s%2F1");
  assert.equal(calls[0].init?.method, "DELETE");
  assert.equal(new Headers(calls[0].init?.headers).get("authorization"), "Bearer REV");
});

test("a spent token surfaces the server code, not a bare 401", async () => {
  const { realm } = fakeRealm(() => json(401, { error: { code: "revocation_token_invalid", message: "spent" } }));
  const s = createRevocationSessions(realm, { baseUrl: "https://bff.example" });
  await assert.rejects(() => s.list("REV"), (e: unknown) => {
    assert.equal((e as { status: number }).status, 401);
    assert.equal((e as Error).message, "spent");
    assert.equal((e as { body?: { code?: string } }).body?.code, "revocation_token_invalid");
    return true;
  });
});

test("an empty items array is not confused with a missing one", async () => {
  const { realm } = fakeRealm(() => json(200, { data: {} }));
  assert.deepEqual(await createRevocationSessions(realm, { baseUrl: "https://bff.example" }).list("REV"), []);
});
