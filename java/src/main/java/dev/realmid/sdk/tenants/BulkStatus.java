package dev.realmid.sdk.tenants;

/** The two statuses {@code POST /tenants/{id}/users/bulk-status} accepts. No default. */
public enum BulkStatus {
    SUSPENDED("suspended"),
    DEACTIVATED("deactivated");

    private final String wire;
    BulkStatus(String w) { this.wire = w; }
    public String wire() { return wire; }
}
