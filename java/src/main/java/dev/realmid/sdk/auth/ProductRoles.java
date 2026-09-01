package dev.realmid.sdk.auth;

import java.util.List;

/**
 * The ADR-102 D11 retry policy, shared by every mint path.
 *
 * <p>A role lookup is a DB read and a DB read fails transiently, so the refusal
 * is the LAST resort rather than the first response. Three attempts with ~50ms
 * then ~150ms of backoff puts a ceiling of roughly 200ms of added latency on the
 * login hot path with a human waiting — part of the decision, not an
 * implementation detail. Deliberately NOT exponential-unbounded.
 */
final class ProductRoles {

    static final int ATTEMPTS = 3;
    static final long[] BACKOFF_MS = {50L, 150L};

    private ProductRoles() {}

    /**
     * Runs a handler with the D11 retry policy.
     *
     * <p>Returns {@code null} when no handler is configured: the claim is
     * omitted and this is NOT an error. Making the handler mandatory would break
     * every existing integration on upgrade for a feature they did not ask for,
     * on top of the {@code login} behaviour change D10 already imposes.
     *
     * <p>EVERY error is retried and there is no taxonomy. The SDK cannot tell
     * your transient DB error from a permanent one, and inventing a sentinel for
     * you to wrap fails ADR-102 C0.1's bar.
     */
    static List<String> resolve(ProductRolesHandler handler, String tenantId, String userId) {
        if (handler == null) return null;
        Throwable last = null;
        for (int attempt = 0; attempt < ATTEMPTS; attempt++) {
            if (attempt > 0) {
                try {
                    Thread.sleep(BACKOFF_MS[attempt - 1]);
                } catch (InterruptedException ie) {
                    // ABANDON on interruption rather than swallowing it. A retry
                    // loop that outlives its caller turns a client timeout into
                    // a server-side pileup, and clearing the flag would hide the
                    // cancellation from everything above us.
                    Thread.currentThread().interrupt();
                    throw new ProductRolesException(tenantId, userId, attempt, ie);
                }
            }
            try {
                return handler.resolve(tenantId, userId);
            } catch (Exception e) {
                last = e;
            }
        }
        throw new ProductRolesException(tenantId, userId, ATTEMPTS, last);
    }
}
