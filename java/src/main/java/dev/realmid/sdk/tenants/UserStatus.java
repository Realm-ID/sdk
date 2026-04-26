package dev.realmid.sdk.tenants;

public enum UserStatus {
    ACTIVE("active"),
    SUSPENDED("suspended"),
    DEACTIVATED("deactivated");

    private final String wire;
    UserStatus(String w) { this.wire = w; }
    public String wire() { return wire; }
}
