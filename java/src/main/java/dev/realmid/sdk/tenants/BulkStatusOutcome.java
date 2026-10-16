package dev.realmid.sdk.tenants;

/** Per-id outcome of a bulk status change. Unrecognised values resolve to {@link #UNKNOWN}. */
public enum BulkStatusOutcome {
    UPDATED("updated"),
    UNCHANGED("unchanged"),
    NOT_FOUND("not_found"),
    REFUSED_OWNER("refused_owner"),
    UNKNOWN("unknown");

    private final String wire;
    BulkStatusOutcome(String w) { this.wire = w; }
    public String wire() { return wire; }

    public static BulkStatusOutcome fromWire(String w) {
        if (w != null) for (BulkStatusOutcome v : values()) if (v.wire.equals(w)) return v;
        return UNKNOWN;
    }
}
