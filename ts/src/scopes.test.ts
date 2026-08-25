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

// --- ADR-097 §G: remove ------------------------------------------------------

test("remove posts to the realm's scopes/remove with the scope", async () => {
  const seen: Captured[] = [];
  const c = new ScopesClient(
    fakeHttp(seen, {
      scope: "a.b",
      dry_run: false,
      on_empty: "refuse",
      outcome: "applied",
      keys: 2,
      revoked: 0,
      emptied: [],
    }),
    "plt_x",
  );

  const res = await c.remove({ scope: "a.b" });

  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.method, "POST");
  // The path is the ONLY thing distinguishing this from rename, and re-pointing
  // it at rename would otherwise break nothing observable in this file.
  assert.equal(seen[0]!.path, "/platforms/plt_x/scopes/remove");
  assert.deepEqual(seen[0]!.body, { scope: "a.b", on_empty: undefined });
  assert.equal(res.outcome, "applied");
});

test("remove carries on_empty when asked, and omits it otherwise", async () => {
  const seen: Captured[] = [];
  const c = new ScopesClient(fakeHttp(seen, {}), "plt_x");

  await c.remove({ scope: "a", onEmpty: "revoke" });
  assert.deepEqual(seen[0]!.body, { scope: "a", on_empty: "revoke" });

  // Omitted rather than sent as "refuse": the server owns the default, and a
  // client that hardcodes it would keep sending the old default after a
  // server-side change.
  await c.remove({ scope: "a" });
  assert.equal((seen[1]!.body as { on_empty?: string }).on_empty, undefined);
});

test("remove sends dry_run only when previewing", async () => {
  const seen: Captured[] = [];
  const c = new ScopesClient(fakeHttp(seen, {}), "plt_x");

  await c.remove({ scope: "a", dryRun: true });
  assert.equal(seen[0]!.query?.dry_run, "true");

  await c.remove({ scope: "a" });
  assert.equal(seen[1]!.query?.dry_run, undefined);
});

test("remove url-encodes the realm id", async () => {
  const seen: Captured[] = [];
  const c = new ScopesClient(fakeHttp(seen, {}), "plt/x");

  await c.remove({ scope: "a" });
  assert.equal(seen[0]!.path, "/platforms/plt%2Fx/scopes/remove");
});
