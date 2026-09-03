/**
 * Pagination — SPEC §7.
 *
 * Wire shape is locked to exactly `{ items: T[], next_cursor: string | null,
 * has_more: boolean, total?: number }`. Anything else (legacy `data`, bare
 * arrays, alternate cursor names) is rejected with a `server_error` — the
 * cross-language contract doesn't allow per-endpoint variation.
 */

import { RealmError } from "./errors.js";

export interface PageOpts {
  cursor?: string;
  limit?: number;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
  /**
   * The truncation signal, and the only honest one.
   *
   * NOT derivable from `items`: a page that fills exactly to the limit may or
   * may not be the last, and `total` is an estimate on some endpoints. Ask
   * "was this cut short?" of `hasMore`, never of `items.length`.
   *
   * Always a boolean, never absent — where a server omits `has_more` it is
   * derived from `next_cursor` (see `readPage`), so "absent" is resolved once
   * here rather than left for every caller to mis-handle as `false`.
   */
  hasMore: boolean;
  total?: number;
}

export interface Paginated<T> extends AsyncIterable<T> {
  page(opts?: PageOpts): Promise<Page<T>>;
}

/**
 * Validate and normalise the wire envelope for a paginated response.
 * Throws RealmError({ code: "server_error" }) when the shape doesn't
 * match SPEC §7.
 */
export function readPage<T>(raw: unknown): Page<T> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RealmError({
      code: "server_error",
      message: "unexpected paginated response shape",
    });
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj["items"])) {
    throw new RealmError({
      code: "server_error",
      message: "unexpected paginated response shape",
    });
  }
  const out: Page<T> = { items: obj["items"] as T[], hasMore: false };
  const nc = obj["next_cursor"];
  if (typeof nc === "string" && nc.length > 0) {
    out.nextCursor = nc;
  } else if (nc !== null && nc !== undefined) {
    throw new RealmError({
      code: "server_error",
      message: "unexpected paginated response shape",
    });
  }
  // has_more is tri-state on the wire: true / false / ABSENT. Absent is not
  // false — it means the endpoint predates the field, and for every such
  // endpoint a non-empty cursor is exactly the "more pages exist" signal.
  const hm = obj["has_more"];
  if (typeof hm === "boolean") {
    out.hasMore = hm;
  } else if (hm === null || hm === undefined) {
    out.hasMore = out.nextCursor !== undefined;
  } else {
    throw new RealmError({
      code: "server_error",
      message: "unexpected paginated response shape",
    });
  }
  if (typeof obj["total"] === "number") {
    out.total = obj["total"] as number;
  }
  return out;
}

/**
 * Re-encode a `Page<T>` back to its wire envelope.
 *
 * Exists so the round trip is TESTABLE, and so any consumer that decodes a page
 * and re-emits it (a BFF, a proxy, a cache) has one correct way to do it rather
 * than hand-rolling an object literal that quietly omits a key. That is not a
 * hypothetical failure: `go/v0.53.0` deleted `credential_methods` from
 * discovery exactly this way, and every layer's own suite stayed green.
 *
 * `next_cursor` and `has_more` are ALWAYS emitted — `has_more: false` is a real
 * answer ("this is the last page") and an absent key is not. `total` is emitted
 * only when the server sent one.
 */
export function writePage<T>(page: Page<T>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    items: page.items,
    next_cursor: page.nextCursor ?? null,
    has_more: page.hasMore,
  };
  if (typeof page.total === "number") out["total"] = page.total;
  return out;
}

/**
 * Build a paginated iterator from a `fetchPage` callback that the caller
 * supplies. The callback is responsible for constructing the right query and
 * returning items + nextCursor in one round trip.
 */
export function paginate<T>(
  fetchPage: (opts: PageOpts) => Promise<Page<T>>,
): Paginated<T> {
  return {
    page: (opts?: PageOpts) => fetchPage(opts ?? {}),
    async *[Symbol.asyncIterator]() {
      let cursor: string | undefined;
      while (true) {
        const p = await fetchPage(cursor ? { cursor } : {});
        for (const item of p.items) yield item;
        // hasMore is the terminator, ahead of nextCursor: a server answering a
        // stale non-empty cursor with has_more:false has said stop.
        if (!p.hasMore || !p.nextCursor) return;
        cursor = p.nextCursor;
      }
    },
  };
}
