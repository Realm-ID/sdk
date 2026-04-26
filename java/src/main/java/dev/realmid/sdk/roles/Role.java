package dev.realmid.sdk.roles;

/**
 * Role-name constants (ADR-040). Only {@code OWNER} and {@code MEMBER}
 * are genuine system roles; everything else is partner-defined per
 * realm. Role names on the wire are plain strings — see ADR-040
 * decision §3 (no fixed enum).
 */
public final class Role {

    private Role() {}

    /** The single load-bearing system role. */
    public static final String OWNER = "owner";

    /** The neutral default; no special server-side gating. */
    public static final String MEMBER = "member";
}
