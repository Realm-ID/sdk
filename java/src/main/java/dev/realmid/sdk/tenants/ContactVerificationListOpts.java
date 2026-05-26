package dev.realmid.sdk.tenants;

/** Filters for {@link ContactVerificationsClient#list}. All fields optional (SPEC §6.9). */
public record ContactVerificationListOpts(String state, String cursor, Integer limit) {
    public static ContactVerificationListOpts empty() { return new ContactVerificationListOpts(null, null, null); }
    public static ContactVerificationListOpts withState(String state) { return new ContactVerificationListOpts(state, null, null); }
}
