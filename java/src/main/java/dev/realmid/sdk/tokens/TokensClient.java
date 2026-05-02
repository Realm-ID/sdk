package dev.realmid.sdk.tokens;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.RealmException;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.Base64;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;

/**
 * Access-token revocation cache (SPEC §6.7).
 *
 * <p>Server-side, RealmID revokes refresh tokens via {@code POST
 * /auth/logout}. Access tokens are stateless RS256 JWTs, so once minted
 * they verify on signature + exp alone until natural expiry. This
 * client adds partner-side defense-in-depth: on logout, the access
 * token's {@code jti} is parked in an in-memory cache with TTL =
 * {@code exp - now()}. Subsequent requests presenting that jti are
 * rejected without a server round trip.
 *
 * <p><b>Multi-pod caveat:</b> this cache is per-process. A logout
 * served by pod A does not propagate to pod B; a stolen access token
 * can still be replayed against pod B for up to its remaining TTL.
 * v1.1 will ship a Redis-backed swap-in.
 *
 * <p>Concurrent-safe via {@link ConcurrentHashMap}; the four public
 * methods are non-blocking outside of map ops.
 */
public final class TokensClient {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final ConcurrentHashMap<String, Long> entries = new ConcurrentHashMap<>();
    private final Clock clock;

    public TokensClient() {
        this(Clock.systemUTC());
    }

    public TokensClient(Clock clock) {
        this.clock = clock == null ? Clock.systemUTC() : clock;
    }

    /**
     * Extract {@code jti} and {@code exp} from {@code accessToken} and
     * cache the jti with TTL = {@code exp - now()}. No-op when the
     * token is malformed, the jti/exp claims are missing, or exp is
     * already in the past.
     */
    public void markRevoked(String accessToken) {
        Peek p = peek(accessToken);
        if (p == null || p.jti.isEmpty() || p.expMs == 0) return;
        if (p.expMs <= clock.millis()) return;
        entries.put(p.jti, p.expMs);
    }

    /**
     * Returns true iff {@code accessToken}'s jti is cached and the
     * entry has not expired. Lazy GC: stale entries are evicted on
     * read. Returns false for malformed input.
     */
    public boolean isRevoked(String accessToken) {
        Peek p = peek(accessToken);
        if (p == null || p.jti.isEmpty()) return false;
        Long exp = entries.get(p.jti);
        if (exp == null) return false;
        if (exp <= clock.millis()) {
            entries.remove(p.jti, exp);
            return false;
        }
        return true;
    }

    /**
     * Per-request gate. Partners' inbound middleware should call this
     * before forwarding to RealmID. Throws {@link TokenRevokedException}
     * when the jti is cached.
     */
    public void gateRequest(String accessToken) {
        if (isRevoked(accessToken)) {
            throw new TokenRevokedException();
        }
    }

    /**
     * Wraps a logout function so the access token's jti is marked
     * revoked on <b>either success or transport failure</b>.
     * Rationale: partner backend should fail closed — if RealmID is
     * unreachable, the access token still gets blackholed locally.
     *
     * <p>The wrapped function takes (accessToken, logoutRequest) and
     * delegates to {@code logoutFn}; any exception thrown by
     * {@code logoutFn} propagates after the local cache update.
     *
     * @param logoutFn the underlying logout call (e.g. a method
     *                 reference to {@code AuthClient::logout}).
     * @param <REQ>    logout-request type (typically {@code LogoutRequest}).
     */
    public <REQ> WrappedLogout<REQ> revokeOnLogout(Consumer<REQ> logoutFn) {
        return (accessToken, req) -> {
            Peek p = peek(accessToken);
            try {
                logoutFn.accept(req);
            } finally {
                if (p != null && !p.jti.isEmpty() && p.expMs > clock.millis()) {
                    entries.put(p.jti, p.expMs);
                }
            }
        };
    }

    /** Drop a single jti, or all entries when {@code jti == null}. */
    public void evict(String jti) {
        if (jti == null) entries.clear();
        else entries.remove(jti);
    }

    /** Current entry count. Useful for tests + instrumentation. */
    public int size() {
        return entries.size();
    }

    /**
     * Functional shape returned by {@link #revokeOnLogout(Consumer)}.
     * Caller passes the access token + a request payload; the wrapper
     * runs the network logout, then caches the jti regardless of
     * outcome.
     */
    @FunctionalInterface
    public interface WrappedLogout<REQ> {
        void invoke(String accessToken, REQ req);
    }

    private static final class Peek {
        final String jti;
        final long expMs;
        Peek(String jti, long expMs) {
            this.jti = jti;
            this.expMs = expMs;
        }
    }

    /** Decode a JWT payload (no signature check) and pull jti + exp.
     *  Returns null on malformed input. */
    private static Peek peek(String jwt) {
        if (jwt == null) return null;
        String[] parts = jwt.split("\\.");
        if (parts.length != 3) return null;
        try {
            byte[] raw = Base64.getUrlDecoder().decode(parts[1]);
            JsonNode payload = MAPPER.readTree(new String(raw, StandardCharsets.UTF_8));
            String jti = payload.path("jti").asText("");
            long expSec = payload.path("exp").asLong(0L);
            return new Peek(jti, expSec > 0 ? expSec * 1000L : 0L);
        } catch (RuntimeException | java.io.IOException e) {
            return null;
        }
    }

    /** Internal: surface a RealmException for malformed input where it
     *  matters (callers can pre-validate). Currently unused but kept
     *  for parity with TS / Go shapes. */
    @SuppressWarnings("unused")
    private static RealmException malformed() {
        return new RealmException(ErrorCode.MALFORMED, "tokens: malformed access token");
    }
}
