package dev.realmid.sdk.auth;

import java.util.List;

/**
 * Result of {@link AuthClient#consumePasswordReset}. {@code revokedSids} (ADR-104 R-e) are the
 * sessions the issuer ended (the whole identity in the realm); the SDK has already written each
 * into the session store. Empty when none ended or the issuer predates the field.
 */
public record PasswordResetConsumed(List<String> revokedSids) {
    public PasswordResetConsumed {
        revokedSids = revokedSids == null ? List.of() : List.copyOf(revokedSids);
    }
}
