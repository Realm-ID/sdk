package dev.realmid.sdk.auth;

import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.RealmException;

import java.util.function.LongSupplier;

/**
 * Token manager for long-lived, single-identity clients — SPEC §4.2.1.
 *
 * <p>A convenience wrapper over {@link AuthClient#token(TokenRequest)} (§4.2)
 * for desktop apps, sync agents, and daemons that hold one refresh token and
 * need a continuously-valid access token without hand-rolling the refresh
 * loop. It is NOT for browser/BFF flows (use the middleware, §10) nor for the
 * SDK's internal platform session (§4.0).
 *
 * <p>Rotation safety: user refresh tokens are one-time-use and rotate on every
 * {@code /auth/token} (ADR-031). The manager therefore:
 * <ol>
 *   <li>single-flights concurrent acquisitions so two threads never present
 *       the same refresh token in parallel (which would trip reuse-detection
 *       and kill the session), and</li>
 *   <li>persists the rotated token through the {@link RefreshSink}
 *       <em>before</em> returning the new access token, so a crash can never
 *       strand the client on a consumed token.</li>
 * </ol>
 *
 * <p>Construct via {@link AuthClient#newTokenManager(String)} /
 * {@link AuthClient#newTokenManager(String, TokenManagerOptions)}. Thread-safe.
 */
public final class TokenManager {

    /**
     * How far ahead of expiry the manager proactively refreshes, so callers
     * under steady load never observe an expired access token.
     */
    private static final long REFRESH_LEAD_MS = 60_000L;

    /** Default access-token lifetime when the server omits expires_in (SPEC §4.0). */
    private static final long DEFAULT_ACCESS_TTL_MS = 5 * 60_000L;

    private final AuthClient auth;
    private final String tenantId;
    private final RefreshSink sink;
    private final LongSupplier now;

    private final Object lock = new Object();
    private String refreshTokenValue;
    private String cachedAccessToken = "";
    private long accessExpiresAtMs;
    /** Non-null while an acquisition is in flight; followers wait on it. */
    private TokenCall inflight;

    TokenManager(AuthClient auth, String refreshToken, TokenManagerOptions opts) {
        if (opts == null) opts = new TokenManagerOptions();
        this.auth = auth;
        this.refreshTokenValue = refreshToken;
        this.tenantId = opts.tenantId() == null ? "" : opts.tenantId();
        this.sink = opts.refreshSink();
        this.now = opts.clock() == null ? System::currentTimeMillis : opts.clock();
    }

    /**
     * Returns a valid access token, refreshing on demand. Returns the cached
     * token while it has at least {@value #REFRESH_LEAD_MS}ms of life;
     * otherwise performs (or joins) a single refresh. A
     * {@link ErrorCode#REFRESH_INVALID} error (SPEC §3.1) is terminal — the
     * caller should discard its stored refresh token and re-run its
     * login/enrollment flow. No retry, no API-key fallback.
     */
    public String accessToken() {
        TokenCall call;
        String refresh;
        synchronized (lock) {
            if (!cachedAccessToken.isEmpty() && accessExpiresAtMs - now.getAsLong() >= REFRESH_LEAD_MS) {
                return cachedAccessToken;
            }
            // Join an in-flight acquisition rather than starting a second one —
            // two parallel /auth/token calls on the same one-time-use refresh
            // token would trip reuse-detection.
            if (inflight != null) {
                call = inflight;
                refresh = null; // follower
            } else {
                call = new TokenCall();
                inflight = call;
                refresh = refreshTokenValue;
            }
        }
        if (refresh == null) {
            // Follower: wait for the leader's result outside the monitor.
            return await(call);
        }
        // Leader: perform the single acquisition outside the lock.
        try {
            String tok = fetch(refresh);
            call.complete(tok, null);
            return tok;
        } catch (RuntimeException e) {
            call.complete(null, e);
            throw e;
        } finally {
            synchronized (lock) {
                inflight = null;
            }
        }
    }

    /**
     * The manager's current refresh token (the latest rotated value). Useful
     * for a final persist on graceful shutdown.
     */
    public String refreshToken() {
        synchronized (lock) {
            return refreshTokenValue;
        }
    }

    private String await(TokenCall call) {
        call.awaitDone();
        if (call.error != null) {
            throw call.error;
        }
        return call.token;
    }

    /**
     * Performs one {@code /auth/token} acquisition. Only ever called by the
     * single-flight leader in {@link #accessToken()}.
     */
    private String fetch(String refresh) {
        // refresh_invalid (and any other error) bubbles up unchanged: a
        // long-lived user client has no API key to fall back on, so a dead
        // refresh is terminal — re-authentication is required.
        TokenResponse res = auth.token(TokenRequest.of(refresh, tenantId));
        if (res.accessToken() == null || res.accessToken().isEmpty()) {
            throw new RealmException(ErrorCode.SERVER_ERROR, "/auth/token returned empty access token");
        }
        // User refresh always rotates; guard anyway so a non-rotating realm
        // config (service/platform) doesn't blank the stored token.
        String rotated = (res.refreshToken() != null && !res.refreshToken().isEmpty())
                ? res.refreshToken()
                : refresh;

        // Commit the rotated token to memory BEFORE persisting, so if the sink
        // fails and the caller retries, the retry presents the live (just
        // issued, unconsumed) token rather than the consumed one.
        synchronized (lock) {
            refreshTokenValue = rotated;
        }

        // Persist-before-return: the sink must durably store the rotated token
        // before we hand the caller an access token to use (SPEC §4.2.1). If it
        // throws, fail the acquisition — do not cache the access token.
        if (sink != null) {
            try {
                sink.persist(rotated);
            } catch (Exception e) {
                throw new RealmException(ErrorCode.SERVER_ERROR,
                        "realmid token manager: persist rotated refresh token failed", e);
            }
        }

        long ttlMs = res.expiresIn() > 0 ? res.expiresIn() * 1000L : DEFAULT_ACCESS_TTL_MS;
        synchronized (lock) {
            cachedAccessToken = res.accessToken();
            accessExpiresAtMs = now.getAsLong() + ttlMs;
        }
        return res.accessToken();
    }

    /** A single in-flight acquisition shared by the leader and any followers. */
    private static final class TokenCall {
        private boolean done;
        private String token;
        private RuntimeException error;

        synchronized void complete(String token, RuntimeException error) {
            this.token = token;
            this.error = error;
            this.done = true;
            notifyAll();
        }

        synchronized void awaitDone() {
            boolean interrupted = false;
            while (!done) {
                try {
                    wait();
                } catch (InterruptedException e) {
                    interrupted = true;
                }
            }
            if (interrupted) Thread.currentThread().interrupt();
        }
    }
}
