import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createRealm } from "./realm.js";
import { RealmError } from "./errors.js";

interface Captured {
  method: string;
  url: string;
  body?: unknown;
}

function mkFetch(handler: (req: Captured) => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url.endsWith("/auth/login")) {
      return new Response(JSON.stringify({
        status: "ok", subject_type: "platform", refresh_token: "rtok-platform",
        access_token: "pt_x", expires_in: 300,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    let body: unknown;
    if (typeof init?.body === "string" && init.body.length > 0) {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    return handler({ method, url, body });
  }) as typeof fetch;
}

const cfg = { realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test" };

test("sources.list: GETs /sources?platform_id=<realm> and returns a page", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "GET");
    assert.match(req.url, /\/sources\?platform_id=r$/);
    return new Response(JSON.stringify({
      items: [
        { id: "src-1", platform_id: "r", type: "web", label: "Web app",
          allowed_methods: ["google"], enabled: true, created_at: 100 },
        { id: "src-2", platform_id: "r", type: "bot", label: "Bot",
          allowed_methods: ["otp"], enabled: false, created_at: 200 },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const realm = createRealm({ ...cfg, fetch });
  const page = await realm.sources.list().page();
  assert.equal(page.items.length, 2);
  assert.deepEqual(page.items[1]!.allowed_methods, ["otp"]);
  // No has_more and no cursor on the wire: not "more pages", not a guess.
  assert.equal(page.hasMore, false);
});

test("sources.create: POSTs /sources, defaults platform_id to the realm", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "POST");
    assert.match(req.url, /\/sources$/);
    assert.deepEqual(req.body, {
      platform_id: "r", type: "web", label: "Web app", allowed_methods: ["google"],
    });
    return new Response(JSON.stringify({
      id: "src-1", platform_id: "r", type: "web", label: "Web app",
      allowed_methods: ["google"], enabled: true, created_at: 100,
    }), { status: 201, headers: { "content-type": "application/json" } });
  });
  const realm = createRealm({ ...cfg, fetch });
  const src = await realm.sources.create({ type: "web", label: "Web app", allowedMethods: ["google"] });
  assert.equal(src.id, "src-1");
  assert.equal(src.platform_id, "r");
});

test("sources.create: 400 method_violates_kind surfaces on error.code", async () => {
  const fetch = mkFetch(() => new Response(JSON.stringify({
    error: { code: "method_violates_kind", message: "human source may not list otp" },
  }), { status: 400, headers: { "content-type": "application/json" } }));
  const realm = createRealm({ ...cfg, fetch });
  await assert.rejects(
    () => realm.sources.create({ type: "web", label: "X", allowedMethods: ["otp"] }),
    (e: Error) => e instanceof RealmError && e.code === "method_violates_kind",
  );
});

test("sources.update: PATCHes only provided fields", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "PATCH");
    assert.match(req.url, /\/sources\/src-1$/);
    assert.deepEqual(req.body, { label: "Renamed", enabled: false });
    return new Response(JSON.stringify({
      id: "src-1", platform_id: "r", type: "web", label: "Renamed",
      allowed_methods: ["google"], enabled: false, created_at: 100,
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const realm = createRealm({ ...cfg, fetch });
  const src = await realm.sources.update("src-1", { label: "Renamed", enabled: false });
  assert.equal(src.label, "Renamed");
  assert.equal(src.enabled, false);
});

test("sources.delete: DELETEs /sources/{id}", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "DELETE");
    assert.match(req.url, /\/sources\/src-1$/);
    return new Response(JSON.stringify({ status: "deleted" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  const realm = createRealm({ ...cfg, fetch });
  await realm.sources.delete("src-1");
});
