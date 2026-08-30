/**
 * ADR-076 / ADR-087 ownership transfer, both recipient shapes.
 *
 * The bundled `@realm-id/sdk` `TenantsClient.transferOwner` only knows the
 * resolved-user_id form. The ADR-087 PARENT path (a platform owner acting on
 * one of their realm's orgs) cannot read the target's roster at all, so it must
 * name the recipient by email — see `issuer/internal/httpapi/tenants.go:1148`
 * and the `parentPath` branch at :1288.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { AdminTenantsClient } from "./tenants.js";

type Req = { method?: string; path: string; body?: Record<string, unknown> };

function spy() {
  const reqs: Req[] = [];
  const http = {
    async request<T>(opts: Req): Promise<T> {
      reqs.push(opts);
      return { status: "ok", owner_user_id: "u2" } as T;
    },
  };
  return { http: http as never, reqs };
}

function client() {
  const { http, reqs } = spy();
  return { c: new AdminTenantsClient(http, "p1"), reqs };
}

test("the user_id form still posts owner_user_id and nothing else", async () => {
  const { c, reqs } = client();
  await c.transferOwner("t1", "u2");
  assert.equal(reqs[0].method, "PUT");
  assert.equal(reqs[0].path, "/tenants/t1/owner");
  assert.deepEqual(reqs[0].body, { owner_user_id: "u2" });
});

test("the EMAIL form posts new_owner_email and never an owner_user_id", async () => {
  const { c, reqs } = client();
  await c.transferOwner("t1", { email: "new@acme.com" });
  assert.deepEqual(reqs[0].body, { new_owner_email: "new@acme.com" });
  assert.equal("owner_user_id" in (reqs[0].body ?? {}), false,
    "an empty owner_user_id beside an email makes the server take the wrong branch");
});

test("the outgoing owner's three dispositions all reach the wire", async () => {
  const { c, reqs } = client();
  await c.transferOwner("t1", "u2", { outgoingOwnerRole: "member" });
  await c.transferOwner("t1", "u2", { leaveEntirely: true });
  await c.transferOwner("t1", { email: "a@b.c" }, { suspendOutgoingOwner: true });
  assert.deepEqual(reqs[0].body, { owner_user_id: "u2", outgoing_owner_role: "member" });
  assert.deepEqual(reqs[1].body, { owner_user_id: "u2", leave_entirely: true });
  assert.deepEqual(reqs[2].body, { new_owner_email: "a@b.c", suspend_outgoing_owner: true });
});

test("leaveEntirely + suspendOutgoingOwner is refused BEFORE the request leaves", async () => {
  const { c, reqs } = client();
  await assert.rejects(
    () => c.transferOwner("t1", "u2", { leaveEntirely: true, suspendOutgoingOwner: true }),
    /mutually exclusive/i,
  );
  assert.equal(reqs.length, 0, "the issuer refuses this as conflicting_outgoing_disposition; don't spend a round trip");
});

test("an empty recipient is refused rather than posted as an empty string", async () => {
  const { c, reqs } = client();
  await assert.rejects(() => c.transferOwner("t1", "   "), /recipient/i);
  await assert.rejects(() => c.transferOwner("t1", { email: "" }), /recipient/i);
  assert.equal(reqs.length, 0);
});

test("the tenant id is encoded", async () => {
  const { c, reqs } = client();
  await c.transferOwner("t/1", "u2");
  assert.equal(reqs[0].path, "/tenants/t%2F1/owner");
});
