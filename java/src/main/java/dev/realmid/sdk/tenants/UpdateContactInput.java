package dev.realmid.sdk.tenants;

/** SPEC §6.3 — admin email/phone change. At least one field must be non-null. */
public record UpdateContactInput(String email, String phone) {
    public static UpdateContactInput of(String email, String phone) { return new UpdateContactInput(email, phone); }
    public static UpdateContactInput ofEmail(String email) { return new UpdateContactInput(email, null); }
    public static UpdateContactInput ofPhone(String phone) { return new UpdateContactInput(null, phone); }
}
