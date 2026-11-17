import { test } from "node:test";
import { strict as assert } from "node:assert";
import { InfoClient } from "./info.js";
import type { HttpClient } from "./http.js";

const REALM = "realm_1";

function client(results: Array<"fail" | object>, clock: { t: number }) {
  let calls = 0;
  const http = {
    request: async () => {
      const r = results[Math.min(calls++, results.length - 1)];
      if (r === "fail") throw new Error("issuer down");
      return r;
    },
  } as unknown as HttpClient;
  return { info: new InfoClient(http, REALM, () => clock.t), calls: () => calls };
}

const ok = { data: [{ id: REALM, audience: "a.test", origin_enforcement: "required" }] };

test("a failed discovery is not cached: a later call after the retry window sees the policy", async () => {
  const clock = { t: 1_000_000 };
  const c = client(["fail", ok], clock);
  const first = await c.info.get();
  assert.equal(first["origin_enforcement"], undefined);
  clock.t += 31_000;
  const second = await c.info.get();
  assert.equal(second["origin_enforcement"], "required");
  assert.equal(c.calls(), 2);
});

test("a failed discovery is retried at most once per 30 s", async () => {
  const clock = { t: 1_000_000 };
  const c = client(["fail", "fail", ok], clock);
  await c.info.get();
  clock.t += 10_000;
  await c.info.get();
  assert.equal(c.calls(), 1, "inside the window: no second attempt");
  clock.t += 21_000;
  await c.info.get();
  assert.equal(c.calls(), 2);
  clock.t += 31_000;
  assert.equal((await c.info.get())["origin_enforcement"], "required");
});

test("a successful discovery stays cached", async () => {
  const clock = { t: 1_000_000 };
  const c = client([ok], clock);
  await c.info.get();
  clock.t += 600_000;
  await c.info.get();
  assert.equal(c.calls(), 1);
});
