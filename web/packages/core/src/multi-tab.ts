/**
 * Cross-tab notification. BroadcastChannel where supported, falls back to
 * `storage` events. Messages are small JSON payloads; the channel name
 * defaults to a hash of baseUrl so two SDK instances on the same origin
 * pointing at different BFFs don't cross-talk.
 */

export type TabMessage =
  | { type: "login" }
  | { type: "logout"; reason: string }
  | { type: "tenant_switched"; tenantId: string }
  | { type: "token_refreshed" };

const STORAGE_KEY = "__realmid_tab_msg__";

export interface TabBus {
  post(msg: TabMessage): void;
  subscribe(fn: (msg: TabMessage) => void): () => void;
  close(): void;
}

export function createTabBus(channelName: string): TabBus {
  if (typeof window === "undefined") return noopBus();

  const listeners = new Set<(msg: TabMessage) => void>();

  let bc: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== "undefined") {
    bc = new BroadcastChannel(channelName);
    bc.onmessage = (ev) => {
      for (const fn of listeners) {
        try {
          fn(ev.data as TabMessage);
        } catch {
          /* swallow */
        }
      }
    };
  }

  const onStorage = (ev: StorageEvent) => {
    if (ev.key !== STORAGE_KEY || !ev.newValue) return;
    try {
      const parsed = JSON.parse(ev.newValue);
      if (parsed.channel !== channelName) return;
      for (const fn of listeners) fn(parsed.msg as TabMessage);
    } catch {
      /* swallow */
    }
  };
  if (!bc && typeof window.addEventListener === "function") {
    window.addEventListener("storage", onStorage);
  }

  return {
    post(msg) {
      if (bc) {
        bc.postMessage(msg);
        return;
      }
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ channel: channelName, msg, ts: Date.now() }),
        );
      } catch {
        /* localStorage may be unavailable (private mode etc.) */
      }
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    close() {
      listeners.clear();
      if (bc) bc.close();
      if (!bc && typeof window.removeEventListener === "function") {
        window.removeEventListener("storage", onStorage);
      }
    },
  };
}

function noopBus(): TabBus {
  return {
    post() {},
    subscribe() {
      return () => {};
    },
    close() {},
  };
}
