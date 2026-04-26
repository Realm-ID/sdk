package dev.realmid.sdk.pagination;

import java.util.List;

/** SPEC §7 wire shape: {@code { items, next_cursor, total? }}. */
public record Page<T>(List<T> items, String nextCursor, Long total) {}
