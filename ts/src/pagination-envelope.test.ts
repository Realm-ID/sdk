/**
 * The pagination envelope must survive a ROUND TRIP, and every list method must
 * hand it to the caller.
 *
 * A decode-only assertion ("the field arrived") passes whether or not the field
 * is carried onward. That is not hypothetical: `go/v0.53.0` silently deleted
 * `credential_methods` from discovery because the BFF decoded an SDK type and
 * RE-SERIALISED it, and every layer's own suite was green because nothing
 * spanned the round trip.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createRealm } from "./realm.js";
import { RealmError } from "./errors.js";
import { readPage, writePage, type Page } from "./pagination.js";

interface Captured { method: string; url: string; body?: unknown }

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

test("page envelope survives decode → re-encode with every wire key intact", () => {
  const wire = { items: [{ id: "a" }], next_cursor: "cur-2", has_more: true, total: 97 };
  const page = readPage<{ id: string }>(wire);
  assert.equal(page.nextCursor, "cur-2");
  assert.equal(page.hasMore, true);
  assert.equal(page.total, 97);

  const back = writePage(page);
  assert.deepEqual(back, wire, "re-encoded envelope lost a field on the way OUT");
});

test("has_more:false round-trips as an explicit false, not an absent key", () => {
  const page = readPage<{ id: string }>({ items: [], next_cursor: null, has_more: false });
  assert.equal(page.hasMore, false);
  const back = writePage(page) as Record<string, unknown>;
  assert.ok("has_more" in back, "re-encoded envelope dropped has_more entirely");
  assert.equal(back["has_more"], false);
  assert.equal(back["next_cursor"], null);
});

test("an absent has_more is derived from next_cursor, never read as false", () => {
  assert.equal(readPage({ items: [], next_cursor: "c" }).hasMore, true);
  assert.equal(readPage({ items: [], next_cursor: null }).hasMore, false);
});

// --- the four list methods that used to discard the envelope ----------------

function pagedFetch(pathRe: RegExp, first: unknown, second: unknown): typeof fetch {
  return mkFetch((req) => {
    assert.match(req.url, pathRe);
    const body = req.url.includes("cursor=cur-2") ? second : first;
    return new Response(JSON.stringify(body), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
}

const p1 = (item: unknown) => ({ items: [item], next_cursor: "cur-2", has_more: true, total: 3 });
const p2 = (item: unknown) => ({ items: [item], next_cursor: null, has_more: false, total: 3 });

test("sources.list exposes the envelope and walks every page", async () => {
  const fetch = pagedFetch(/\/sources/,
    p1({ id: "s1", platform_id: "r", type: "web", label: "one", allowed_methods: [], enabled: true, created_at: 1 }),
    p2({ id: "s2", platform_id: "r", type: "web", label: "two", allowed_methods: [], enabled: true, created_at: 2 }));
  const realm = createRealm({ ...cfg, fetch });
  const list = realm.sources.list();
  const page = await list.page();
  assert.equal(page.nextCursor, "cur-2");
  assert.equal(page.hasMore, true, "envelope discarded — caller cannot detect truncation");
  assert.equal(page.total, 3);
  const ids: string[] = [];
  for await (const s of list) ids.push(s.id);
  assert.deepEqual(ids, ["s1", "s2"], "pager stopped at page one");
});

test("serviceAccounts.list exposes the envelope and walks every page", async () => {
  const fetch = pagedFetch(/\/tenants\/t1\/service-accounts/,
    p1({ id: "sa1", handle: "a@x.test", role: "member", status: "active", kind: "service" }),
    p2({ id: "sa2", handle: "b@x.test", role: "member", status: "active", kind: "service" }));
  const realm = createRealm({ ...cfg, fetch });
  const list = realm.serviceAccounts.list("t1");
  const page = await list.page({ limit: 1 });
  assert.equal(page.hasMore, true, "envelope discarded");
  const ids: string[] = [];
  for await (const a of list) ids.push(a.id);
  assert.deepEqual(ids, ["sa1", "sa2"]);
});

test("userApiKeys.list exposes the envelope and walks every page", async () => {
  const fetch = pagedFetch(/\/tenants\/t1\/users\/u1\/user-api-keys/,
    p1({ id: "k1", prefix: "uk_live_a", label: "one" }),
    p2({ id: "k2", prefix: "uk_live_b", label: "two" }));
  const realm = createRealm({ ...cfg, fetch });
  const list = realm.userApiKeys.list("t1", "u1");
  const page = await list.page();
  assert.equal(page.hasMore, true, "envelope discarded");
  const ids: string[] = [];
  for await (const k of list) ids.push(k.id);
  assert.deepEqual(ids, ["k1", "k2"]);
});

test("apiKeys.list exposes the envelope and walks every page", async () => {
  const fetch = pagedFetch(/\/platforms\/r\/api-keys/,
    p1({ id: "ak1", prefix: "rk_live_a" }),
    p2({ id: "ak2", prefix: "rk_live_b" }));
  const realm = createRealm({ ...cfg, fetch });
  const list = realm.apiKeys.list();
  const page = await list.page();
  assert.equal(page.hasMore, true, "envelope discarded");
  const ids: string[] = [];
  for await (const k of list) ids.push(k.id);
  assert.deepEqual(ids, ["ak1", "ak2"]);
});

test("the pager stops on has_more:false even with a non-empty next_cursor", async () => {
  let calls = 0;
  const fetch = mkFetch(() => {
    calls++;
    return new Response(JSON.stringify({
      items: [{ id: "s1", platform_id: "r", type: "web", label: "one", allowed_methods: [], enabled: true, created_at: 1 }],
      next_cursor: "cur-9", has_more: false,
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const realm = createRealm({ ...cfg, fetch });
  let n = 0;
  for await (const _ of realm.sources.list()) {
    if (++n > 5) throw new Error("pager did not terminate on has_more:false");
  }
  assert.equal(calls, 1, "has_more:false is the terminator, not next_cursor");
});

// --- the serialised query string, not the intent of the code ----------------
//
// The issuer now answers `400 invalid_limit` to `limit=0` and
// `400 invalid_cursor` to a malformed cursor, where both were previously
// absorbed into the defaults. So an UNSET limit must be absent from the URL,
// not sent as `limit=0` — otherwise every list call in the SDK 400s against a
// real server while passing every unit test. This asserts the raw URL for that
// reason: a value-level assertion cannot see it.

test("an unset limit and cursor are OMITTED from the query string", async () => {
  const urls: string[] = [];
  const fetch = mkFetch((req) => {
    urls.push(req.url);
    return new Response(JSON.stringify({ items: [], next_cursor: null, has_more: false }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  const realm = createRealm({ ...cfg, fetch });

  await realm.sources.list().page();
  await realm.serviceAccounts.list("t1").page();
  await realm.userApiKeys.list("t1", "u1").page();
  await realm.apiKeys.list().page();

  assert.equal(urls.length, 4, "all four paged lists must have been called");
  for (const u of urls) {
    const q = new URL(u).searchParams;
    assert.ok(!q.has("limit"), `${u} sends limit — an unset limit must be absent (400 invalid_limit)`);
    assert.ok(!q.has("cursor"), `${u} sends cursor — an unset cursor must be absent (400 invalid_cursor)`);
  }
  // The sources call carries its own required param, so the assertions above
  // are not passing merely because no query was built at all.
  assert.equal(new URL(urls[0]!).searchParams.get("platform_id"), "r");
});

test("a set limit and cursor ARE sent — the omission is a guard, not a dropped field", async () => {
  let seen = "";
  const fetch = mkFetch((req) => {
    seen = req.url;
    return new Response(JSON.stringify({ items: [], next_cursor: null, has_more: false }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  const realm = createRealm({ ...cfg, fetch });
  await realm.apiKeys.list().page({ cursor: "c1", limit: 25 });
  const q = new URL(seen).searchParams;
  assert.equal(q.get("limit"), "25");
  assert.equal(q.get("cursor"), "c1");
});

// --- pagination input errors reach `code` -----------------------------------

test("a 400 invalid_limit / invalid_cursor surfaces on error.code, not bad_request", async () => {
  for (const code of ["invalid_limit", "invalid_cursor"]) {
    const fetch = mkFetch(() =>
      new Response(JSON.stringify({ error: "bad pagination input", code }), {
        status: 400, headers: { "content-type": "application/json" },
      }));
    const realm = createRealm({ ...cfg, fetch });
    await assert.rejects(
      () => realm.sources.list().page(),
      (e: Error) =>
        e instanceof RealmError && e.code === code
          ? true
          : (() => { throw new Error(`code = ${(e as RealmError).code}, want ${code} — an unregistered code collapses and cannot be branched on`); })(),
    );
  }
});
