package dev.realmid.sdk.tenants;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * SPEC §6.9 — first-login step-up gate row.
 *
 * @param contactKind        {@code email}, {@code phone} or {@code username}; null when not stated.
 * @param contactValueMasked the contact's value, masked ({@code j***@example.com}); null when not stated.
 * @param userDisplayName    display name of the account the slot belongs to; null when it has none.
 * @param userEmailMasked    the account's email, masked; null when it has none.
 * @param assertedIdentity   what the identity provider asserted at the held sign-in; null when not stated.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record ContactVerification(
        String id,
        @JsonProperty("contact_id") String contactId,
        @JsonProperty("user_id") String userId,
        String method,
        @JsonProperty("provider_uid") String providerUid,
        String state,
        @JsonProperty("created_at") long createdAt,
        @JsonProperty("expires_at") Long expiresAt,
        @JsonProperty("contact_kind") String contactKind,
        @JsonProperty("contact_value_masked") String contactValueMasked,
        @JsonProperty("user_display_name") String userDisplayName,
        @JsonProperty("user_email_masked") String userEmailMasked,
        @JsonProperty("asserted_identity") AssertedIdentity assertedIdentity
) {
    /** The shape before the masked contact fields, kept so existing callers still compile. */
    public ContactVerification(String id, String contactId, String userId, String method,
                               String providerUid, String state, long createdAt, Long expiresAt) {
        this(id, contactId, userId, method, providerUid, state, createdAt, expiresAt,
                null, null, null, null, null);
    }

    /** The identity provider's assertion on a held sign-in; every field optional, contact values masked. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record AssertedIdentity(
            @JsonProperty("email_masked") String emailMasked,
            @JsonProperty("phone_masked") String phoneMasked,
            @JsonProperty("display_name") String displayName
    ) {}
}
