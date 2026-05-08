import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createRealm } from "./realm.js";
import { RealmError } from "./errors.js";

function mkFetch(handler: (url: string) => Response): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/auth/login")) {
      return new Response(JSON.stringify({ status: "ok", subject_type: "platform", refresh_token: "rtok-platform", access_token: "pt_x", expires_in: 300}), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return handler(url);
  }) as typeof fetch;
}

test("tenants.list: pages through cursor", async () => {
  const pages = [
    { items: [{ id: "t1" }, { id: "t2" }], next_cursor: "c2" },
    { items: [{ id: "t3" }], next_cursor: null },
  ];
  let i = 0;
  const fetch = mkFetch((url) => {
    if (i === 0) {
      assert.ok(!url.includes("cursor="), `first request must not carry cursor: ${url}`);
    } else {
      assert.match(url, /cursor=c2/);
    }
    const body = pages[i++]!;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });

  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const seen: string[] = [];
  for await (const t of realm.tenants.list()) {
    seen.push(t.id);
  }
  assert.deepEqual(seen, ["t1", "t2", "t3"]);
});

test("tenants.list: manual page() exposes nextCursor", async () => {
  const fetch = mkFetch(() => new Response(
    JSON.stringify({ items: [{ id: "t1" }], next_cursor: "ck" }),
    { status: 200, headers: { "content-type": "application/json" } },
  ));
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const p = await realm.tenants.list().page({ limit: 50 });
  assert.equal(p.items.length, 1);
  assert.equal(p.nextCursor, "ck");
});

test("tenants.list: rejects unexpected paginated wire shape (SPEC §7)", async () => {
  // Server returns the legacy `{ data, cursor }` envelope. SDK must reject.
  const fetch = mkFetch(() => new Response(
    JSON.stringify({ data: [{ id: "t1" }], cursor: "ck" }),
    { status: 200, headers: { "content-type": "application/json" } },
  ));
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  await assert.rejects(() => realm.tenants.list().page(), (e: Error) => {
    return e instanceof RealmError && e.code === "server_error";
  });
});

test("tenants.create: routes to /platforms/{realmId}/tenants (SPEC §6.1)", async () => {
  let hitUrl = "";
  let hitBody: Record<string, unknown> = {};
  const wrapped: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/auth/login")) {
      return new Response(JSON.stringify({ status: "ok", subject_type: "platform", refresh_token: "rtok-platform", access_token: "pt_x", expires_in: 300}), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    hitUrl = url;
    if (init?.body) hitBody = JSON.parse(init.body as string);
    return new Response(
      JSON.stringify({ id: "t-new", display_name: "Acme" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const realm = createRealm({ realmId: "r-1", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch: wrapped });
  const tnt = await realm.tenants.create({
    displayName: "Acme",
    allowedDomains: ["acme.com"],
    signupMode: "allowlist",
  });
  assert.equal(tnt.id, "t-new");
  assert.match(hitUrl, /\/platforms\/r-1\/tenants$/);
  assert.equal(hitBody.display_name, "Acme");
  assert.deepEqual(hitBody.allowed_domains, ["acme.com"]);
  assert.equal(hitBody.signup_mode, "allowlist");
});

test("tenants.updateUserRole: PATCHes /tenants/{id}/users/{uid}/role", async () => {
  let hitUrl = "";
  let hitMethod = "";
  let hitBody: Record<string, unknown> = {};
  const wrapped: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/auth/login")) {
      return new Response(JSON.stringify({ status: "ok", subject_type: "platform", refresh_token: "rtok-platform", access_token: "pt_x", expires_in: 300}), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    hitUrl = url;
    if (init?.method) hitMethod = init.method;
    if (init?.body) hitBody = JSON.parse(init.body as string);
    return new Response(
      JSON.stringify({ id: "u9", role: "admin", tenant_id: "t1", updated_at: 1700000000 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const realm = createRealm({ realmId: "r-1", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch: wrapped });
  const out = await realm.tenants.updateUserRole("t1", "u9", "admin");
  assert.equal(out.role, "admin");
  assert.equal(out.tenant_id, "t1");
  assert.equal(hitMethod, "PATCH");
  assert.match(hitUrl, /\/tenants\/t1\/users\/u9\/role$/);
  assert.equal(hitBody.role, "admin");
});
