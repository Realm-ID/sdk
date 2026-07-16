import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createRealm } from "./realm.js";

function loginOr(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/auth/login")) {
      return new Response(JSON.stringify({ status: "ok", subject_type: "platform", refresh_token: "rtok-platform", access_token: "pt_x", expires_in: 300 }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return handler(url, init);
  }) as typeof fetch;
}

test("federationBindings.list: pages the platform bindings", async () => {
  let hitUrl = "";
  const fetch = loginOr((url) => {
    hitUrl = url;
    return new Response(JSON.stringify({
      items: [{ id: "fb1", issuer: "https://token.actions.githubusercontent.com", status: "active", match_claims: { repository: "acme/billing" } }],
      next_cursor: null,
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const realm = createRealm({ realmId: "r-1", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const p = await realm.federationBindings.list().page();
  assert.match(hitUrl, /\/platforms\/r-1\/federation-bindings/);
  assert.equal(p.items[0]!.id, "fb1");
  assert.equal(p.items[0]!.match_claims.repository, "acme/billing");
});

test("federationBindings.create: POSTs snake_case body and decodes", async () => {
  let hitMethod = "";
  let hitBody: Record<string, unknown> = {};
  const fetch = loginOr((_url, init) => {
    if (init?.method) hitMethod = init.method;
    if (init?.body) hitBody = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ id: "fb2", platform_id: "r-1", issuer: "https://token.actions.githubusercontent.com", audience: "ri-const", status: "active", mapped_role: "platform_api" }),
      { status: 201, headers: { "content-type": "application/json" } });
  });
  const realm = createRealm({ realmId: "r-1", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const fb = await realm.federationBindings.create({
    issuer: "https://token.actions.githubusercontent.com",
    matchClaims: { repository: "acme/billing" },
    mappedRole: "platform_api",
    scope: ["read"],
  });
  assert.equal(hitMethod, "POST");
  assert.equal(fb.id, "fb2");
  assert.equal(fb.audience, "ri-const");
  assert.deepEqual(hitBody.match_claims, { repository: "acme/billing" });
  assert.equal(hitBody.mapped_role, "platform_api");
  assert.deepEqual(hitBody.scope, ["read"]);
});

test("federationBindings.revoke: DELETEs the binding by id", async () => {
  let hitUrl = "";
  let hitMethod = "";
  const fetch = loginOr((url, init) => {
    hitUrl = url;
    if (init?.method) hitMethod = init.method;
    return new Response(JSON.stringify({ status: "revoked", id: "fb2" }),
      { status: 200, headers: { "content-type": "application/json" } });
  });
  const realm = createRealm({ realmId: "r-1", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const res = await realm.federationBindings.revoke("fb2");
  assert.equal(hitMethod, "DELETE");
  assert.match(hitUrl, /\/platforms\/r-1\/federation-bindings\/fb2$/);
  assert.equal(res.status, "revoked");
  assert.equal(res.id, "fb2");
});
