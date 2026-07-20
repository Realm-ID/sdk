import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AdminUsersClient, AdminDriftReviewsClient } from "./user-binding.js";
import type { HttpLike } from "./transport.js";
import type { RequestOptions } from "@realm-id/sdk/internal";

interface Captured {
  opts: RequestOptions;
}

function makeHttp(response: unknown): { http: HttpLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const http: HttpLike = {
    async request<T>(opts: RequestOptions): Promise<T> {
      calls.push({ opts });
      return response as T;
    },
  };
  return { http, calls };
}

/** The extended clients take the bundled-sdk `HttpClient` nominal type; the
 *  duck-typed HttpLike stub satisfies it structurally. */
function asSdkHttp(http: HttpLike): ConstructorParameters<typeof AdminUsersClient>[0] {
  return http as unknown as ConstructorParameters<typeof AdminUsersClient>[0];
}

describe("AdminUsersClient (ADR-080)", () => {
  it("delinkContact POSTs the delink path and encodes ids", async () => {
    const { http, calls } = makeHttp({ status: "delinked", contact_id: "c1", revoked_bindings: 2 });
    const client = new AdminUsersClient(asSdkHttp(http));
    const out = await client.delinkContact("t 1", "u/2", "c1");
    assert.deepEqual(out, { status: "delinked", contact_id: "c1", revoked_bindings: 2 });
    assert.equal(calls[0]!.opts.method, "POST");
    assert.equal(calls[0]!.opts.path, "/tenants/t%201/users/u%2F2/contacts/c1/delink");
    assert.equal(calls[0]!.opts.body, undefined);
  });

  it("handBack POSTs from_user_id to the hand-back path", async () => {
    const { http, calls } = makeHttp({ status: "handed_back", user_id: "u1", email: "a@b.com" });
    const client = new AdminUsersClient(asSdkHttp(http));
    const out = await client.handBack("t1", "u1", "u9");
    assert.equal(out.status, "handed_back");
    assert.equal(out.email, "a@b.com");
    assert.equal(calls[0]!.opts.method, "POST");
    assert.equal(calls[0]!.opts.path, "/tenants/t1/users/u1/hand-back");
    assert.deepEqual(calls[0]!.opts.body, { from_user_id: "u9" });
  });

  it("inherits the base UsersClient surface (e.g. get)", async () => {
    const { http, calls } = makeHttp({ id: "u1" });
    const client = new AdminUsersClient(asSdkHttp(http));
    await client.get("t1", "u1");
    assert.equal(calls[0]!.opts.method, "GET");
    assert.equal(calls[0]!.opts.path, "/tenants/t1/users/u1");
  });
});

describe("AdminDriftReviewsClient (ADR-080)", () => {
  it("rejectHard POSTs { hard: true } to the reject path", async () => {
    const { http, calls } = makeHttp({ id: "r1", status: "rejected", mode: "hard", parked: true, revoked_bindings: 1 });
    const client = new AdminDriftReviewsClient(asSdkHttp(http));
    const out = await client.rejectHard("t1", "r1");
    assert.equal(out.mode, "hard");
    assert.equal(out.parked, true);
    assert.equal(out.revoked_bindings, 1);
    assert.equal(calls[0]!.opts.method, "POST");
    assert.equal(calls[0]!.opts.path, "/tenants/t1/contact-drift-reviews/r1/reject");
    assert.deepEqual(calls[0]!.opts.body, { hard: true });
  });

  it("inherits the soft reject (no body) from the base class", async () => {
    const { http, calls } = makeHttp({ id: "r1", status: "rejected", mode: "soft" });
    const client = new AdminDriftReviewsClient(asSdkHttp(http));
    await client.reject("t1", "r1");
    assert.equal(calls[0]!.opts.method, "POST");
    assert.equal(calls[0]!.opts.path, "/tenants/t1/contact-drift-reviews/r1/reject");
    assert.equal(calls[0]!.opts.body, undefined);
  });
});
