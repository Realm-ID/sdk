/**
 * Pagination helper. Every list method returns a `Paginated<T>` which is both
 * an `AsyncIterable<T>` (for natural `for await` loops) and exposes a `.page()`
 * method for callers that want manual cursor control.
 */

export interface PageOpts {
  cursor?: string;
  limit?: number;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface Paginated<T> extends AsyncIterable<T> {
  page(opts?: PageOpts): Promise<Page<T>>;
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
