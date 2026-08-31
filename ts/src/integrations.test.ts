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

/**
 * mkFetch distinguishes the platform bootstrap (grant_type=platform_api_key,
 * auto-issued to any /auth/login) from the mint (grant_type=
 * integration_installation), so the mint test can assert the mint response
 * rather than the bootstrap one.
 */
function mkFetch(handler: (req: Captured) => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    let body: unknown;
    if (typeof init?.body === "string" && init.body.length > 0) {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    const auth = init?.headers
      ? (init.headers as Record<string, string>)["authorization"]
      : undefined;
    if (url.endsWith("/auth/login") && (body as { grant_type?: string })?.grant_type === "platform_api_key") {
      return new Response(JSON.stringify({
        status: "ok", subject_type: "platform", refresh_token: "rtok-platform",
        access_token: "pt_x", expires_in: 300,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return handler({ method, url, body, authorization: auth });
  }) as typeof fetch;
}

const cfg = { realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test" };

test("integrations.register: POSTs to the platform route + maps camelCase", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "POST");
    assert.match(req.url, /\/platforms\/r\/integrations$/);
    assert.deepEqual(req.body, { slug: "hiring-motion", display_name: "Hiring Motion" });
    assert.equal(req.authorization, "Bearer pt_x");
    return new Response(JSON.stringify({
      id: "intg-1", realm_id: "r", slug: "hiring-motion", display_name: "Hiring Motion",
      listed: false, disabled: false,
    }), { status: 201, headers: { "content-type": "application/json" } });
  });
  const realm = createRealm({ ...cfg, fetch });
  const out = await realm.integrations.register({ slug: "hiring-motion", displayName: "Hiring Motion" });
  assert.equal(out.id, "intg-1");
  assert.equal(out.slug, "hiring-motion");
});

/**
 * The install body must carry the ADR-101 D7 STATED PERMISSION LIST.
 *
 * This test previously asserted the body was `{integration_id, role_id}`,
 * which is why the SDK shipped broken against the live issuer for as long as
 * it did: the issuer replaced `role_id` with `permissions` and answers
 * `400 permissions_required`, while the test pinned the old shape and stayed
 * green. A test that asserts the implementation protects the bug.
 */
test("integrations.install: POSTs the permission list, and no role_id, to the tenant installations route", async () => {
  let seenBody: Record<string, unknown> = {};
  const fetch = mkFetch((req) => {
    assert.match(req.url, /\/tenants\/t1\/integration-installations$/);
    seenBody = req.body as Record<string, unknown>;
    return new Response(JSON.stringify({
      id: "inst-1", integration_id: "intg-1", permissions: ["users:read"],
      principal_user_id: "u-9", status: "installed",
    }), { status: 201, headers: { "content-type": "application/json" } });
  });
  const realm = createRealm({ ...cfg, fetch });
  const out = await realm.integrations.install("t1", {
    integrationId: "intg-1",
    permissions: ["users:read"],
  });
  // Assert the whole body: checking only that `permissions` is present would
  // still pass if the client also sent the retired `role_id`.
  assert.deepEqual(seenBody, { integration_id: "intg-1", permissions: ["users:read"] });
  assert.equal("role_id" in seenBody, false);
  assert.equal(out.id, "inst-1");
  assert.equal(out.status, "installed");
  assert.deepEqual(out.permissions, ["users:read"]);
});

test("integrations.install: the three ADR-101 permission refusals surface on RealmError.code", async () => {
  for (const [code, status] of [
    ["permissions_required", 400],
    ["unknown_permission", 400],
    ["permissions_exceed_grantor", 403],
  ] as const) {
    const fetch = mkFetch(() =>
      new Response(JSON.stringify({ error: "no", code }),
        { status, headers: { "content-type": "application/json" } }));
    const realm = createRealm({ ...cfg, fetch });
    await assert.rejects(
      () => realm.integrations.install("t1", { integrationId: "intg-1", permissions: ["users:read"] }),
      (e: unknown) => e instanceof RealmError && e.code === code,
      `expected ${code} to reach RealmError.code`,
    );
  }
});

/**
 * RETAINED FOR THE MAPPING ONLY: the issuer has not emitted
 * `role_not_service_typed` since ADR-101 D7, so this asserts the code still
 * resolves for anyone branching on it, NOT that the refusal can still occur.
 */
