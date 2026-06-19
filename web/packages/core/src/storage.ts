/**
 * Pluggable session storage for @realm-id/web.
 *
 * The SDK can persist the *opaque* session payload (access bearer +
 * absolute expiry + user/tenant summary) between page-loads so a tab
 * close + reopen doesn't bounce the user through login. This matters
 * for partner BFFs that hand the SPA a `session_token` in JSON and
 * expect it back as `Authorization: Bearer ...` — the cookie path
 * already survives reload on its own.
 *
 * Three built-in adapters are shipped:
 *  - `memoryStorage()`         — default; in-process Map, lost on reload
 *  - `localStorageAdapter()`   — survives tab close; survives reload
 *  - `sessionStorageAdapter()` — survives reload only
 *
 * Adapters are SSR-safe: when `globalThis.localStorage` is unavailable
 * (Node, prerender), `read()` returns null and write/clear are no-ops.
 * They also swallow parse / quota errors and treat them as "nothing
 * stored" — a corrupt entry can never brick the boot path.
 */

import type { TenantRef, UserSummary } from "./types.js";

export interface StoredSession {
  /** Bearer token to send as `Authorization: Bearer ...`. May be empty for tokenless-rotation BFFs. */
  accessToken: string;
  /** Absolute expiry, **epoch seconds**. The SDK rejects entries already in the past (with a small skew). */
  expiresAt: number;
  /** Current tenant pointer. */
  tenantId?: string;
  /** Cached user summary so the boot path can paint state synchronously before /me resolves. */
  user?: UserSummary;
  /** Cached tenant list for the same reason. */
  tenants?: TenantRef[];
}

export interface StorageAdapter {
  read(): StoredSession | null;
  write(s: StoredSession): void;
  clear(): void;
}

export const DEFAULT_STORAGE_KEY = "@realm-id/web:session";

export function memoryStorage(): StorageAdapter {
  let cell: StoredSession | null = null;
  return {
    read: () => cell,
    write: (s) => {
      cell = s;
    },
    clear: () => {
      cell = null;
    },
  };
}

export function localStorageAdapter(key: string = DEFAULT_STORAGE_KEY): StorageAdapter {
  return browserStorageAdapter(() => safeStorage("localStorage"), key);
}

export function sessionStorageAdapter(key: string = DEFAULT_STORAGE_KEY): StorageAdapter {
  return browserStorageAdapter(() => safeStorage("sessionStorage"), key);
}

/* -------------------------------------------------- internals */

type StorageLike = {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
};

function safeStorage(kind: "localStorage" | "sessionStorage"): StorageLike | null {
  try {
    const g = globalThis as unknown as Record<string, unknown>;
    if (typeof g.window === "undefined" && g[kind] === undefined) return null;
    const s = g[kind] as StorageLike | undefined;
    return s ?? null;
  } catch {
    return null;
  }
}

function browserStorageAdapter(get: () => StorageLike | null, key: string): StorageAdapter {
  return {
    read: () => {
      const s = get();
      if (!s) return null;
      try {
        const raw = s.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as unknown;
        if (!isStoredSession(parsed)) return null;
        return parsed;
      } catch {
        return null;
      }
    },
    write: (sess) => {
      const s = get();
      if (!s) return;
      try {
        s.setItem(key, JSON.stringify(sess));
      } catch {
        /* quota / serialization — treat as best-effort */
      }
    },
    clear: () => {
      const s = get();
      if (!s) return;
      try {
        s.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}

function isStoredSession(v: unknown): v is StoredSession {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.accessToken === "string" && typeof o.expiresAt === "number" && Number.isFinite(o.expiresAt);
}
