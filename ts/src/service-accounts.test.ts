import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createRealm } from "./realm.js";
import { RealmError } from "./errors.js";

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
      return new Response(JSON.stringify({
        status: "ok", subject_type: "platform", refresh_token: "rtok-platform",
        access_token: "pt_x", expires_in: 300,
      }), { status: 200, headers: { "content-type": "application/json" } });
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

const cfg = { realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test" };

test("serviceAccounts.create: POSTs to the tenant route + maps displayName", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "POST");
    assert.match(req.url, /\/tenants\/t1\/service-accounts$/);
    assert.deepEqual(req.body, { handle: "bot@acme.test", role: "member", display_name: "Bot" });
    // Auth is the platform token (auto-attached), exactly like the Roles client.
    assert.equal(req.authorization, "Bearer pt_x");
    return new Response(JSON.stringify({
      id: "sa-1", handle: "bot@acme.test", role: "member",
      status: "active", kind: "service",
    }), { status: 201, headers: { "content-type": "application/json" } });
  });
  const realm = createRealm({ ...cfg, fetch });
  const out = await realm.serviceAccounts.create("t1", {
    handle: "bot@acme.test", role: "member", displayName: "Bot",
  });
  assert.equal(out.id, "sa-1");
  assert.equal(out.kind, "service");
});

test("serviceAccounts.create: 409 handle_taken surfaces on error.code", async () => {
  const fetch = mkFetch(() => new Response(JSON.stringify({
    error: { code: "handle_taken", message: "handle already in use" },
  }), { status: 409, headers: { "content-type": "application/json" } }));
  const realm = createRealm({ ...cfg, fetch });
  await assert.rejects(
    () => realm.serviceAccounts.create("t1", { handle: "x@y.z" }),
    (e: Error) => e instanceof RealmError && e.code === "handle_taken" && e.httpStatus === 409,
  );
});

test("serviceAccounts.create: 400 invalid_role surfaces on error.code", async () => {
  const fetch = mkFetch(() => new Response(JSON.stringify({
    error: { code: "invalid_role", message: "role may not be owner" },
  }), { status: 400, headers: { "content-type": "application/json" } }));
  const realm = createRealm({ ...cfg, fetch });
  await assert.rejects(
    () => realm.serviceAccounts.create("t1", { handle: "x@y.z", role: "owner" }),
    (e: Error) => e instanceof RealmError && e.code === "invalid_role",
  );
});

test("serviceAccounts.list: returns a page over {items}", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "GET");
    assert.match(req.url, /\/tenants\/t1\/service-accounts$/);
    return new Response(JSON.stringify({
      items: [
        { id: "sa-1", handle: "a@x.test", role: "member", status: "active", kind: "service" },
        { id: "sa-2", handle: "b@x.test", role: "member", status: "suspended", kind: "service" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const realm = createRealm({ ...cfg, fetch });
  const page = await realm.serviceAccounts.list("t1").page();
  assert.equal(page.items.length, 2);
  assert.equal(page.items[1]!.status, "suspended");
  assert.equal(page.hasMore, false);
});

test("serviceAccounts.get: GETs by id", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "GET");
    assert.match(req.url, /\/tenants\/t1\/service-accounts\/sa-1$/);
    return new Response(JSON.stringify({
      id: "sa-1", handle: "a@x.test", role: "member", status: "active", kind: "service",
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const realm = createRealm({ ...cfg, fetch });
  const sa = await realm.serviceAccounts.get("t1", "sa-1");
  assert.equal(sa.id, "sa-1");
});

test("serviceAccounts: lifecycle verbs hit the right routes", async () => {
  const seen = new Set<string>();
  const fetch = mkFetch((req) => {
    const u = new URL(req.url);
    seen.add(`${req.method} ${u.pathname}`);
    if (u.pathname.endsWith("/revoke")) {
      return new Response(JSON.stringify({ status: "ok", revoked_sessions: 2 }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ id: "sa-1", kind: "service", status: "active" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  const realm = createRealm({ ...cfg, fetch });
  await realm.serviceAccounts.suspend("t1", "sa-1");
  await realm.serviceAccounts.unsuspend("t1", "sa-1");
  await realm.serviceAccounts.deactivate("t1", "sa-1");
  await realm.serviceAccounts.resetHandle("t1", "sa-1", "new@acme.test");
  const rev = await realm.serviceAccounts.revoke("t1", "sa-1");
  assert.equal(rev.revoked_sessions, 2);
  for (const want of [
    "POST /tenants/t1/service-accounts/sa-1/suspend",
    "POST /tenants/t1/service-accounts/sa-1/unsuspend",
    "POST /tenants/t1/service-accounts/sa-1/deactivate",
    "POST /tenants/t1/service-accounts/sa-1/reset-handle",
    "POST /tenants/t1/service-accounts/sa-1/revoke",
  ]) {
    assert.ok(seen.has(want), `missing call: ${want}`);
  }
});

test("serviceAccounts.resetHandle: sends {handle}", async () => {
  const fetch = mkFetch((req) => {
    assert.match(req.url, /\/tenants\/t1\/service-accounts\/sa-1\/reset-handle$/);
    assert.deepEqual(req.body, { handle: "new@acme.test" });
    return new Response(JSON.stringify({ id: "sa-1", handle: "new@acme.test", kind: "service" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  const realm = createRealm({ ...cfg, fetch });
  const out = await realm.serviceAccounts.resetHandle("t1", "sa-1", "new@acme.test");
  assert.equal(out.handle, "new@acme.test");
});
