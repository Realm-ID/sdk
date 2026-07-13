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

test("signingKeys.list: reads keyring + rotation policy", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "GET");
    assert.match(req.url, /\/platforms\/r\/signing-keys$/);
    return new Response(JSON.stringify({
      keys: [
        { kid: "k2", created_at: 200, active_until: 900, retire_at: 1200, is_current: true },
        { kid: "k1", created_at: 100, active_until: 200, retire_at: 500, is_current: false },
      ],
      rotation: { mode: "auto", interval: "1w", next_rotation_at: 900 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const out = await realm.signingKeys.list();
  assert.equal(out.keys.length, 2);
  assert.equal(out.keys[0]!.is_current, true);
  assert.equal(out.rotation.mode, "auto");
  assert.equal(out.rotation.interval, "1w");
  assert.equal(out.rotation.next_rotation_at, 900);
});

test("signingKeys.list: tolerates a bare/empty envelope", async () => {
  const fetch = mkFetch(() => new Response(JSON.stringify({}), {
    status: 200, headers: { "content-type": "application/json" },
  }));
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const out = await realm.signingKeys.list();
  assert.deepEqual(out.keys, []);
  assert.equal(out.rotation.mode, "auto");
});

test("signingKeys.rotate: POSTs rotate and returns new/retired kids", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "POST");
    assert.match(req.url, /\/platforms\/r\/signing-keys\/rotate$/);
    return new Response(JSON.stringify({ kid: "k3", retired_kids: ["k1"] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  const realm = createRealm({ realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const out = await realm.signingKeys.rotate();
  assert.equal(out.kid, "k3");
  assert.deepEqual(out.retired_kids, ["k1"]);
});
