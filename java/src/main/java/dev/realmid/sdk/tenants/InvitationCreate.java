package dev.realmid.sdk.tenants;

public record InvitationCreate(String identifier, String role) {
    public static InvitationCreate of(String identifier) { return new InvitationCreate(identifier, null); }
    public static InvitationCreate of(String identifier, String role) { return new InvitationCreate(identifier, role); }
}
