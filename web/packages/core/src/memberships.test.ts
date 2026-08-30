/**
 * Membership self-service (ADR-092 D5) + the code taxonomy, including the
 * parity gate against `@realm-id/sdk`, which owns the canonical list.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createMemberships,
  MEMBERSHIP_ACTION_CODES,
  membershipActionCode,
  isMembershipActionCode,
} from "./memberships.js";
import { RealmError } from "./errors.js";
import { MEMBERSHIP_ACTION_CODES as SDK_CODES } from "@realm-id/sdk";

type Call = { url: string; init: RequestInit | undefined };

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

const OK = () => json(200, { data: { tenant_id: "t1", status: "chosen", released: 2 } });

// ---- taxonomy ----

test("PARITY: the code list matches @realm-id/sdk exactly, as a SET", () => {
  assert.deepEqual(
    [...MEMBERSHIP_ACTION_CODES].sort(),
    [...SDK_CODES].sort(),
    "the taxonomy drifted from @realm-id/sdk's MEMBERSHIP_ACTION_CODES",
  );
  assert.ok(MEMBERSHIP_ACTION_CODES.length >= 9, "the list emptied out — a vacuous pass");
});

test("membershipActionCode reads the code wherever the transport parked it", () => {
  // core's RealmError: closed ErrorCode union, so the server code lands in body.
  assert.equal(
    membershipActionCode(new RealmError("bad_request", "x", 409, { code: "owner_cannot_leave" })),
    "owner_cannot_leave",
  );
  // web-admin / @realm-id/sdk RealmError: unrecognised codes go to details.server_code.
  assert.equal(
    membershipActionCode({ code: "conflict", details: { server_code: "already_left" } }),
    "already_left",
  );
  // A transport that maps it straight onto `.code`.
  assert.equal(membershipActionCode({ code: "not_pending" }), "not_pending");
  // Nested envelope kept raw on the body.
  assert.equal(
    membershipActionCode({ body: { error: { code: "membership_not_found" } } }),
    "membership_not_found",
  );
});

test("membershipActionCode refuses anything outside the taxonomy", () => {
  assert.equal(membershipActionCode(null), null);
  assert.equal(membershipActionCode(new Error("boom")), null);
  assert.equal(membershipActionCode({ code: "forbidden" }), null);
  assert.equal(membershipActionCode({ code: 7 }), null);
  assert.equal(isMembershipActionCode({ code: "owner_cannot_leave" }), true);
  assert.equal(isMembershipActionCode({ code: "forbidden" }), false);
});

// ---- transport ----

test("the four operations hit the TYPED BFF routes, not the /api passthrough", async () => {
  const cases: Array<[string, (m: ReturnType<typeof createMemberships>) => Promise<unknown>, string, string]> = [
    ["chooseTenant", (m) => m.chooseTenant("t 1"), "POST", "https://bff.example/me/tenant-choice"],
    ["acceptInvitation", (m) => m.acceptInvitation("t 1"), "POST", "https://bff.example/me/invitations/t%201/accept"],
    ["rejectInvitation", (m) => m.rejectInvitation("t 1"), "POST", "https://bff.example/me/invitations/t%201/reject"],
    ["leave", (m) => m.leave("t 1"), "POST", "https://bff.example/me/memberships/t%201/leave"],
  ];
  for (const [name, run, method, url] of cases) {
    const { realm, calls } = fakeRealm(OK);
    const m = createMemberships(realm, { baseUrl: "https://bff.example" });
    await run(m);
    assert.equal(calls.length, 1, name);
    assert.equal(calls[0].url, url, name);
    assert.equal(calls[0].init?.method, method, name);
  }
});

test("chooseTenant sends the tenant in the BODY and unwraps the envelope", async () => {
  const { realm, calls } = fakeRealm(OK);
  const m = createMemberships(realm, { baseUrl: "https://bff.example/" });
  const out = await m.chooseTenant("t1");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { tenant_id: "t1" });
  assert.deepEqual(out, { tenant_id: "t1", status: "chosen", released: 2 });
});

test("the session bearer must ship — these are NOT anonymous routes", async () => {
  const { realm, calls } = fakeRealm(OK);
  await createMemberships(realm, { baseUrl: "https://bff.example" }).leave("t1");
  const init = calls[0].init as (RequestInit & { anonymous?: boolean }) | undefined;
  assert.notEqual(init?.anonymous, true,
    "anonymous:true would strip the session bearer and the BFF answers 401 session_missing");
});

test("a 409 surfaces the SERVER code, not a flattened status classification", async () => {
  const { realm } = fakeRealm(() => json(409, { error: { code: "owner_cannot_leave", message: "you own this" } }));
  const m = createMemberships(realm, { baseUrl: "https://bff.example" });
  await assert.rejects(
    () => m.leave("t1"),
    (e: unknown) => {
      assert.equal(membershipActionCode(e), "owner_cannot_leave");
      assert.equal((e as RealmError).status, 409);
      assert.equal((e as Error).message, "you own this");
      return true;
    },
  );
});

test("the two owner refusals stay DISTINCT — one banner for both is the bug", async () => {
  const seen = new Set<string>();
  for (const code of ["owner_cannot_leave", "owner_cannot_be_revoked"]) {
    const { realm } = fakeRealm(() => json(409, { error: { code, message: "no" } }));
    const m = createMemberships(realm, { baseUrl: "https://bff.example" });
    await m.leave("t1").catch((e: unknown) => { seen.add(String(membershipActionCode(e))); });
  }
  assert.equal(seen.size, 2, "the two codes collapsed into one");
});

test("a 204 resolves rather than exploding on an empty body", async () => {
  const { realm } = fakeRealm(() => new Response(null, { status: 204 }));
  const m = createMemberships(realm, { baseUrl: "https://bff.example" });
  assert.equal(await m.leave("t1"), undefined);
});
