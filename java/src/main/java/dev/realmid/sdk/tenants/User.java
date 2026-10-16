package dev.realmid.sdk.tenants;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * @param joinedVia       raw wire value of how the membership was created
 *                        (ADR-049 § Amendment Q4); null when absent. Use
 *                        {@link #joinedViaKind()} for the forward-compatible enum.
 * @param joinedViaDomain the verified domain whose SSO grant provisioned the
 *                        row; only present when {@code joinedVia} is {@code sso_domain}.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record User(
        String id,
        String email,
        String phone,
        @JsonProperty("display_name") @JsonAlias("displayName") String displayName,
        String status,
        @JsonProperty("mfa_enabled") @JsonAlias("mfaEnabled") Boolean mfaEnabled,
        String role,
        @JsonProperty("joined_via") String joinedVia,
        @JsonProperty("joined_via_domain") String joinedViaDomain
) {
    /** Pre-0.51 shape, kept so existing callers still compile. */
    public User(String id, String email, String phone, String displayName, String status,
                Boolean mfaEnabled, String role) {
        this(id, email, phone, displayName, status, mfaEnabled, role, null, null);
    }

    /** {@link #joinedVia()} as an enum; unknown or absent values are {@link JoinedVia#UNKNOWN}. */
    @JsonIgnore
    public JoinedVia joinedViaKind() { return JoinedVia.fromWire(joinedVia); }
}
