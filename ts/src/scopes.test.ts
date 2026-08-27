import { test } from "node:test";
import { strict as assert } from "node:assert";
import { ScopesClient } from "./scopes.js";

type Captured = { method: string; path: string; query?: Record<string, unknown>; body?: unknown };

function fakeHttp(capture: Captured[], reply: unknown) {
  return {
    async request(opts: Captured) {
      capture.push(opts);
      return reply;
    },
  } as unknown as ConstructorParameters<typeof ScopesClient>[0];
}

// The wrapper's ENTIRE job is the path, the method and the shape of what it
// sends. A wrapper with no test has nothing verified about the only thing it
// does — the ADR-095 `acceptInvitation` lesson, where the wrapper shipped with
// no test in any of the three languages and re-pointing it at the wrong path
// broke nothing.
test("rename posts to the realm's scopes/rename with from and to", async () => {
  const seen: Captured[] = [];
  const c = new ScopesClient(fakeHttp(seen, { from: "a.b", to: "a:b", dry_run: false, keys: 3, roles: 0 }), "plt_x");

  const res = await c.rename({ from: "a.b", to: "a:b" });

  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.method, "POST");
  assert.equal(seen[0]!.path, "/platforms/plt_x/scopes/rename");
  assert.deepEqual(seen[0]!.body, { from: "a.b", to: "a:b" });
  assert.equal(res.keys, 3);
});

// dry_run is a QUERY parameter, not a body field. Sending it in the body would
// be silently ignored by the issuer and every "preview" would be a real write —
// on an operation that is not reversible in general.
test("dryRun becomes the dry_run query parameter, and is absent otherwise", async () => {
  const seen: Captured[] = [];
  const c = new ScopesClient(fakeHttp(seen, { from: "a", to: "b", dry_run: true, keys: 0, roles: 0 }), "plt_x");

  await c.rename({ from: "a", to: "b", dryRun: true });
  assert.equal(seen[0]!.query?.["dry_run"], "true");
  assert.ok(!("dryRun" in (seen[0]!.body as Record<string, unknown>)),
    "dryRun must not leak into the body");

  await c.rename({ from: "a", to: "b" });
  assert.equal(seen[1]!.query?.["dry_run"], undefined,
    "omitting dryRun must omit the parameter, not send dry_run=false");
});

test("the realm id is path-escaped", async () => {
  const seen: Captured[] = [];
  const c = new ScopesClient(fakeHttp(seen, {}), "plt/../evil");
  await c.rename({ from: "a", to: "b" });
  assert.ok(!seen[0]!.path.includes("../"), `path traversal reached the URL: ${seen[0]!.path}`);
});

// --- ADR-097 §G removal: DELETED by ADR-100 D10 ------------------------------
//
// Five tests stood here. They are not "missing coverage": ScopesClient.remove
// no longer exists in any repo, because retiring a scope needs no server-side
// write — the partner stops emitting the string in the `role_permissions` list
// it supplies at token mint, and the stale entry never survives an intersection
// again. Do not restore them from git history; there is nothing left to call.
