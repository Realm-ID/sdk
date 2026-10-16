package dev.realmid.sdk.idp;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Discovery view of a realm's password promise (ADR-111 P9, SPEC 4.1.4): when
 * {@code requireVerifiedEmail} is on, a member cannot be given a password unless they have a
 * verified email, so a login screen can say so up front.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record PasswordPolicy(
        @JsonProperty("require_verified_email") @JsonAlias("requireVerifiedEmail")
        boolean requireVerifiedEmail) {}
