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
        PasswordPolicy passwordPolicy) {

    /** Pre-ADR-111 constructor: no password policy. */
    public IdentityProvidersResponse(String tenantId, List<PublicIdentityProvider> providers,
                                     List<String> credentialMethods) {
        this(tenantId, providers, credentialMethods, null);
    }
}
