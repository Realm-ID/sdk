package dev.realmid.sdk.idp;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;

/**
 * Typed result of {@link IdentityProvidersClient#discover} (SPEC §6.10).
 * {@code tenantId} is set only when the issuer resolved the call to a specific
 * tenant (origin-passthrough or explicit {@code tenantId}); pass it through on
 * {@code auth.login} when present (required for method=google per ADR-046).
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record IdentityProvidersResponse(
        @JsonProperty("tenant_id") @JsonAlias("tenantId") String tenantId,
        List<PublicIdentityProvider> providers,
        /**
         * The NON-IdP login methods the realm can actually complete:
         * {@code "password"} (ADR-104) and {@code "otp"} (ADR-103).
         *
         * <p>⚠️ A BFF that re-serialises a typed discovery response DELETES any
         * field its type omits, with no error anywhere — which is how credential
         * sign-in shipped unreachable from every BFF-fronted console. Absent
         * means "the server did not say", never "none".
         */
        @JsonProperty("credential_methods") @JsonAlias("credentialMethods")
        List<String> credentialMethods,
        /**
         * The promise a login screen shows (ADR-111 P9), present EXACTLY when the realm has
         * password sign-in on. {@code null} means absent - never {@code false}: a BFF
         * re-serialising this response must not invent a policy, so a null is omitted on write.
         */
        @JsonProperty("password_policy") @JsonAlias("passwordPolicy")
        @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
        PasswordPolicy passwordPolicy,
        /**
         * The phone channels ({@code "whatsapp"}, {@code "sms"}) the realm has configured AND that are
         * operational right now (ADR-115; SPEC 4.1.4a). {@code null} means the server did not say (an older
         * issuer); an EMPTY list means the realm has no working phone channel. They are different facts and
         * both survive re-serialisation (null is omitted, an empty list is written as {@code []}). Offer a
         * phone option via {@link #offersPhoneLogin()}.
         */
        @JsonProperty("phone_channels") @JsonAlias("phoneChannels")
        @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
        List<String> phoneChannels) {

    /** Pre-ADR-115 constructor: no phone channels (absent). */
    public IdentityProvidersResponse(String tenantId, List<PublicIdentityProvider> providers,
                                     List<String> credentialMethods, PasswordPolicy passwordPolicy) {
        this(tenantId, providers, credentialMethods, passwordPolicy, null);
    }

    /** True when a login screen should offer a phone option: credentialMethods has "otp" AND phoneChannels is present and non-empty. */
    @com.fasterxml.jackson.annotation.JsonIgnore
    public boolean offersPhoneLogin() {
        return phoneChannels != null && !phoneChannels.isEmpty()
                && credentialMethods != null && credentialMethods.contains("otp");
    }

    /** Pre-ADR-111 constructor: no password policy. */
    public IdentityProvidersResponse(String tenantId, List<PublicIdentityProvider> providers,
                                     List<String> credentialMethods) {
        this(tenantId, providers, credentialMethods, null, null);
    }
}
