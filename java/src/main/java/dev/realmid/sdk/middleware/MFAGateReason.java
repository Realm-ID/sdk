package dev.realmid.sdk.middleware;

/**
 * Mirrors the wire {@code reason} field on the 412 envelope (SPEC §10.4).
 */
public enum MFAGateReason {
    NO_MFA("no_mfa"),
    STALE_MFA("stale_mfa"),
    FRESH_REQUIRED("fresh_required");

    private final String wire;

    MFAGateReason(String wire) {
        this.wire = wire;
    }

    public String wire() { return wire; }
}
