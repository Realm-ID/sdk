import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createRealm } from "./realm.js";
import { RealmError } from "./errors.js";
import { OWNER, MEMBER } from "./roles.js";

interface Captured {
  method: string;
  url: string;
  body?: unknown;
  authorization?: string;
}

function mkFetch(handler: (req: Captured) => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url.endsWith("/auth/platform-token")) {
      return new Response(JSON.stringify({ platform_token: "pt_x", expires_in: 300 }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    let body: unknown;
    if (typeof init?.body === "string" && init.body.length > 0) {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    const auth = init?.headers
      ? (init.headers as Record<string, string>)["authorization"]
      : undefined;
    return handler({ method, url, body, authorization: auth });
  }) as typeof fetch;
}

test("roles: named system constants", () => {
  assert.equal(OWNER, "owner");
  assert.equal(MEMBER, "member");
});

test("roles.list: returns the locked envelope shape", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "GET");
    assert.match(req.url, /\/realms\/r\/roles/);
    return new Response(JSON.stringify({
      items: [
        { name: "owner", permissions: [], is_system: true, created_at: 1, updated_at: 1 },
        { name: "salesman", display_name: "Field Sales", permissions: ["bills:read"],
          is_system: false, created_at: 2, updated_at: 3 },
      ],
      next_cursor: null,
      total: 2,
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const page = await realm.roles.list();
  assert.equal(page.items.length, 2);
  assert.equal(page.items[1]!.name, "salesman");
  assert.equal(page.next_cursor, null);
  assert.equal(page.total, 2);
});

test("roles.list: forwards cursor + limit", async () => {
  const fetch = mkFetch((req) => {
    assert.match(req.url, /cursor=c1/);
    assert.match(req.url, /limit=50/);
    return new Response(JSON.stringify({ items: [], next_cursor: null }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  await realm.roles.list({ cursor: "c1", limit: 50 });
});

test("roles.create: maps displayName + permissions to wire shape", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "POST");
    assert.match(req.url, /\/realms\/r\/roles$/);
    assert.deepEqual(req.body, {
      name: "salesman",
      display_name: "Field Sales",
      permissions: ["bills:read"],
    });
    return new Response(JSON.stringify({
      name: "salesman", display_name: "Field Sales",
      permissions: ["bills:read"], is_system: false,
      created_at: 1, updated_at: 1,
    }), { status: 201, headers: { "content-type": "application/json" } });
  });
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const r = await realm.roles.create({ name: "salesman", displayName: "Field Sales", permissions: ["bills:read"] });
  assert.equal(r.name, "salesman");
  assert.equal(r.is_system, false);
});

test("roles.update: sends only provided fields", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "PATCH");
    assert.match(req.url, /\/realms\/r\/roles\/salesman$/);
    assert.deepEqual(req.body, { permissions: ["bills:read", "orders:all"] });
    return new Response(JSON.stringify({
      name: "salesman", permissions: ["bills:read", "orders:all"],
      is_system: false, created_at: 1, updated_at: 2,
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const r = await realm.roles.update("salesman", { permissions: ["bills:read", "orders:all"] });
  assert.deepEqual(r.permissions, ["bills:read", "orders:all"]);
});

test("roles.delete: returns deleted ack", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "DELETE");
    assert.match(req.url, /\/realms\/r\/roles\/old$/);
    return new Response(JSON.stringify({ status: "deleted" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const out = await realm.roles.delete("old");
  assert.equal(out.status, "deleted");
});

test("roles.delete: 409 role_in_use surfaces as RealmError(conflict)", async () => {
  const fetch = mkFetch(() => new Response(JSON.stringify({
    error: { code: "conflict", message: "role still attached to 12 users" },
    role_in_use: true,
  }), { status: 409, headers: { "content-type": "application/json" } }));
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  await assert.rejects(() => realm.roles.delete("salesman"), (e: Error) => {
    return e instanceof RealmError && e.code === "conflict" && e.httpStatus === 409;
  });
});

test("roles.rename: posts {to: <new>}", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "POST");
    assert.match(req.url, /\/realms\/r\/roles\/oldname\/rename$/);
    assert.deepEqual(req.body, { to: "newname" });
    return new Response(JSON.stringify({
      name: "newname", permissions: [], is_system: false,
      created_at: 1, updated_at: 2,
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const r = await realm.roles.rename("oldname", { to: "newname" });
  assert.equal(r.name, "newname");
});
