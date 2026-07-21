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
      return new Response(JSON.stringify({
        status: "ok", subject_type: "platform", refresh_token: "rtok", access_token: "pt_x", expires_in: 300,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    let body: unknown;
    if (typeof init?.body === "string" && init.body.length > 0) {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    return handler({ method, url, body });
  }) as typeof fetch;
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

test("config.get: returns the realm id and the config map with keys intact", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "GET");
    assert.match(req.url, /\/platforms\/r\/config$/);
    return json({
      id: "r",
      config: {
        idle_ttl_seconds: 900,
        mfa_policy: "enforced",
        require_bff_login: true,
        origin_enforcement: "",
        access_token_custom_claim_keys: [],
        refresh_absolute_expiry: {
          mode: "rolling", daily_cutoff_local: "", timezone: "", applies_to_service: false,
        },
      },
    });
  });
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const out = await realm.config.get();
  assert.equal(out.id, "r");
  assert.deepEqual(Object.keys(out.config).sort(), [
    "access_token_custom_claim_keys",
    "idle_ttl_seconds",
    "mfa_policy",
    "origin_enforcement",
    "refresh_absolute_expiry",
    "require_bff_login",
  ]);
  assert.equal(out.config["idle_ttl_seconds"], 900);
  assert.equal(out.config["mfa_policy"], "enforced");
  assert.equal(out.config["require_bff_login"], true);
  // Zero values mean "unset" and must survive as keys, not be dropped.
  assert.equal(out.config["origin_enforcement"], "");
  assert.deepEqual(out.config["access_token_custom_claim_keys"], []);
  assert.deepEqual(out.config["refresh_absolute_expiry"], {
    mode: "rolling", daily_cutoff_local: "", timezone: "", applies_to_service: false,
  });
});

test("config.get: tolerates a bare envelope", async () => {
  const fetch = mkFetch(() => json({}));
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const out = await realm.config.get();
  assert.equal(out.id, "r");
  assert.deepEqual(out.config, {});
});

test("stats.get: decodes the KPI rollup", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "GET");
    assert.match(req.url, /\/platforms\/r\/stats$/);
    return json({
      platform_id: "r",
      generated_at: 1783400000,
      orgs_count: 7,
      users_count: 40,
      sessions_24h: 12,
      mfa_coverage: { covered_users: 8, eligible_users: 40, percent: 20 },
    });
  });
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const out = await realm.stats.get();
  assert.equal(out.platform_id, "r");
  assert.equal(out.generated_at, 1783400000);
  assert.equal(out.orgs_count, 7);
  assert.equal(out.users_count, 40);
  assert.equal(out.sessions_24h, 12);
  assert.equal(out.mfa_coverage.covered_users, 8);
  assert.equal(out.mfa_coverage.eligible_users, 40);
  assert.equal(out.mfa_coverage.percent, 20);
});

test("stats.get: null percent stays null (never coerced to 0)", async () => {
  const fetch = mkFetch(() => json({
    platform_id: "r",
    generated_at: 1,
    orgs_count: 0,
    users_count: 0,
    sessions_24h: 0,
    mfa_coverage: { covered_users: 0, eligible_users: 0, percent: null },
  }));
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const out = await realm.stats.get();
  assert.equal(out.mfa_coverage.percent, null);
  assert.notEqual(out.mfa_coverage.percent, 0);
});
