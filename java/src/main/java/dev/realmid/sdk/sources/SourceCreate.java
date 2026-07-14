package dev.realmid.sdk.sources;

import java.util.List;

/**
 * POST body for {@code /sources} (ADR-072). {@code platformId} defaults to the
 * realm when null. A {@code bot} source may list only {@code otp} in
 * {@code allowedMethods}; a human source may never list {@code otp}
 * (mapping-1 invariant — server rejects with {@code method_violates_kind}).
 */
public record SourceCreate(String platformId, String type, String label, List<String> allowedMethods) {

    /** Create a source in the realm's own platform (platformId defaults server-side). */
    public SourceCreate(String type, String label, List<String> allowedMethods) {
        this(null, type, label, allowedMethods);
    }

    public SourceCreate(String type, String label) {
        this(null, type, label, null);
    }
}
