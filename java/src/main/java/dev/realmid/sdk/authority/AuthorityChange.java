package dev.realmid.sdk.authority;

import java.time.Duration;

/**
 * One authority change a partner is announcing through
 * {@code Realm.notifyAuthorityChanged} (ADR-107 D7).
 *
 * @param subject        the {@code sub} claim of the affected principal — on
 *                       this platform the PER-MEMBERSHIP users-row id, not a
 *                       person (D4). Demoting someone in org A deliberately
 *                       leaves their org B token untouched; a partner that
 *                       passes an identity id here silently propagates nothing.
 * @param intent         required, and validated rather than inferred (D11)
 * @param accessTokenTtl overrides the realm's access-token lifetime when sizing
 *                       the cache entry (D6). {@code null} or non-positive uses
 *                       {@link #DEFAULT_ACCESS_TTL}. Set it when the realm's
 *                       {@code access_ttl_seconds} differs from the service
 *                       default, or entries expire while tokens minted before
 *                       the change are still verifiable.
 */
public record AuthorityChange(String subject, Intent intent, Duration accessTokenTtl) {

    /**
     * What the partner did. REQUIRED and validated rather than inferred (D11):
     * demotion does not evict the session, and a method that guessed would
     * eventually guess "log them out" on a routine role edit. Removing someone
     * from an org is a different intent with a different consequence — that one
     * is {@code realm.sessions().revokeUser(...)} (ADR-080).
     */
    public enum Intent {
        /** Authority narrowed. The principal stays signed in and refreshes into a narrower token (D11). */
        DEMOTED("demoted"),
        /** Authority widened. Without this the grant has landed and the product says no for up to access_ttl_seconds (C3). */
        PROMOTED("promoted");

        private final String wire;

        Intent(String wire) { this.wire = wire; }

        public String wire() { return wire; }
    }

    /** The issuer's service-level access-token lifetime, which sizes the entry under D6. */
    public static final Duration DEFAULT_ACCESS_TTL = Duration.ofMinutes(15);

    /**
     * D8's allowance. The marker is stamped as {@code now − SKEW_ALLOWANCE},
     * NEVER as bare {@code now}.
     *
     * <p>The load-bearing constant of the whole design. Erring EARLY
     * over-rejects a handful of very recently minted tokens — one extra,
     * harmless refresh each. Erring LATE places the marker in the ISSUER's
     * future, so a freshly-minted token fails the very check that caused the
     * refresh, and every replica refreshes, fails and refreshes again against
     * the mint endpoint. ADR-107 C5 calls that loop a worse outcome than the
     * 900-second window it closes.
     */
    public static final Duration SKEW_ALLOWANCE = Duration.ofSeconds(30);

    /** Convenience: a change with the default TTL. */
    public AuthorityChange(String subject, Intent intent) {
        this(subject, intent, null);
    }
}
