import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createRealm } from "./realm.js";

test("tenants.list: pages through cursor", async () => {
  const pages = [
    { items: [{ id: "t1" }, { id: "t2" }], next_cursor: "c2" },
    { items: [{ id: "t3" }] },
  ];
  let i = 0;
  const fetch: typeof fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (i === 0) {
      assert.ok(!url.includes("cursor="), `first request must not carry cursor: ${url}`);
    } else {
      assert.match(url, /cursor=c2/);
    }
    const body = pages[i++]!;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const seen: string[] = [];
  for await (const t of realm.tenants.list()) {
    seen.push(t.id);
  }
  assert.deepEqual(seen, ["t1", "t2", "t3"]);
});

test("tenants.list: manual page() exposes nextCursor", async () => {
  const fetch: typeof fetch = (async () => new Response(
    JSON.stringify({ items: [{ id: "t1" }], next_cursor: "ck" }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as typeof fetch;
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const p = await realm.tenants.list().page({ limit: 50 });
  assert.equal(p.items.length, 1);
  assert.equal(p.nextCursor, "ck");
});
