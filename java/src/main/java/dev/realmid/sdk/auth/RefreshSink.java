package dev.realmid.sdk.auth;

/**
 * Durably persists a rotated refresh token (SPEC §4.2.1). The
 * {@link TokenManager} calls it after each successful {@code /auth/token} and
 * <strong>blocks</strong> on it: only if it returns normally does the manager
 * cache and hand back the new access token. A sink that throws fails the
 * acquisition (the caller's durable store still holds the previous token, and
 * the manager has already committed the rotated token to memory so a retry
 * presents the live, unconsumed token).
 *
 * <p>This persist-before-return ordering is the whole point of the sink: a
 * best-effort / fire-and-forget sink does <strong>not</strong> satisfy the
 * crash-safety contract.
 */
@FunctionalInterface
public interface RefreshSink {
    /**
     * Durably store {@code newRefreshToken}. Throw to fail the acquisition.
     *
     * @param newRefreshToken the rotated refresh token to persist
     * @throws Exception if the token could not be durably stored
     */
    void persist(String newRefreshToken) throws Exception;
}
