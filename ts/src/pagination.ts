/**
 * Pagination — SPEC §7.
 *
 * Wire shape is locked to exactly `{ items: T[], next_cursor: string | null,
 * total?: number }`. Anything else (legacy `data`, bare arrays, alternate
 * cursor names) is rejected with a `server_error` — the cross-language
 * contract doesn't allow per-endpoint variation.
 */

import { RealmError } from "./errors.js";

export interface PageOpts {
  cursor?: string;
  limit?: number;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
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
  const out: Page<T> = { items: obj["items"] as T[] };
  const nc = obj["next_cursor"];
  if (typeof nc === "string" && nc.length > 0) {
    out.nextCursor = nc;
  } else if (nc !== null && nc !== undefined) {
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
        if (!p.nextCursor) return;
        cursor = p.nextCursor;
      }
    },
  };
}
