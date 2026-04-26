package dev.realmid.sdk.middleware;

import java.time.Duration;

/**
 * One entry in {@link MiddlewareConfig#mfaProtectedPaths()}. Per-route MFA
 * freshness policy (SPEC §10.4):
 * <ul>
 *   <li>{@link #maxAge()} — accept any token whose {@code mfa_at} claim is
 *       at most that old. {@code null} or {@link Duration#ZERO} means "use
 *       the realm-default" ({@link MiddlewareConfig#mfaDefaultMaxAge()}).</li>
 *   <li>{@link #requireFresh()} — require {@code mfa_at} within ~30 s. Use
 *       for irreversible / high-risk operations. A legacy {@code amr} /
 *       {@code acr}-only token (no {@code mfa_at}) cannot satisfy this —
 *       the gate has no way to prove freshness.</li>
 * </ul>
 */
public final class MFARule {

    private final String path;
    private final Duration maxAge;
    private final boolean requireFresh;

    public MFARule(String path, Duration maxAge, boolean requireFresh) {
        if (path == null || path.isEmpty()) {
            throw new IllegalArgumentException("MFARule.path required");
        }
        this.path = path;
        this.maxAge = maxAge;
        this.requireFresh = requireFresh;
    }

    public String path() { return path; }
    /** May be null — meaning "use the realm-default freshness window". */
    public Duration maxAge() { return maxAge; }
    public boolean requireFresh() { return requireFresh; }

    /** Sugar: {@code path} only, inherits the realm-default freshness window. */
    public static MFARule of(String path) {
        return new MFARule(path, null, false);
    }

    /** Sugar: per-route {@code maxAge}. */
    public static MFARule of(String path, Duration maxAge) {
        return new MFARule(path, maxAge, false);
    }

    /** Sugar: {@code requireFresh = true}. */
    public static MFARule requireFresh(String path) {
        return new MFARule(path, null, true);
    }
}
