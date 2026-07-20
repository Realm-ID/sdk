package dev.realmid.sdk.auth;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;

/**
 * Response from {@link AuthClient#listAuthenticators}: the caller's enrolled
 * authenticator(s) plus how many backup/recovery codes remain unconsumed.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record AuthenticatorList(
        List<Authenticator> authenticators,
        @JsonProperty("backup_codes_remaining") int backupCodesRemaining
) {}
