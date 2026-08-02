/**
 * `realm.withUserToken` — the on-behalf-of mode on the TYPED surface
 * (SPEC §4 verified on-behalf-of; ADR-056). `me.test.ts` covers the per-call `userToken` option on
 * `realm.me.*`; these tests cover the part a partner BFF actually needs, where
 * the header must ride on `tenants.list()`, `roles.list()` and every other
 * typed method without a per-call argument.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createRealm } from "./realm.js";

interface Captured {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Header names EXACTLY as sent — lower-casing them would hide a duplicate. */
  rawKeys: string[];
}

/** Serves the platform-token bootstrap, then defers to `handler`. */
function mkFetch(handler: (req: Captured) => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url.endsWith("/auth/login")) {
      return new Response(JSON.stringify({
        status: "ok", subject_type: "platform", refresh_token: "rtok", access_token: "pt_x", expires_in: 300,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const raw = (init?.headers ?? {}) as Record<string, string>;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = v;
    return handler({ method, url, headers, rawKeys: Object.keys(raw) });
  }) as typeof fetch;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status, headers: { "content-type": "application/json" },
  });
}

function realmWith(fetch: typeof fetch) {
  return createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
}

test("withUserToken: a TYPED call carries X-User-Token beside the platform bearer", async () => {
  let seen: Captured | undefined;
  const realm = realmWith(mkFetch((req) => {
    seen = req;
    return json({ items: [], next_cursor: null });
  }));

  await realm.withUserToken("verified-jwt").tenants.list().page();

  assert.match(seen!.url, /\/tenants(\?|$)/);
  // Additive, not a replacement: the realm's platform token stays the wire
  // bearer and the verified user JWT names the caller. A bare user id is not
  // an identity (issuer v0.66.0), so this header is the whole assertion.
  assert.equal(seen?.headers["authorization"], "Bearer pt_x");
  assert.equal(seen?.headers["x-user-token"], "verified-jwt");
});

test("withUserToken: the parent realm keeps no user identity", async () => {
  const seen: Captured[] = [];
  const realm = realmWith(mkFetch((req) => {
    seen.push(req);
    return json({ items: [], next_cursor: null });
  }));

  const asUser = realm.withUserToken("verified-jwt");
  await asUser.tenants.list().page();
  await realm.tenants.list().page();

  // Derivation, not mutation — the long-lived handle must never inherit a
  // request-scoped identity, or one request's user leaks into the next.
  assert.equal(seen[0]?.headers["x-user-token"], "verified-jwt");
  assert.equal(seen[1]?.headers["x-user-token"], undefined);
});

test("withUserToken: derived handles do not leak into each other", async () => {
  const seen: Captured[] = [];
  const realm = realmWith(mkFetch((req) => {
    seen.push(req);
    return json({ items: [], next_cursor: null });
  }));

  const a = realm.withUserToken("jwt-a");
  const b = a.withUserToken("jwt-b");
  await a.tenants.list().page();
  await b.tenants.list().page();

  assert.equal(seen[0]?.headers["x-user-token"], "jwt-a");
  assert.equal(seen[1]?.headers["x-user-token"], "jwt-b");
});

test("withUserToken: a per-call user token overrides, and never duplicates", async () => {
  let seen: Captured | undefined;
  const realm = realmWith(mkFetch((req) => {
    seen = req;
    return json({ tenant_id: "t1", status: "chosen", released: 0 });
  }));

  await realm.withUserToken("client-jwt").me.chooseTenant({
    tenantId: "t1",
    userToken: "per-call-jwt",
  });

  // `me` sends the header as "X-User-Token"; the client sets "x-user-token".
  // Header names are case-INSENSITIVE, so a naive merge would send BOTH keys
  // and fetch would join them ("client-jwt, per-call-jwt") — the issuer would
  // then reject a token it could not parse. Assert on the raw key list, not
  // the folded map, or the duplicate hides behind the last writer.
  const userTokenKeys = seen!.rawKeys.filter((k) => k.toLowerCase() === "x-user-token");
  assert.deepEqual(userTokenKeys, ["x-user-token"]);
  assert.equal(seen?.headers["x-user-token"], "per-call-jwt");
});
