import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SessionsClient } from "./sessions.js";
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

describe("SessionsClient admin revocation (ADR-080)", () => {
  it("revokeUser POSTs the member session-revoke path and encodes ids", async () => {
    const { http, calls } = makeHttp({ status: "ok", revoked: 3 });
    const client = new SessionsClient(http);
    const out = await client.revokeUser("t 1", "u/2");
    assert.deepEqual(out, { status: "ok", revoked: 3 });
    assert.equal(calls[0]!.opts.method, "POST");
    assert.equal(calls[0]!.opts.path, "/tenants/t%201/users/u%2F2/sessions/revoke");
  });

  it("revokeRealmSessions POSTs the realm-wide revoke-all path", async () => {
    const { http, calls } = makeHttp({ status: "ok", revoked: 42 });
    const client = new SessionsClient(http);
    const out = await client.revokeRealmSessions("p1");
    assert.equal(out.revoked, 42);
    assert.equal(calls[0]!.opts.method, "POST");
    assert.equal(calls[0]!.opts.path, "/platforms/p1/sessions/revoke-all");
  });

  it("self revokeAll still DELETEs /auth/sessions (unchanged)", async () => {
    const { http, calls } = makeHttp(undefined);
    const client = new SessionsClient(http);
    await client.revokeAll();
    assert.equal(calls[0]!.opts.method, "DELETE");
    assert.equal(calls[0]!.opts.path, "/auth/sessions");
  });
});
