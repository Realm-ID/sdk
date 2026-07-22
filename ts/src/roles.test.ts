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
    if (url.endsWith("/auth/login")) {
      return new Response(JSON.stringify({ status: "ok", subject_type: "platform", refresh_token: "rtok-platform", access_token: "pt_x", expires_in: 300}), {
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
    assert.match(req.url, /\/platforms\/r\/roles/);
    return new Response(JSON.stringify({
      items: [
        { id: "role-owner", name: "owner", permissions: [], is_system: true, created_at: 1, updated_at: 1 },
        { id: "role-salesman", name: "salesman", display_name: "Field Sales", permissions: ["bills:read"],
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
    assert.match(req.url, /\/platforms\/r\/roles$/);
    assert.deepEqual(req.body, {
      name: "salesman",
      display_name: "Field Sales",
      permissions: ["bills:read"],
    });
    return new Response(JSON.stringify({
      name: "salesman", display_name: "Field Sales",
      id: "role-salesman",
      permissions: ["bills:read"], is_system: false,
      created_at: 1, updated_at: 1,
    }), { status: 201, headers: { "content-type": "application/json" } });
  });
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const r = await realm.roles.create({ name: "salesman", displayName: "Field Sales", permissions: ["bills:read"] });
  assert.equal(r.name, "salesman");
  assert.equal(r.is_system, false);
});

test("roles.create: forwards requiredMfaMethods (ADR-075)", async () => {
  const fetch = mkFetch((req) => {
    assert.deepEqual(req.body, {
      name: "cashier",
      display_name: "Cashier",
      required_mfa_methods: ["otp"],
    });
    return new Response(JSON.stringify({
      id: "role-cashier", name: "cashier", display_name: "Cashier",
      permissions: [], required_mfa_methods: ["otp"],
      is_system: false, created_at: 1, updated_at: 1,
    }), { status: 201, headers: { "content-type": "application/json" } });
  });
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const r = await realm.roles.create({ name: "cashier", displayName: "Cashier", requiredMfaMethods: ["otp"] });
  assert.deepEqual(r.required_mfa_methods, ["otp"]);
});

test("roles.update: sends only provided fields", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "PATCH");
    assert.match(req.url, /\/platforms\/r\/roles\/role-salesman$/);
    assert.deepEqual(req.body, { permissions: ["bills:read", "orders:all"] });
    return new Response(JSON.stringify({
      id: "role-salesman", name: "salesman", permissions: ["bills:read", "orders:all"],
      is_system: false, created_at: 1, updated_at: 2,
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const r = await realm.roles.update("role-salesman", { permissions: ["bills:read", "orders:all"] });
  assert.deepEqual(r.permissions, ["bills:read", "orders:all"]);
});

test("roles.delete: returns deleted ack", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "DELETE");
    assert.match(req.url, /\/platforms\/r\/roles\/role-old$/);
    return new Response(JSON.stringify({ status: "deleted" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const out = await realm.roles.delete("role-old");
  assert.equal(out.status, "deleted");
});

test("roles.delete: 409 role_in_use surfaces as RealmError(conflict)", async () => {
  const fetch = mkFetch(() => new Response(JSON.stringify({
    error: { code: "conflict", message: "role still attached to 12 users" },
    role_in_use: true,
  }), { status: 409, headers: { "content-type": "application/json" } }));
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  await assert.rejects(() => realm.roles.delete("role-salesman"), (e: Error) => {
    return e instanceof RealmError && e.code === "conflict" && e.httpStatus === 409;
  });
});

test("roles.list: forwards include_system when requested", async () => {
  const fetch = mkFetch((req) => {
    assert.match(req.url, /include_system=true/);
    return new Response(JSON.stringify({ items: [], next_cursor: null }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  await realm.roles.list({ includeSystem: true });
});

test("roles.disable: POSTs …/disable and surfaces disabled fields", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "POST");
    assert.match(req.url, /\/platforms\/r\/roles\/role-salesman\/disable$/);
    return new Response(JSON.stringify({
      id: "role-salesman", name: "salesman", permissions: [], is_system: false,
      disabled: true, disabled_at: 42, created_at: 1, updated_at: 2,
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const r = await realm.roles.disable("role-salesman");
  assert.equal(r.disabled, true);
  assert.equal(r.disabled_at, 42);
});

test("roles.enable: POSTs …/enable", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "POST");
    assert.match(req.url, /\/platforms\/r\/roles\/role-salesman\/enable$/);
    return new Response(JSON.stringify({
      id: "role-salesman", name: "salesman", permissions: [], is_system: false,
      disabled: false, created_at: 1, updated_at: 3,
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const r = await realm.roles.enable("role-salesman");
  assert.equal(r.disabled, false);
});

test("roles.disable: 400 last_active_role surfaces as RealmError", async () => {
  const fetch = mkFetch(() => new Response(JSON.stringify({
    error: { code: "bad_request", message: "a realm must keep at least one active role besides owner" },
  }), { status: 400, headers: { "content-type": "application/json" } }));
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  await assert.rejects(() => realm.roles.disable("role-last"), (e: Error) => {
    return e instanceof RealmError && e.httpStatus === 400;
  });
});

test("roles.rename: posts {to: <new>}", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "POST");
    assert.match(req.url, /\/platforms\/r\/roles\/role-oldname\/rename$/);
    assert.deepEqual(req.body, { to: "newname" });
    return new Response(JSON.stringify({
      id: "role-oldname", name: "newname", permissions: [], is_system: false,
      created_at: 1, updated_at: 2,
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const r = await realm.roles.rename("role-oldname", { to: "newname" });
  assert.equal(r.name, "newname");
});

test("roles.listPermissions: returns the ADR-074 catalog", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "GET");
    assert.match(req.url, /\/platforms\/r\/permissions/);
    return new Response(JSON.stringify({
      permissions: [
        { key: "users:read", resource: "users", action: "read", label: "View users" },
        { key: "users:manage", resource: "users", action: "manage", label: "Manage users" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const perms = await realm.roles.listPermissions();
  assert.equal(perms.length, 2);
  assert.equal(perms[0]!.key, "users:read");
  assert.equal(perms[1]!.resource, "users");
});

// ADR-081 principal typing + ADR-076 WP4 invitation scope: both are role
// fields the server has shipped for releases without an SDK type, so this
// pins the round trip in both directions.
test("roles.create: forwards assignableTo + canInviteRoles (ADR-081 / ADR-076 WP4)", async () => {
  const fetch = mkFetch((req) => {
    assert.deepEqual(req.body, {
      name: "bot",
      display_name: "Bot",
      can_invite_roles: ["member"],
      assignable_to: ["service"],
    });
    return new Response(JSON.stringify({
      id: "role-bot", name: "bot", display_name: "Bot",
      permissions: [], required_mfa_methods: [],
      can_invite_roles: ["member"], assignable_to: ["service"],
      is_system: false, created_at: 1, updated_at: 1,
    }), { status: 201, headers: { "content-type": "application/json" } });
  });
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const r = await realm.roles.create({
    name: "bot", displayName: "Bot", assignableTo: ["service"], canInviteRoles: ["member"],
  });
  assert.deepEqual(r.assignable_to, ["service"]);
  assert.deepEqual(r.can_invite_roles, ["member"]);
  assert.equal(r.migrated_holders, undefined);
});

// A PATCH that narrows assignable_to away from humans migrates the existing
// human holders server-side (ADR-081 §2.5) and reports how many moved, and to
// where. Absent on every other response — including this one's siblings.
test("roles.update: sends assignableTo and surfaces the §2.5 holder migration", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "PATCH");
    assert.deepEqual(req.body, { assignable_to: ["service"] });
    return new Response(JSON.stringify({
      id: "role-bot", name: "bot", permissions: [], required_mfa_methods: [],
      can_invite_roles: [], assignable_to: ["service"],
      migrated_holders: 12, migrated_holders_to: "member",
      is_system: false, created_at: 1, updated_at: 2,
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const r = await realm.roles.update("role-bot", { assignableTo: ["service"] });
  assert.equal(r.migrated_holders, 12);
  assert.equal(r.migrated_holders_to, "member");
});
