package dev.realmid.sdk.sources;

import java.util.List;

/**
 * Sparse PATCH body for {@code /sources/{id}} (ADR-072). A null field is left
 * unchanged; {@code allowedMethods} is re-validated against the source's type
 * server-side (mapping-2 can never weaken mapping-1). {@code enabled} is a
 * boxed {@link Boolean} so null means "leave alone".
 */
public record SourcePatch(String label, List<String> allowedMethods, Boolean enabled) {

    public static SourcePatch label(String label) { return new SourcePatch(label, null, null); }

    public static SourcePatch allowedMethods(List<String> methods) {
        return new SourcePatch(null, methods, null);
    }

    public static SourcePatch enabled(boolean enabled) { return new SourcePatch(null, null, enabled); }
}
