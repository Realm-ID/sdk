import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AuditEventsClient } from "./audit-events.js";
import type { HttpLike } from "./transport.js";
import type { RequestOptions } from "@realm-id/sdk/internal";

function makeHttp(response: unknown): { http: HttpLike; calls: RequestOptions[] } {
  const calls: RequestOptions[] = [];
  const http: HttpLike = {
    async request<T>(opts: RequestOptions): Promise<T> {
      calls.push(opts);
      return response as T;
    },
  };
  return { http, calls };
}

// Covers the ADR-055 partner audit feed (issuer swagger
// `GET /platforms/{id}/audit-events`), replacing the hand-rolled
// `fetchPlatformAuditEvents` shim in `ui/web/src/api.ts`.
describe("AuditEventsClient (ADR-055)", () => {
  it("list GETs /platforms/{id}/audit-events, id path-escaped", async () => {
    const { http, calls } = makeHttp({
      items: [{ id: 1, occurred_at: 100, kind: "tenant.create" }],
      next_cursor: null,
    });
    const page = await new AuditEventsClient(http).list("p 1").page();
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.path, "/platforms/p%201/audit-events");
    assert.equal(page.items[0]!.kind, "tenant.create");
    assert.equal(page.hasMore, false);
  });

  it("threads tenantId/actorId/since/until/kind onto the query (issuer swagger params)", async () => {
    const { http, calls } = makeHttp({ items: [], next_cursor: null });
    await new AuditEventsClient(http)
      .list("p1", { tenantId: "t1", actorId: "a1", since: 100, until: 200, kind: "tenant.create" })
      .page();
    const q = calls[0]!.query;
    assert.equal(q?.["tenant_id"], "t1");
    assert.equal(q?.["actor_id"], "a1");
    assert.equal(q?.["since"], 100);
    assert.equal(q?.["until"], 200);
    assert.equal(q?.["kind"], "tenant.create");
  });

  it("joins a repeated kind filter into a comma-separated query value", async () => {
    const { http, calls } = makeHttp({ items: [], next_cursor: null });
    await new AuditEventsClient(http).list("p1", { kind: ["tenant.create", "user.invite"] }).page();
    assert.equal(calls[0]!.query?.["kind"], "tenant.create,user.invite");
  });

  it("a caller does NOT pass platform_id on the query — the path alone scopes it", async () => {
    const { http, calls } = makeHttp({ items: [], next_cursor: null });
    await new AuditEventsClient(http).list("p1").page();
    assert.ok(!("platform_id" in (calls[0]!.query ?? {})));
  });

  it("follows next_cursor across pages", async () => {
    const pages: Record<string, unknown> = {
      "": { items: [{ id: 1, occurred_at: 1, kind: "k1" }], next_cursor: "c2" },
      c2: { items: [{ id: 2, occurred_at: 2, kind: "k2" }], next_cursor: null },
    };
    const http: HttpLike = {
      async request<T>(opts: RequestOptions): Promise<T> {
        const cursor = (opts.query?.["cursor"] as string | undefined) ?? "";
        return pages[cursor] as T;
      },
    };
    const seen: string[] = [];
    for await (const ev of new AuditEventsClient(http).list("p1")) {
      seen.push(ev.kind);
    }
    assert.deepEqual(seen, ["k1", "k2"]);
  });
});
