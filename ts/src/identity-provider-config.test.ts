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
      return new Response(JSON.stringify({ status: "ok", subject_type: "platform", refresh_token: "rtok-platform", access_token: "pt_x", expires_in: 300 }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    let body: unknown;
    if (typeof init?.body === "string" && init.body.length > 0) {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    return handler({ method, url, body });
  }) as typeof fetch;
}

const REALM = { realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test" } as const;

const SAMPLE = {
  id: "idp-1", entity_type: "realm", entity_id: "r", provider: "google",
  client_type: "web", client_id: "gid", allowed_origins: ["https://app.example"],
  comments: "", enabled: true, created_at: 1, updated_at: 2,
};

test("idp.list: injects platform_id=realmId and normalizes items", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "GET");
    assert.match(req.url, /\/identity-providers\?/);
    assert.match(req.url, /platform_id=r/);
    return new Response(JSON.stringify({ items: [SAMPLE] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  const realm = createRealm({ ...REALM, fetch });
  const page = await realm.identityProviderConfig.list();
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]!.provider, "google");
});

test("idp.list: forwards tenant_id and normalizes absent items to []", async () => {
  const fetch = mkFetch((req) => {
    assert.match(req.url, /platform_id=r/);
    assert.match(req.url, /tenant_id=t9/);
    return new Response(JSON.stringify({}), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  const realm = createRealm({ ...REALM, fetch });
  const page = await realm.identityProviderConfig.list({ tenantId: "t9" });
  assert.deepEqual(page.items, []);
});

test("idp.create: injects platform_id, maps camel->snake, omits unset", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "POST");
    assert.match(req.url, /\/identity-providers$/);
    assert.deepEqual(req.body, {
      platform_id: "r",
      provider: "google",
      client_type: "web",
      client_id: "gid",
      allowed_origins: ["https://app.example"],
    });
    return new Response(JSON.stringify(SAMPLE), {
      status: 201, headers: { "content-type": "application/json" },
    });
  });
  const realm = createRealm({ ...REALM, fetch });
  const out = await realm.identityProviderConfig.create({
    provider: "google", clientType: "web", clientId: "gid",
    allowedOrigins: ["https://app.example"],
  });
  assert.equal(out.id, "idp-1");
});

test("idp.create+update: provider config (Firebase web config) round-trips", async () => {
  const fb = { apiKey: "AIza-test", authDomain: "demo-app.firebaseapp.com", projectId: "demo-app" };

  // create includes config
  let fetch = mkFetch((req) => {
    assert.deepEqual((req.body as Record<string, unknown>)["config"], fb);
    return new Response(JSON.stringify({ ...SAMPLE, provider: "firebase", config: fb }), {
      status: 201, headers: { "content-type": "application/json" },
    });
  });
  let realm = createRealm({ ...REALM, fetch });
  let out = await realm.identityProviderConfig.create({
    provider: "firebase", clientType: "web", clientId: "demo-app",
    allowedOrigins: ["https://app.example.com"], config: fb,
  });
  assert.deepEqual(out.config, fb);

  // patch replaces config wholesale
  fetch = mkFetch((req) => {
    assert.deepEqual(req.body, { config: fb });
    return new Response(JSON.stringify({ ...SAMPLE, config: fb }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  realm = createRealm({ ...REALM, fetch });
  out = await realm.identityProviderConfig.update("idp-1", { config: fb });
  assert.deepEqual(out.config, fb);
});

test("idp.create: 409 provider_exists surfaces as RealmError(conflict)", async () => {
  const fetch = mkFetch(() => new Response(JSON.stringify({
    error: { code: "conflict", message: "provider already configured" },
    provider_exists: true,
  }), { status: 409, headers: { "content-type": "application/json" } }));
  const realm = createRealm({ ...REALM, fetch });
  await assert.rejects(() => realm.identityProviderConfig.create({
    provider: "google", clientType: "ios", clientId: "gid",
  }), (e: Error) => e instanceof RealmError && e.code === "conflict" && e.httpStatus === 409);
});

test("idp.update: sends only provided fields", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "PATCH");
    assert.match(req.url, /\/identity-providers\/idp-1$/);
    assert.deepEqual(req.body, { enabled: false, client_id: "new" });
    return new Response(JSON.stringify({ ...SAMPLE, enabled: false, client_id: "new" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  const realm = createRealm({ ...REALM, fetch });
  const out = await realm.identityProviderConfig.update("idp-1", { enabled: false, clientId: "new" });
  assert.equal(out.enabled, false);
  assert.equal(out.client_id, "new");
});

test("idp.delete: returns deleted ack", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "DELETE");
    assert.match(req.url, /\/identity-providers\/idp-1$/);
    return new Response(JSON.stringify({ status: "deleted" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  const realm = createRealm({ ...REALM, fetch });
  const out = await realm.identityProviderConfig.delete("idp-1");
  assert.equal(out.status, "deleted");
});

test("idp.delete: 404 provider_not_found surfaces as RealmError(not_found)", async () => {
  const fetch = mkFetch(() => new Response(JSON.stringify({
    error: { code: "not_found", message: "provider not found" },
  }), { status: 404, headers: { "content-type": "application/json" } }));
  const realm = createRealm({ ...REALM, fetch });
  await assert.rejects(() => realm.identityProviderConfig.delete("missing"), (e: Error) =>
    e instanceof RealmError && e.code === "not_found" && e.httpStatus === 404);
});
