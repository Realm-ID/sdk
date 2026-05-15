/**
 * Storage-adapter tests — drive the three built-in adapters against
 * hand-rolled `globalThis.localStorage` / `sessionStorage` shims and
 * verify SSR-safe behaviour when both are absent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  memoryStorage,
  localStorageAdapter,
  sessionStorageAdapter,
  DEFAULT_STORAGE_KEY,
  type StoredSession,
} from "./index.js";

function fakeStorage(): { store: Map<string, string>; api: Storage } {
  const store = new Map<string, string>();
  const api: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    key: (i) => Array.from(store.keys())[i] ?? null,
    removeItem: (k) => {
      store.delete(k);
    },
    setItem: (k, v) => {
      store.set(k, String(v));
    },
  };
  return { store, api };
}

const sample: StoredSession = {
  accessToken: "at-1",
  expiresAt: 1_900_000_000,
  tenantId: "t1",
  user: { id: "u1", email: "u@x" },
  tenants: [{ id: "t1", role: "owner" }],
};

function withLocalStorage(api: Storage | undefined, fn: () => void) {
  const g = globalThis as unknown as { localStorage?: Storage };
  const prev = g.localStorage;
  if (api === undefined) {
    delete g.localStorage;
  } else {
    g.localStorage = api;
  }
  try {
    fn();
  } finally {
    if (prev === undefined) delete g.localStorage;
    else g.localStorage = prev;
  }
}

function withSessionStorage(api: Storage | undefined, fn: () => void) {
  const g = globalThis as unknown as { sessionStorage?: Storage };
  const prev = g.sessionStorage;
  if (api === undefined) {
    delete g.sessionStorage;
  } else {
    g.sessionStorage = api;
  }
  try {
    fn();
  } finally {
    if (prev === undefined) delete g.sessionStorage;
    else g.sessionStorage = prev;
  }
}

test("memoryStorage round-trips and clears", () => {
  const s = memoryStorage();
  assert.equal(s.read(), null);
  s.write(sample);
  assert.deepEqual(s.read(), sample);
  s.clear();
  assert.equal(s.read(), null);
});

test("localStorageAdapter round-trips via fake storage", () => {
  const { store, api } = fakeStorage();
  withLocalStorage(api, () => {
    const s = localStorageAdapter();
    s.write(sample);
    assert.ok(store.has(DEFAULT_STORAGE_KEY));
    assert.deepEqual(s.read(), sample);
    s.clear();
    assert.equal(s.read(), null);
    assert.equal(store.has(DEFAULT_STORAGE_KEY), false);
  });
});

test("localStorageAdapter honours a custom key", () => {
  const { store, api } = fakeStorage();
  withLocalStorage(api, () => {
    const s = localStorageAdapter("custom:key");
    s.write(sample);
    assert.ok(store.has("custom:key"));
    assert.equal(store.has(DEFAULT_STORAGE_KEY), false);
  });
});

test("localStorageAdapter returns null on corrupt JSON without throwing", () => {
  const { store, api } = fakeStorage();
  store.set(DEFAULT_STORAGE_KEY, "{not json");
  withLocalStorage(api, () => {
    const s = localStorageAdapter();
    assert.equal(s.read(), null);
  });
});

test("localStorageAdapter returns null when entry is the wrong shape", () => {
  const { store, api } = fakeStorage();
  store.set(DEFAULT_STORAGE_KEY, JSON.stringify({ accessToken: 42 }));
  withLocalStorage(api, () => {
    const s = localStorageAdapter();
    assert.equal(s.read(), null);
  });
});

test("sessionStorageAdapter round-trips via fake storage", () => {
  const { store, api } = fakeStorage();
  withSessionStorage(api, () => {
    const s = sessionStorageAdapter();
    s.write(sample);
    assert.ok(store.has(DEFAULT_STORAGE_KEY));
    assert.deepEqual(s.read(), sample);
    s.clear();
    assert.equal(s.read(), null);
  });
});

test("sessionStorageAdapter returns null on corrupt JSON", () => {
  const { store, api } = fakeStorage();
  store.set(DEFAULT_STORAGE_KEY, "}");
  withSessionStorage(api, () => {
    const s = sessionStorageAdapter();
    assert.equal(s.read(), null);
  });
});

test("browser adapters are SSR-safe when storage is undefined", () => {
  withLocalStorage(undefined, () => {
    withSessionStorage(undefined, () => {
      const local = localStorageAdapter();
      const session = sessionStorageAdapter();
      assert.equal(local.read(), null);
      assert.equal(session.read(), null);
      // write / clear are no-ops and must not throw
      local.write(sample);
      local.clear();
      session.write(sample);
      session.clear();
      assert.equal(local.read(), null);
      assert.equal(session.read(), null);
    });
  });
});

test("localStorageAdapter swallows setItem quota errors", () => {
  const api: Storage = {
    length: 0,
    clear: () => {},
    getItem: () => null,
    key: () => null,
    removeItem: () => {},
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  withLocalStorage(api, () => {
    const s = localStorageAdapter();
    // Must not throw.
    s.write(sample);
  });
});
