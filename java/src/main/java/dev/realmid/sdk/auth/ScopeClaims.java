package dev.realmid.sdk.auth;

import java.util.List;

/**
 * The retry runner for {@link ScopesHandler}.
 *
 * <p>The policy is SHARED with {@link ProductRoles} on purpose — same three
 * attempts, same ~50ms/~150ms backoff, read from that class's constants rather
 * than copied. Two retry budgets on one mint path would compound into a latency
 * ceiling nobody chose: the two handlers run in sequence, so the worst case is
 * the sum, and keeping them identical is what makes that sum predictable.
 */
final class ScopeClaims {

    private ScopeClaims() {}

    /**
     * Runs a handler with the shared retry policy.
     *
     * <p>Returns {@code null} when no handler is configured: the claim is
     * omitted and this is NOT an error. Making it mandatory would break every
     * existing integration on upgrade for a feature they did not ask for.
     */
    static List<String> resolve(ScopesHandler handler, String tenantId, String userId) {
        if (handler == null) return null;
        Throwable last = null;
        for (int attempt = 0; attempt < ProductRoles.ATTEMPTS; attempt++) {
            if (attempt > 0) {
                try {
                    Thread.sleep(ProductRoles.BACKOFF_MS[attempt - 1]);
                } catch (InterruptedException ie) {
                    // ABANDON on interruption rather than swallowing it — the
                    // reason ProductRoles.resolve states.
                    Thread.currentThread().interrupt();
                    throw new ScopesException(tenantId, userId, attempt, ie);
                }
            }
            try {
                return handler.resolve(tenantId, userId);
            } catch (Exception e) {
                last = e;
            }
        }
        throw new ScopesException(tenantId, userId, ProductRoles.ATTEMPTS, last);
    }
}
