package dev.realmid.sdk.tenants;

public record InvitationCreate(String email, String role) {
    public static InvitationCreate of(String email) { return new InvitationCreate(email, null); }
    public static InvitationCreate of(String email, String role) { return new InvitationCreate(email, role); }
}
