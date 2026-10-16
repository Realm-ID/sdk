package dev.realmid.sdk.tenants;

/**
 * How a membership was created (issuer ADR-049 § Amendment Q4). Forward
 * compatible: {@link #fromWire} maps any value this SDK does not know to
 * {@link #UNKNOWN} rather than failing. The raw string stays on
 * {@link User#joinedVia()}.
 */
public enum JoinedVia {
    INVITATION("invitation"),
    SSO_DOMAIN("sso_domain"),
    OPEN_SIGNUP("open_signup"),
    IMPORT("import"),
    ADMIN("admin"),
    OWNER("owner"),
    SERVICE("service"),
    UNKNOWN("unknown");

    private final String wire;
    JoinedVia(String w) { this.wire = w; }
    public String wire() { return wire; }

    /** Null or unrecognised wire values resolve to {@link #UNKNOWN}. */
    public static JoinedVia fromWire(String w) {
        if (w != null) for (JoinedVia v : values()) if (v.wire.equals(w)) return v;
        return UNKNOWN;
    }
}
