import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createRealm } from "./realm.js";
import { RealmError } from "./errors.js";

interface Captured {
  method: string;
  url: string;
  body?: unknown;
  headers: Record<string, string>;
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
    let body: unknown;
    if (typeof init?.body === "string" && init.body.length > 0) {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    return handler({ method, url, body, headers });
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

test("me.chooseTenant: posts the KEPT tenant and decodes released", async () => {
  let seen: Captured | undefined;
  const realm = realmWith(mkFetch((req) => {
    seen = req;
    return json({ tenant_id: "t-keep", status: "chosen", released: 2 });
  }));
  const out = await realm.me.chooseTenant({ tenantId: "t-keep", userBearer: "user-jwt" });
  assert.equal(seen?.method, "POST");
  assert.match(seen!.url, /\/me\/tenant-choice$/);
  assert.deepEqual(seen?.body, { tenant_id: "t-keep" });
  // Direct mode: the user's own JWT is the wire bearer.
  assert.equal(seen?.headers["authorization"], "Bearer user-jwt");
  assert.deepEqual(out, { tenantId: "t-keep", status: "chosen", released: 2 });
});

test("me: BFF mode sends X-User-Token beside the platform bearer", async () => {
  let seen: Captured | undefined;
  const realm = realmWith(mkFetch((req) => {
    seen = req;
    return json({ tenant_id: "t1", status: "chosen", released: 1 });
  }));
  await realm.me.chooseTenant({ tenantId: "t1", userToken: "verified-jwt" });
  // The platform token stays the bearer; the verified user JWT is additive.
  // A bare user id is not an identity (issuer v0.66.0), so this header is the
  // only thing naming the caller.
  assert.equal(seen?.headers["authorization"], "Bearer pt_x");
  assert.equal(seen?.headers["x-user-token"], "verified-jwt");
});

test("me.rejectInvitation / me.leave: own routes, no body, escaped tenant id", async () => {
  const hits: string[] = [];
  const realm = realmWith(mkFetch((req) => {
    hits.push(req.url);
    assert.equal(req.body, undefined, "these routes take no body");
    return json({ tenant_id: "t1", status: req.url.includes("reject") ? "rejected" : "left" });
  }));
  const rej = await realm.me.rejectInvitation({ tenantId: "t one", userBearer: "u" });
  const left = await realm.me.leave({ tenantId: "t1", userBearer: "u" });
  assert.equal(rej.status, "rejected");
  assert.equal(left.status, "left");
  // A tenant id is a path SEGMENT and must be escaped, not interpolated raw.
  assert.match(hits[0]!, /\/me\/invitations\/t%20one\/reject$/);
  assert.match(hits[1]!, /\/me\/memberships\/t1\/leave$/);
});

test("me.chooseTenant: owner_cannot_be_revoked keeps its specific code", async () => {
  const realm = realmWith(mkFetch(() => json({
    error: "transfer ownership first", code: "owner_cannot_be_revoked",
  }, 409)));
  await assert.rejects(
    () => realm.me.chooseTenant({ tenantId: "t1", userBearer: "u" }),
    (err: unknown) => {
      assert.ok(err instanceof RealmError);
      // Must NOT collapse into the generic 409 `conflict` — the remedy
      // (transfer ownership) is specific to this code.
      assert.equal(err.code, "owner_cannot_be_revoked");
      assert.equal(err.httpStatus, 409);
      return true;
    },
  );
});

test("auth.login: decodes the ADR-092 picker alongside real tokens", async () => {
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    if (url.endsWith("/auth/login") && body.grant_type === "platform_api_key") {
      return json({ subject_type: "platform", access_token: "pt_x", refresh_token: "rt", expires_in: 300 });
    }
    return json({
      access_token: "atok", refresh_token: "rtok", expires_in: 900,
      user: { id: "u1" }, tenants: [],
      tenant_choice_required: true,
      tenant_choices: [
        { tenant_id: "t1", display_name: "Acme", is_owner: false },
        { tenant_id: "t2", display_name: "Mine", is_owner: true },
      ],
    });
  }) as typeof fetch;
  const realm = realmWith(fetch);
  const out = await realm.auth.login({ method: "google", providerToken: "tok" });
  // The picker is a prompt, not an auth failure: the login still mints.
  assert.equal(out.accessToken, "atok");
  assert.equal(out.tenantChoiceRequired, true);
  assert.deepEqual(out.tenantChoices, [
    { tenantId: "t1", displayName: "Acme", isOwner: false },
    // An owned membership cannot be given up — do not offer it.
    { tenantId: "t2", displayName: "Mine", isOwner: true },
  ]);
});

test("auth.login: an ordinary login grows no picker fields", async () => {
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    if (url.endsWith("/auth/login") && body.grant_type === "platform_api_key") {
      return json({ subject_type: "platform", access_token: "pt_x", refresh_token: "rt", expires_in: 300 });
    }
    return json({
      access_token: "atok", refresh_token: "rtok", expires_in: 900,
      user: { id: "u1" }, tenants: [],
    });
  }) as typeof fetch;
  const out = await realmWith(fetch).auth.login({ method: "google", providerToken: "tok" });
  assert.equal(out.tenantChoiceRequired, undefined);
  assert.equal(out.tenantChoices, undefined);
});

test("config.get: pending reconciliation rides BESIDE config, never inside it", async () => {
  const realm = realmWith(mkFetch(() => json({
    id: "r",
    config: { single_tenant_membership: true },
    single_tenant_pending_reconciliation: 3,
  })));
  const out = await realm.config.get();
  assert.equal(out.config["single_tenant_membership"], true);
  assert.equal(out.singleTenantPendingReconciliation, 3);
  assert.equal("single_tenant_pending_reconciliation" in out.config, false);
});

test("config.get: pending reconciliation is undefined when the rule is off", async () => {
  const realm = realmWith(mkFetch(() => json({
    id: "r", config: { single_tenant_membership: false },
  })));
  const out = await realm.config.get();
  // undefined, not 0: "not reported" and "reported as drained" are different
  // facts, and a caller rendering the number must tell them apart.
  assert.equal(out.singleTenantPendingReconciliation, undefined);
});

test("me.acceptInvitation: own route, no body, escaped tenant id", async () => {
  const hits: string[] = [];
  const realm = realmWith(mkFetch((req) => {
    hits.push(req.url);
    assert.equal(req.body, undefined, "this route takes no body");
    return json({ tenant_id: "t one", status: "accepted" });
  }));
  const acc = await realm.me.acceptInvitation({ tenantId: "t one", userBearer: "u" });
  assert.equal(acc.status, "accepted");
  // The route is /accept, NOT /reject with a flag: the two are separate issuer
  // endpoints (ADR-095 D5), and pointing accept at reject's path would decline
  // the invitation it was asked to take. A tenant id is a path SEGMENT and must
  // be escaped, not interpolated raw.
  assert.match(hits[0]!, /\/me\/invitations\/t%20one\/accept$/);
});

test("me.acceptInvitation: not_pending keeps its specific code", async () => {
  const realm = realmWith(mkFetch(() => json({
    error: "invitation already answered", code: "not_pending",
  }, 409)));
  await assert.rejects(
    () => realm.me.acceptInvitation({ tenantId: "t1", userBearer: "u" }),
    (err: unknown) => {
      assert.ok(err instanceof RealmError);
      // Must NOT collapse into the generic 409 `conflict`: `not_pending`
      // (already answered) and `not_invited` (already a member) have different
      // remedies, and only the code tells them apart.
      assert.equal(err.code, "not_pending");
      assert.equal(err.httpStatus, 409);
      return true;
    },
  );
});
