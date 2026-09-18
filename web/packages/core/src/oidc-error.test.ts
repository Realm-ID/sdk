/**
 * An OIDC provider can come back two ways, and until now the SDK only knew
 * one. `?code&state` was handled; `?error=access_denied` fell through
 * `readCallback` (which needs a `code`) and `completeSignIn` returned `null` —
 * the exact value it returns for "this page load is not a callback at all".
 *
 * So every consumer re-parsed `window.location.search` itself to tell a refused
 * sign-in from an ordinary load, and hand-rolled its own message map. The RealmID
 * console said so in a comment beside its copy.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { readCallbackError, describeCallbackError } from "./oidc.js";
import { createRealm, RealmError } from "./index.js";

describe("readCallbackError", () => {
  it("reads the error and its description", () => {
    const e = readCallbackError("?error=access_denied&error_description=User+cancelled");
    assert.deepEqual(e, { error: "access_denied", errorDescription: "User cancelled" });
  });

  it("is null on a success callback and on a plain load", () => {
    // The discriminator has to be one-directional: a success callback that
    // read as an error would turn every sign-in into a refusal.
    assert.equal(readCallbackError("?code=abc&state=xyz"), null);
    assert.equal(readCallbackError(""), null);
    assert.equal(readCallbackError("?utm_source=email"), null);
  });

  it("carries an empty description rather than dropping the error", () => {
    // Entra omits error_description on some refusals. An error with no prose
    // is still an error; returning null there would restore the bug.
    assert.deepEqual(readCallbackError("?error=server_error"), {
      error: "server_error",
      errorDescription: "",
    });
  });
});

describe("describeCallbackError", () => {
  it("maps the codes a person can act on", () => {
    assert.match(
      describeCallbackError({ error: "access_denied", errorDescription: "" }),
      /declined/i,
    );
    assert.match(
      describeCallbackError({ error: "invalid_client", errorDescription: "" }),
      /administrator/i,
    );
    assert.match(
      describeCallbackError({ error: "temporarily_unavailable", errorDescription: "" }),
      /temporarily unavailable/i,
    );
  });

  it("strips the Entra diagnostic tail off an unmapped description", () => {
    const msg = describeCallbackError({
      error: "AADSTS50011",
      errorDescription:
        "The redirect URI does not match. Trace ID: abc Correlation ID: def Timestamp: 2026-09-18",
    });
    assert.equal(msg, "The redirect URI does not match.");
  });

  it("never surfaces a bare wire code to a person", () => {
    // The fallback is the point: `AADSTS50011` rendered in a dialog is not a
    // message. With no description either, a generic sentence beats the code.
    assert.equal(
      describeCallbackError({ error: "AADSTS50011", errorDescription: "" }),
      "Sign-in failed. Please try again.",
    );
  });
});

/** Minimal `window` for the redirect path: search, history, sessionStorage. */
function withWindow(search: string, run: () => Promise<void>): Promise<void> {
  const items = new Map<string, string>();
  const replaced: string[] = [];
  const stub = {
    location: {
      search,
      href: "https://app.test/callback" + search,
      origin: "https://app.test",
      pathname: "/callback",
      hash: "",
    },
    history: {
      replaceState: (_s: unknown, _t: string, url: string) => void replaced.push(url),
    },
    sessionStorage: {
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => void items.set(k, v),
      removeItem: (k: string) => void items.delete(k),
    },
  };
  const g = globalThis as Record<string, unknown>;
  const hadWindow = "window" in g;
  const hadDocument = "document" in g;
  g.window = stub;
  g.document = { title: "app" };
  (stub as unknown as { _items: Map<string, string> })._items = items;
  (stub as unknown as { _replaced: string[] })._replaced = replaced;
  return run().finally(() => {
    // Under a `window` the realm opens a BroadcastChannel for multi-tab sync,
    // which holds the event loop open and hangs the runner after the last
    // assertion passes. Closing is part of the fixture, not a test concern.
    for (const r of open.splice(0)) r.close();
    if (!hadWindow) delete g.window;
    if (!hadDocument) delete g.document;
  });
}

const open: ReturnType<typeof createRealm>[] = [];

function makeRealm() {
  const realm = createRealm({
    baseUrl: "https://bff.test",
    fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
  });
  open.push(realm);
  return realm;
}

describe("completeSignIn on an OIDC error return", () => {
  it("throws a typed RealmError instead of returning null", async () => {
    await withWindow("?error=access_denied&error_description=User+cancelled", async () => {
      const realm = makeRealm();

      await assert.rejects(
        () => realm.completeSignIn(),
        (e: unknown) => {
          assert.ok(e instanceof RealmError, "not a RealmError — apps catch on the class");
          assert.equal(e.code, "oidc_provider_error");
          assert.match(e.message, /declined/i, "message must be the user-facing sentence");
          // The raw pair stays reachable for logs; the humanized sentence is
          // lossy on purpose and an operator still needs the wire code.
          assert.deepEqual(e.body, {
            error: "access_denied",
            error_description: "User cancelled",
          });
          return true;
        },
      );
    });
  });

  it("cleans the error params out of the address bar", async () => {
    await withWindow("?error=access_denied&error_description=nope", async () => {
      const realm = makeRealm();
      await realm.completeSignIn().catch(() => {});

      // Left in place, a reload replays the refusal forever.
      const replaced = (globalThis as unknown as { window: { _replaced: string[] } }).window._replaced;
      assert.equal(replaced.length, 1, "the URL was not rewritten");
      assert.ok(!replaced[0]!.includes("error"), `error params survived: ${replaced[0]}`);
    });
  });

  it("still returns null on a page that is not a callback", async () => {
    // The control. Without it the throw above is satisfied by a completeSignIn
    // that refuses every load, which would break every app's startup.
    await withWindow("?utm_source=email", async () => {
      const realm = makeRealm();
      assert.equal(await realm.completeSignIn(), null);
    });
  });
});
