package dev.realmid.sdk.me;

import java.util.List;

/**
 * Result of {@link MeClient#setPassword}. {@code revokedSids} (ADR-104 R-e) are the sessions the
 * issuer ended across the person's whole identity in the realm, never the calling session; the
 * SDK has already written each into the session store. Empty when none ended or the issuer
 * predates the field.
 */
public record PasswordSet(String status, List<String> revokedSids) {
    public PasswordSet {
        revokedSids = revokedSids == null ? List.of() : List.copyOf(revokedSids);
    }
}
