package dev.realmid.sdk.pagination;

import java.util.List;

/**
 * SPEC §7 wire shape: {@code { items, next_cursor, has_more, total? }}.
 *
 * <p>{@code hasMore} is the TRUNCATION SIGNAL and the only honest one. It is not
 * derivable from {@code items}: a page that fills exactly to the limit may or
 * may not be the last, and {@code total} is an estimate on some endpoints. Ask
 * "was this list cut short?" of {@code hasMore}, never of {@code items.size()}.
 *
 * <p>It is always a plain boolean, never null — where a server omits
 * {@code has_more} {@link PageReader} derives it from {@code next_cursor}, so
 * "absent" is resolved once, at the edge, rather than left for every caller to
 * mis-handle as false.
 */
public record Page<T>(List<T> items, String nextCursor, boolean hasMore, Long total) {}
