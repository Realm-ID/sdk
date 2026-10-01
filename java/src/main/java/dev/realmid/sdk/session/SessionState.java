package dev.realmid.sdk.session;

import java.time.Instant;

/**
 * The live state of one session-store key (SPEC §6.7.5). {@code notBefore} is
 * {@code null} for none.
 */
public record SessionState(boolean revoked, Instant notBefore) {

    /** The zero value: absent or expired. */
    public static final SessionState NONE = new SessionState(false, null);
}
