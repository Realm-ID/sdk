/**
 * Unit tests for the Google Identity Services (GIS) adapter.
 *
 * The adapter has no heavy static deps — it reaches GIS through the
 * injectable `window.google.accounts.id` global and a `scriptUrl`
 * override, and hands the resulting ID token to a `Realm.login` callback.
 * We stub `window` / `document` and a minimal GIS surface, plus a fake
 * Realm that records its `login` calls.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createGoogleProvider } from "./index.js";

// ---- minimal env stubs -------------------------------------------------

interface FakeIdConfig {
  client_id: string;
  callback: (resp: { credential: string }) => void;
  use_fedcm_for_prompt?: boolean;
  ux_mode?: "popup" | "redirect";
  login_uri?: string;
}

type PromptCb = (n: {
  isNotDisplayed(): boolean;
  isSkippedMoment(): boolean;
  getNotDisplayedReason(): string;
}) => void;

interface FakeId {
  initialize(cfg: FakeIdConfig): void;
  prompt(cb?: PromptCb): void;
  cancel(): void;
  _cfg?: FakeIdConfig;
}

function installEnv(opts?: {
  id?: FakeId;
  hash?: string;
  // when set, document.createElement scripts auto-fire onload and inject `id`
  scriptLoadsId?: FakeId;
  scriptFails?: boolean;
}) {
  const g = globalThis as Record<string, unknown>;
  const win: Record<string, unknown> = {
    location: { href: "https://app.example/", hash: opts?.hash ?? "" },
  };
  if (opts?.id) {
    win.google = { accounts: { id: opts.id } };
  }
  g.window = win;
  g.document = {
    head: { appendChild: (_: unknown) => {} },
    createElement: (_tag: string) => {
      const el: Record<string, unknown> = {};
      // Defer load/fail to the next microtask so the promise wiring runs.
      queueMicrotask(() => {
        if (opts?.scriptFails) {
          (el.onerror as (() => void) | undefined)?.();
          return;
        }
        if (opts?.scriptLoadsId) {
          win.google = { accounts: { id: opts.scriptLoadsId } };
        }
        (el.onload as (() => void) | undefined)?.();
      });
      return el;
    },
  };
  return win;
}

function clearEnv() {
  const g = globalThis as Record<string, unknown>;
  delete g.window;
  delete g.document;
}

function fakeRealm() {
  const calls: Array<{ method: string; providerToken: string }> = [];
  const realm = {
    login(req: { method: string; providerToken: string }) {
      calls.push(req);
      return Promise.resolve({ status: "authenticated", calls });
    },
  };
  return { realm: realm as unknown as Parameters<ReturnType<typeof createGoogleProvider>["loginWith"]>[0], calls };
}

beforeEach(() => clearEnv());
afterEach(() => clearEnv());

// ---- popup mode --------------------------------------------------------

test("signIn (popup): resolves the GIS credential", async () => {
  const id: FakeId = {
    initialize(cfg) { this._cfg = cfg; },
    prompt() { this._cfg!.callback({ credential: "id_token_abc" }); },
    cancel() {},
  };
  installEnv({ id });
  const google = createGoogleProvider({ clientId: "cid" });
  const token = await google.signIn();
  assert.equal(token, "id_token_abc");
  // FedCM is requested in popup mode.
  assert.equal(id._cfg!.use_fedcm_for_prompt, true);
  assert.equal(id._cfg!.client_id, "cid");
});

test("signIn (popup): empty credential rejects", async () => {
  const id: FakeId = {
    initialize(cfg) { this._cfg = cfg; },
    prompt() { this._cfg!.callback({ credential: "" }); },
    cancel() {},
  };
  installEnv({ id });
  const google = createGoogleProvider({ clientId: "cid" });
  await assert.rejects(() => google.signIn(), /no credential returned/);
});

test("signIn (popup): suppressed prompt rejects with reason", async () => {
  const id: FakeId = {
    initialize(cfg) { this._cfg = cfg; },
    prompt(cb) {
      cb?.({
        isNotDisplayed: () => true,
        isSkippedMoment: () => false,
        getNotDisplayedReason: () => "opt_out_or_no_session",
      });
    },
    cancel() {},
  };
  installEnv({ id });
  const google = createGoogleProvider({ clientId: "cid" });
  await assert.rejects(() => google.signIn(), /opt_out_or_no_session/);
});

test("loginWith: forwards the credential to realm.login as method=google", async () => {
  const id: FakeId = {
    initialize(cfg) { this._cfg = cfg; },
    prompt() { this._cfg!.callback({ credential: "tok_xyz" }); },
    cancel() {},
  };
  installEnv({ id });
  const google = createGoogleProvider({ clientId: "cid" });
  const { realm, calls } = fakeRealm();
  await google.loginWith(realm);
  assert.deepEqual(calls, [{ method: "google", providerToken: "tok_xyz" }]);
});

// ---- redirect mode -----------------------------------------------------

test("signIn (redirect): initializes ux_mode=redirect and returns empty (navigates away)", async () => {
  const id: FakeId = {
    initialize(cfg) { this._cfg = cfg; },
    prompt() {},
    cancel() {},
  };
  installEnv({ id });
  const google = createGoogleProvider({ clientId: "cid", mode: "redirect", redirectUri: "https://app/cb" });
  const token = await google.signIn();
  assert.equal(token, "");
  assert.equal(id._cfg!.ux_mode, "redirect");
  assert.equal(id._cfg!.login_uri, "https://app/cb");
});

test("loginWith (redirect): returns null without calling realm.login", async () => {
  const id: FakeId = { initialize(cfg) { this._cfg = cfg; }, prompt() {}, cancel() {} };
  installEnv({ id });
  const google = createGoogleProvider({ clientId: "cid", mode: "redirect" });
  const { realm, calls } = fakeRealm();
  const res = await google.loginWith(realm);
  assert.equal(res, null);
  assert.equal(calls.length, 0);
});

test("completeRedirect: parses credential from URL fragment and logs in", async () => {
  installEnv({ hash: "#credential=frag_tok&state=x" });
  const google = createGoogleProvider({ clientId: "cid", mode: "redirect" });
  const { realm, calls } = fakeRealm();
  const res = await google.completeRedirect(realm);
  assert.notEqual(res, null);
  assert.deepEqual(calls, [{ method: "google", providerToken: "frag_tok" }]);
});

test("completeRedirect: accepts the id_token fragment alias", async () => {
  installEnv({ hash: "#id_token=alias_tok" });
  const google = createGoogleProvider({ clientId: "cid", mode: "redirect" });
  const { realm, calls } = fakeRealm();
  await google.completeRedirect(realm);
  assert.deepEqual(calls, [{ method: "google", providerToken: "alias_tok" }]);
});

test("completeRedirect: no fragment → null, no login", async () => {
  installEnv({ hash: "" });
  const google = createGoogleProvider({ clientId: "cid", mode: "redirect" });
  const { realm, calls } = fakeRealm();
  const res = await google.completeRedirect(realm);
  assert.equal(res, null);
  assert.equal(calls.length, 0);
});

// ---- script loading ----------------------------------------------------

test("signIn: lazy-loads the GIS script when window.google is absent", async () => {
  const loadedId: FakeId = {
    initialize(cfg) { this._cfg = cfg; },
    prompt() { this._cfg!.callback({ credential: "after_load" }); },
    cancel() {},
  };
  // No id present initially; the injected <script> onload installs it.
  installEnv({ scriptLoadsId: loadedId });
  const google = createGoogleProvider({ clientId: "cid", scriptUrl: "https://fake/gsi" });
  const token = await google.signIn();
  assert.equal(token, "after_load");
});

test("signIn: rejects when the GIS script fails to load", async () => {
  installEnv({ scriptFails: true });
  const google = createGoogleProvider({ clientId: "cid", scriptUrl: "https://fake/gsi" });
  await assert.rejects(() => google.signIn(), /failed to load Google Identity Services/);
});

test("signIn: rejects outside a browser (no window)", async () => {
  clearEnv();
  const google = createGoogleProvider({ clientId: "cid" });
  await assert.rejects(() => google.signIn(), /not in browser/);
});
