package dev.realmid.sdk.pagination;

/** Pagination request — both fields optional. */
public record PageOpts(String cursor, Integer limit) {
    public static PageOpts empty() { return new PageOpts(null, null); }
    public static PageOpts withCursor(String cursor) { return new PageOpts(cursor, null); }
    public static PageOpts withLimit(int limit) { return new PageOpts(null, limit); }
}
