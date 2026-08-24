import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createRealm } from "./realm.js";
import { RealmError } from "./errors.js";

function platformTokenStub(input: RequestInfo | URL): Response | null {
  const url = typeof input === "string" ? input : input.toString();
  if (url.endsWith("/auth/login")) {
    return new Response(JSON.stringify({ status: "ok", subject_type: "platform", refresh_token: "rtok-platform", access_token: "pt_x", expires_in: 300}), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }
  return null;
}

test("admin.listPlatforms: forwards filters and decodes envelope", async () => {
  let hitUrl = "";
  const fetch: typeof fetch = (async (input: RequestInfo | URL) => {
    const stub = platformTokenStub(input);
    if (stub) return stub;
    hitUrl = typeof input === "string" ? input : input.toString();
    return new Response(JSON.stringify({
      items: [{
        id: "p1", display_name: "Acme", slug: "acme",
        status: "active", signup_mode: "closed",
        domains: ["acme.test"],
        owner: { user_id: "u1", name: "Alice", email: "a@acme.test" },
        tenants_count: 3, users_count: 9,
        last_activity_at: 1700000000, created_at: 1690000000,
      }],
      next_cursor: "n2",
      total: 42,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const out = await realm.admin.listPlatforms({
    q: "ac",
    status: ["active", "suspended"],
    signupMode: ["closed"],
    hasCustomDomain: true,
    createdAfter: 1680000000,
    sort: "created_desc",
    limit: 25,
  });
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0]!.id, "p1");
  assert.equal(out.items[0]!.owner.email, "a@acme.test");
  assert.equal(out.next_cursor, "n2");
  assert.equal(out.total, 42);
  assert.match(hitUrl, /\/admin\/platforms\?/);
  assert.match(hitUrl, /q=ac/);
  assert.match(hitUrl, /status=active%2Csuspended/);
  assert.match(hitUrl, /signup_mode=closed/);
  assert.match(hitUrl, /has_custom_domain=true/);
  assert.match(hitUrl, /created_after=1680000000/);
  assert.match(hitUrl, /sort=created_desc/);
  assert.match(hitUrl, /limit=25/);
});

test("admin.stats: GETs /admin/stats and decodes", async () => {
  const fetch: typeof fetch = (async (input: RequestInfo | URL) => {
    const stub = platformTokenStub(input);
    if (stub) return stub;
    return new Response(JSON.stringify({
      platforms_count: 4, tenants_count: 12, users_count: 88,
      sessions_active: 7, events_24h: 3,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const s = await realm.admin.stats();
  assert.equal(s.platforms_count, 4);
  assert.equal(s.events_24h, 3);
});

test("admin.listEvents: forwards kind+platform_id filters", async () => {
  let hitUrl = "";
  const fetch: typeof fetch = (async (input: RequestInfo | URL) => {
    const stub = platformTokenStub(input);
    if (stub) return stub;
    hitUrl = typeof input === "string" ? input : input.toString();
    return new Response(JSON.stringify({
      items: [{
        id: 1, occurred_at: 1700000000, kind: "platform.created",
        actor_user_id: "u1", actor_label: "alice@acme",
        platform_id: "p1", summary: "alice@acme platform.created p1",
      }],
      next_cursor: null,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const out = await realm.admin.listEvents({
    platformId: "p1",
    kind: ["platform.created", "platform.suspended"],
    since: 1690000000,
    limit: 50,
  });
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0]!.id, 1);
  assert.equal(out.next_cursor, null);
  assert.match(hitUrl, /platform_id=p1/);
  assert.match(hitUrl, /kind=platform.created%2Cplatform.suspended/);
  assert.match(hitUrl, /since=1690000000/);
});

test("admin.search: q + limit", async () => {
  let hitUrl = "";
  const fetch: typeof fetch = (async (input: RequestInfo | URL) => {
    const stub = platformTokenStub(input);
    if (stub) return stub;
    hitUrl = typeof input === "string" ? input : input.toString();
    return new Response(JSON.stringify({
      items: [
        { type: "platform", id: "p1", label: "Acme", sublabel: "acme" },
        { type: "tenant", id: "t1", label: "Acme Default", platform_id: "p1" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const out = await realm.admin.search("ac", 10);
  assert.equal(out.items.length, 2);
  assert.equal(out.items[0]!.type, "platform");
  assert.equal(out.items[1]!.platform_id, "p1");
  assert.match(hitUrl, /q=ac/);
  assert.match(hitUrl, /limit=10/);
});

test("admin.stats: surfaces 403 forbidden envelope as RealmError(forbidden)", async () => {
  const fetch: typeof fetch = (async (input: RequestInfo | URL) => {
    const stub = platformTokenStub(input);
    if (stub) return stub;
    return new Response(JSON.stringify({
      error: { code: "forbidden", message: "base-realm staff required" },
    }), { status: 403, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  await assert.rejects(() => realm.admin.stats(), (e: Error) => {
    return e instanceof RealmError && e.code === "forbidden";
  });
});

test("admin.getPlatform: GETs /admin/platforms/{id} and decodes the fleet row", async () => {
  let hitUrl = "";
  let hitMethod = "";
  let calls = 0;
  const fetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const stub = platformTokenStub(input);
    if (stub) return stub;
    calls++;
    hitUrl = typeof input === "string" ? input : input.toString();
    hitMethod = init?.method ?? "GET";
    return new Response(JSON.stringify({
      id: "p1", display_name: "Acme", slug: "acme",
      status: "active", signup_mode: "closed",
      domains: ["acme.test"],
      owner: { user_id: "u1", name: "Alice", email: "a@acme.test" },
      tenants_count: 3, users_count: 9,
      last_activity_at: 1700000000, created_at: 1690000000,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const out = await realm.admin.getPlatform("p1");

  // The row is the SAME AdminPlatformSummary the list returns — single-sourced
  // server-side through one store query and one serializer, so the detail
  // screen and the fleet table cannot disagree about a platform.
  assert.equal(out.id, "p1");
  assert.equal(out.display_name, "Acme");
  assert.equal(out.owner.email, "a@acme.test");
  assert.equal(out.tenants_count, 3);
  assert.equal(out.last_activity_at, 1700000000);

  assert.equal(hitMethod, "GET");
  assert.match(hitUrl, /\/admin\/platforms\/p1$/);
  // No query string: this is the by-id read, not a filtered list.
  assert.ok(!hitUrl.includes("?"), `expected no query string, got ${hitUrl}`);
  // ONE call. The screen this backs previously paged the list up to 20 times;
  // a wrapper that fans out would reintroduce exactly that.
  assert.equal(calls, 1);
});

test("admin.getPlatform: percent-encodes the id into the path", async () => {
  let hitUrl = "";
  const fetch: typeof fetch = (async (input: RequestInfo | URL) => {
    const stub = platformTokenStub(input);
    if (stub) return stub;
    hitUrl = typeof input === "string" ? input : input.toString();
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  await realm.admin.getPlatform("a/../b");
  // An unencoded id would escape the /admin/platforms/ prefix and address a
  // different endpoint entirely.
  assert.ok(!hitUrl.includes("a/../b"), `id leaked into the path unencoded: ${hitUrl}`);
  assert.match(hitUrl, /\/admin\/platforms\/a%2F..%2Fb$/);
});

test("admin.getPlatform: a 404 stays platform_not_found, never a forbidden flavour", async () => {
  const fetch: typeof fetch = (async (input: RequestInfo | URL) => {
    const stub = platformTokenStub(input);
    if (stub) return stub;
    return new Response(JSON.stringify({
      error: { code: "platform_not_found", message: "platform not found" },
    }), { status: 404, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  // The issuer returns an IDENTICAL 404 for an id that was never issued and for
  // a platform the caller may not see (issuer DECISIONS.md 2026-08-06). That
  // indistinguishability is the security property: a distinct refusal would
  // confirm the id is live. The wrapper must not re-label it as a permission
  // error, which is what a caller would reach for to render "you don't have
  // access to this platform" — and that string IS the oracle.
  await assert.rejects(() => realm.admin.getPlatform("nope"), (e: Error) => {
    if (!(e instanceof RealmError)) return false;
    // `platform_not_found` is REGISTERED as of ts 0.38.0 / go 0.46.0 /
    // java 0.36.0, so it now survives to `error.code` instead of falling back
    // to statusToCode(404). This assertion moved with it — it is the visible
    // half of that behaviour change, and the reason the release is flagged
    // BREAKING despite being purely additive to the union.
    assert.equal(e.code, "platform_not_found");
    assert.equal(e.httpStatus, 404);
    assert.notEqual(e.code, "forbidden");
    assert.notEqual(e.code, "unauthorized");
    return true;
  });
});
