import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createRealm } from "./realm.js";

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
      return new Response(
        JSON.stringify({
          status: "ok", subject_type: "platform", refresh_token: "rtok-platform",
          access_token: "pt_x", expires_in: 300,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    let body: unknown;
    if (typeof init?.body === "string" && init.body.length > 0) {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    return handler({ method, url, body });
  }) as typeof fetch;
}

function mkRealm(fetch: typeof fetch) {
  return createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
}

test("roleTemplates.list: sends level and never returns null", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "GET");
    assert.match(req.url, /\/platforms\/r\/role-templates/);
    assert.match(req.url, /level=tenant/);
    // The empty vocabulary arrives as a JSON null — the shape that becomes a
    // null and throws in an iterating caller.
    return new Response(JSON.stringify({ role_templates: null }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  const out = await mkRealm(fetch).roleTemplates.list("tenant");
  assert.deepEqual(out, [], "a null role_templates must normalize to []");
});

test("roleTemplates.create: always sends assignable_to, surfaces realms_stamped", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "POST");
    const body = req.body as Record<string, unknown>;
    assert.equal(body["level"], "tenant");
    assert.equal(body["name"], "reporting");
    // Required server-side. A body that silently omits it is a 400 the caller
    // cannot diagnose from the code alone.
    assert.deepEqual(body["assignable_to"], ["human"]);
    return new Response(
      JSON.stringify({
        role_template: {
          id: "tpl1", level: "tenant", name: "reporting", display_name: "Reporting",
          permissions: ["audit:read"], assignable_to: ["human"],
          is_system: false, optional: false,
        },
        realms_stamped: 7,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  const out = await mkRealm(fetch).roleTemplates.create({
    level: "tenant", name: "reporting", displayName: "Reporting",
    permissions: ["audit:read"], assignableTo: ["human"],
  });
  // The difference between "exists for future realms" and "reached the realms
  // that already exist" — only the second is what ADR-101 promises.
  assert.equal(out.realms_stamped, 7);
  assert.equal(out.role_template.name, "reporting");
});

test("roleTemplates.update: omits unset fields and preserves -1 drift", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "PATCH");
    const body = req.body as Record<string, unknown>;
    // An omitted key must be ABSENT, not null: absent preserves the stored
    // value, a null would be a decision the caller never made.
    for (const k of ["permissions", "assignable_to", "is_system", "optional"]) {
      assert.equal(k in body, false, `${k} must be omitted when unset`);
    }
    assert.equal(body["display_name"], "Reporting v2");
    return new Response(
      JSON.stringify({
        role_template: { id: "tpl1", level: "tenant", name: "reporting", assignable_to: ["human"] },
        drifted_realms: -1,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  const out = await mkRealm(fetch).roleTemplates.update("tpl1", { displayName: "Reporting v2" });
  // -1 is UNKNOWN. Coercing it to 0 would turn "could not count" into "none".
  assert.equal(out.drifted_realms, -1);
});

test("roleTemplates.delete: reports the orphans it creates", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "DELETE");
    assert.match(req.url, /\/role-templates\/tpl1$/);
    return new Response(
      JSON.stringify({ status: "deleted", realms_still_holding: 3 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  const out = await mkRealm(fetch).roleTemplates.delete("tpl1");
  assert.equal(out.realms_still_holding, 3);
});

test("roleTemplates.update: seated principals refuse with role_template_seated (409, recoverable)", async () => {
  const fetch = mkFetch(() =>
    new Response(
      JSON.stringify({
        error: { code: "role_template_seated", message: "principals are seated at this template" },
      }),
      { status: 409, headers: { "content-type": "application/json" } },
    ),
  );
  await assert.rejects(
    () => mkRealm(fetch).roleTemplates.update("tpl1", { displayName: "x" }),
    (err: unknown) => {
      const e = err as { code?: string; details?: { server_code?: string } };
      const code = e.details?.server_code ?? e.code;
      assert.equal(code, "role_template_seated");
      return true;
    },
  );
});

test("roleTemplates.delete: an uncountable seat check refuses with role_template_seat_check_failed (503, unconditional)", async () => {
  const fetch = mkFetch(() =>
    new Response(
      JSON.stringify({
        error: {
          code: "role_template_seat_check_failed",
          message: "seat count could not be taken",
        },
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    ),
  );
  await assert.rejects(
    () => mkRealm(fetch).roleTemplates.delete("tpl1"),
    (err: unknown) => {
      const e = err as { code?: string; details?: { server_code?: string } };
      const code = e.details?.server_code ?? e.code;
      // Unlike role_template_seated, no query parameter rescues this one —
      // the seat count itself could not be taken, not merely non-zero.
      assert.equal(code, "role_template_seat_check_failed");
      return true;
    },
  );
});

test("roleTemplates: a partner realm is refused with role_authoring_retired", async () => {
  const fetch = mkFetch(() =>
    new Response(
      JSON.stringify({ error: { code: "role_authoring_retired", message: "RealmID defines the role set" } }),
      { status: 403, headers: { "content-type": "application/json" } },
    ),
  );
  await assert.rejects(
    () => mkRealm(fetch).roleTemplates.create({ level: "tenant", name: "x", assignableTo: ["human"] }),
    (err: unknown) => {
      // The code must survive from the NESTED envelope level. A reader that
      // checks only the top level is the defect that made role_owner_only
      // arrive as a plain `forbidden`.
      const e = err as { code?: string; details?: { server_code?: string } };
      const code = e.details?.server_code ?? e.code;
      assert.equal(code, "role_authoring_retired");
      return true;
    },
  );
});