test("integrations.install: role_not_service_typed still resolves (dead code, kept for compat)", async () => {
  const fetch = mkFetch(() =>
    new Response(JSON.stringify({ error: "no", code: "role_not_service_typed" }),
      { status: 400, headers: { "content-type": "application/json" } }));
  const realm = createRealm({ ...cfg, fetch });
  await assert.rejects(
    () => realm.integrations.install("t1", { integrationId: "intg-1", permissions: ["users:read"] }),
    (e: unknown) => e instanceof RealmError && e.code === "role_not_service_typed",
  );
});

test("integrations.listInstallations: decodes the inbound-access page", async () => {
  const fetch = mkFetch(() =>
    new Response(JSON.stringify({
      items: [{ id: "inst-1", integration_id: "intg-1", permissions: ["users:read", "users:manage"], mint_count: 3 }],
      next_cursor: null,
    }), { status: 200, headers: { "content-type": "application/json" } }));
  const realm = createRealm({ ...cfg, fetch });
  const page = await realm.integrations.listInstallations("t1");
  assert.equal(page.items.length, 1);
  assert.deepEqual(page.items[0]?.permissions, ["users:read", "users:manage"]);
  assert.equal(page.items[0]?.mint_count, 3);
  assert.equal(page.next_cursor, null);
});

test("integrations.uninstall: DELETEs the installation", async () => {
  let seen = "";
  const fetch = mkFetch((req) => {
    seen = `${req.method} ${new URL(req.url).pathname}`;
    return new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const realm = createRealm({ ...cfg, fetch });
  await realm.integrations.uninstall("t1", "inst-1");
  assert.equal(seen, "DELETE /tenants/t1/integration-installations/inst-1");
});

test("integrations.mintToken: sends the raw api key with NO bearer + decodes access-only token", async () => {
  const fetch = mkFetch((req) => {
    // The mint hits /auth/login with grant_type=integration_installation.
    assert.match(req.url, /\/auth\/login$/);
    assert.deepEqual(req.body, {
      grant_type: "integration_installation",
      api_key: "rk_live_src",
      installation_id: "inst-1",
      source_org_id: "org-a",
    });
    // The raw key is the credential — it must NOT ride as a bearer.
    assert.equal(req.authorization, undefined);
    return new Response(JSON.stringify({
      status: "ok", subject_type: "service",
      access_token: "brokered-jwt", expires_in: 600, tenant_id: "t-target", role: "svc",
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const realm = createRealm({ ...cfg, fetch });
  const out = await realm.integrations.mintToken({
    apiKey: "rk_live_src", installationId: "inst-1", sourceOrgId: "org-a",
  });
  assert.equal(out.access_token, "brokered-jwt");
  assert.equal(out.expires_in, 600);
  assert.equal(out.role, "svc");
  // No refresh token in the shape — access-only (ADR-083 §7.5).
  assert.equal((out as Record<string, unknown>)["refresh_token"], undefined);
});

test("integrations.mintToken: key_class_mismatch surfaces on RealmError.code", async () => {
  const fetch = mkFetch(() =>
    new Response(JSON.stringify({ error: "no", code: "key_class_mismatch" }),
      { status: 401, headers: { "content-type": "application/json" } }));
  const realm = createRealm({ ...cfg, fetch });
  await assert.rejects(
    () => realm.integrations.mintToken({ apiKey: "rk_live_svc", installationId: "inst-1", sourceOrgId: "o" }),
    (e: unknown) => e instanceof RealmError && e.code === "key_class_mismatch",
  );
});

test("integrations.disable/enable/remove: hit the source lifecycle verbs", async () => {
  const hits: string[] = [];
  const fetch = mkFetch((req) => {
    hits.push(`${req.method} ${new URL(req.url).pathname}`);
    return new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const realm = createRealm({ ...cfg, fetch });
  await realm.integrations.disable("intg-1");
  await realm.integrations.enable("intg-1");
  await realm.integrations.remove("intg-1");
  assert.deepEqual(hits, [
    "POST /platforms/r/integrations/intg-1/disable",
    "POST /platforms/r/integrations/intg-1/enable",
    "DELETE /platforms/r/integrations/intg-1",
  ]);
});
