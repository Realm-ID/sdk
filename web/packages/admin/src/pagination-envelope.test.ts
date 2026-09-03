/**
 * The pagination envelope must survive a ROUND TRIP, and every list method on
 * this package must hand it to the caller.
 *
 * A decode-only assertion ("the field arrived") passes whether or not the field
 * is carried onward. That is not hypothetical: `go/v0.53.0` deleted
 * `credential_methods` from discovery because the BFF decoded an SDK type and
 * RE-SERIALISED it, and every layer's own suite stayed green.
 *
 * This package matters twice over: it is what `ui/web` actually calls, and it
 * carries its OWN ApiKeysClient (deliberately overriding the bundled one), so
 * fixing `@realm-id/sdk` alone would have left the console on page one.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ApiKeysClient } from "./api-keys.js";
import { readPage, writePage } from "@realm-id/sdk";
import type { HttpLike } from "./transport.js";
import type { RequestOptions } from "@realm-id/sdk/internal";

function pagedHttp(pages: Record<string, unknown>): { http: HttpLike; calls: RequestOptions[] } {
  const calls: RequestOptions[] = [];
  const http: HttpLike = {
    async request<T>(opts: RequestOptions): Promise<T> {
      calls.push(opts);
      const cursor = (opts.query?.["cursor"] as string | undefined) ?? "";
      return pages[cursor] as T;
    },
  };
  return { http, calls };
}

describe("pagination envelope", () => {
  it("survives decode → re-encode with every wire key intact", () => {
    const wire = { items: [{ id: "a" }], next_cursor: "cur-2", has_more: true, total: 97 };
    const page = readPage<{ id: string }>(wire);
    assert.equal(page.nextCursor, "cur-2");
    assert.equal(page.hasMore, true);
    assert.equal(page.total, 97);
    assert.deepEqual(writePage(page), wire, "re-encoded envelope lost a field on the way OUT");
  });

  it("re-encodes has_more:false as an explicit false, not an absent key", () => {
    const back = writePage(readPage({ items: [], next_cursor: null, has_more: false })) as Record<string, unknown>;
    assert.ok("has_more" in back, "re-encoded envelope dropped has_more entirely");
    assert.equal(back["has_more"], false);
  });
});

describe("ApiKeysClient.list", () => {
  const row = (id: string) => ({
    id, prefix: `rk_live_${id}`, role: "admin",
    created_at: 1, last_used_at: null, revoked_at: null, expires_at: null,
  });

  it("exposes the envelope instead of discarding it", async () => {
    const { http, calls } = pagedHttp({
      "": { items: [row("k1")], next_cursor: "cur-2", has_more: true, total: 3 },
    });
    const page = await new ApiKeysClient(http).list("p1").page({ limit: 25 });
    assert.equal(page.items.length, 1);
    assert.equal(page.nextCursor, "cur-2");
    assert.equal(page.hasMore, true, "envelope discarded — the console cannot detect truncation");
    assert.equal(page.total, 3);
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.path, "/platforms/p1/api-keys");
    assert.equal(calls[0]!.query?.["limit"], 25);
  });

  it("walks every page rather than stopping at page one", async () => {
    const { http } = pagedHttp({
      "": { items: [row("k1")], next_cursor: "cur-2", has_more: true },
      "cur-2": { items: [row("k2")], next_cursor: null, has_more: false },
    });
    const ids: string[] = [];
    for await (const k of new ApiKeysClient(http).list("p1")) ids.push(k.id);
    assert.deepEqual(ids, ["k1", "k2"], "pager stopped at page one");
  });

  it("stops on has_more:false even with a non-empty next_cursor", async () => {
    const { http, calls } = pagedHttp({
      "": { items: [row("k1")], next_cursor: "cur-9", has_more: false },
    });
    let n = 0;
    for await (const _ of new ApiKeysClient(http).list("p1")) {
      if (++n > 5) throw new Error("pager did not terminate on has_more:false");
    }
    assert.equal(calls.length, 1, "has_more:false is the terminator, not next_cursor");
  });

  it("treats an absent has_more as 'derive from next_cursor', never as false", async () => {
    const { http } = pagedHttp({
      "": { items: [row("k1")], next_cursor: "cur-2" },
      "cur-2": { items: [row("k2")], next_cursor: null },
    });
    const ids: string[] = [];
    for await (const k of new ApiKeysClient(http).list("p1")) ids.push(k.id);
    assert.deepEqual(ids, ["k1", "k2"]);
  });
});

// --- the serialised query string, not the intent of the code ----------------
//
// The issuer now answers `400 invalid_limit` to `limit=0`, where it was
// previously absorbed into the default. This package builds its own query in
// `transport.ts`, so `@realm-id/sdk`'s guarantee does not cover it — the
// assertion has to be made here too, against a real URL.

describe("query serialisation", () => {
  function urlCapturingAdmin() {
    const urls: string[] = [];
    const http: HttpLike = {
      async request<T>(opts: RequestOptions): Promise<T> {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(opts.query ?? {})) {
          if (v === undefined || v === null || v === "") continue;
          params.set(k, String(v));
        }
        const qs = params.toString();
        urls.push(opts.path + (qs ? `?${qs}` : ""));
        return { items: [], next_cursor: null, has_more: false } as T;
      },
    };
    return { http, urls };
  }

  it("omits an unset limit and cursor entirely", async () => {
    const { http, urls } = urlCapturingAdmin();
    await new ApiKeysClient(http).list("p1").page();
    assert.equal(urls[0], "/platforms/p1/api-keys",
      "an unset limit/cursor must produce no query string at all (400 invalid_limit)");
  });

  it("sends a limit and cursor that were actually supplied", async () => {
    const { http, urls } = urlCapturingAdmin();
    await new ApiKeysClient(http).list("p1").page({ cursor: "c1", limit: 25 });
    const q = new URLSearchParams(urls[0]!.split("?")[1]);
    assert.equal(q.get("limit"), "25");
    assert.equal(q.get("cursor"), "c1");
  });
});
