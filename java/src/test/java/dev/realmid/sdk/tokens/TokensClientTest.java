package dev.realmid.sdk.tokens;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.realmid.sdk.ErrorCode;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

class TokensClientTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static String makeJwt(Map<String, Object> claims) throws Exception {
        Base64.Encoder enc = Base64.getUrlEncoder().withoutPadding();
        String header = enc.encodeToString("{\"alg\":\"RS256\",\"typ\":\"JWT\"}".getBytes(StandardCharsets.UTF_8));
        String payload = enc.encodeToString(MAPPER.writeValueAsBytes(claims));
        return header + "." + payload + ".sig";
    }

    private static Clock fixedClock(long ms) {
        return Clock.fixed(Instant.ofEpochMilli(ms), ZoneOffset.UTC);
    }

    @Test
    void markAndIsRevokedHappyPath() throws Exception {
        long now = 1_700_000_000_000L;
        TokensClient c = new TokensClient(fixedClock(now));
        String tok = makeJwt(Map.of("jti", "abc", "exp", (now / 1000) + 900));
        assertFalse(c.isRevoked(tok));
        c.markRevoked(tok);
        assertTrue(c.isRevoked(tok));
    }

    @Test
    void ttlExpiryEvictsLazily() throws Exception {
        long now = 1_700_000_000_000L;
        AtomicReference<Clock> clock = new AtomicReference<>(fixedClock(now));
        TokensClient c = new TokensClient(new Clock() {
            @Override public java.time.ZoneId getZone() { return ZoneOffset.UTC; }
            @Override public Clock withZone(java.time.ZoneId z) { return this; }
            @Override public Instant instant() { return clock.get().instant(); }
        });
        String tok = makeJwt(Map.of("jti", "abc", "exp", (now / 1000) + 60));
        c.markRevoked(tok);
        assertEquals(1, c.size());
        clock.set(fixedClock(now + 120_000));
        assertFalse(c.isRevoked(tok));
        assertEquals(0, c.size());
    }

    @Test
    void markRevokedNoopOnMissingClaims() throws Exception {
        long now = 1_700_000_000_000L;
        TokensClient c = new TokensClient(fixedClock(now));
        c.markRevoked(makeJwt(Map.of("exp", (now / 1000) + 900))); // no jti
        c.markRevoked(makeJwt(Map.of("jti", "abc")));               // no exp
        c.markRevoked(makeJwt(Map.of("jti", "abc", "exp", (now / 1000) - 60))); // past
        assertEquals(0, c.size());
    }

    @Test
    void gateRequestThrowsOnCachedJti() throws Exception {
        long now = 1_700_000_000_000L;
        TokensClient c = new TokensClient(fixedClock(now));
        String tok = makeJwt(Map.of("jti", "abc", "exp", (now / 1000) + 900));
        // not cached → no throw
        c.gateRequest(tok);
        c.markRevoked(tok);
        TokenRevokedException e = assertThrows(TokenRevokedException.class, () -> c.gateRequest(tok));
        assertEquals(ErrorCode.UNAUTHORIZED, e.getCode());
        assertEquals(Boolean.TRUE, e.getDetails().get("revoked"));
    }

    @Test
    void revokeOnLogoutCachesEvenOnFailure() throws Exception {
        long now = 1_700_000_000_000L;
        TokensClient c = new TokensClient(fixedClock(now));
        String tok = makeJwt(Map.of("jti", "abc", "exp", (now / 1000) + 900));

        TokensClient.WrappedLogout<String> wrapped = c.revokeOnLogout(req -> {
            throw new RuntimeException("RI unreachable");
        });
        RuntimeException ex = assertThrows(RuntimeException.class, () -> wrapped.invoke(tok, "ignored"));
        assertEquals("RI unreachable", ex.getMessage());
        assertTrue(c.isRevoked(tok), "fail-closed: jti should be cached even on network failure");
    }

    @Test
    void revokeOnLogoutCachesOnSuccess() throws Exception {
        long now = 1_700_000_000_000L;
        TokensClient c = new TokensClient(fixedClock(now));
        String tok = makeJwt(Map.of("jti", "abc", "exp", (now / 1000) + 900));

        int[] calls = {0};
        TokensClient.WrappedLogout<String> wrapped = c.revokeOnLogout(req -> calls[0]++);
        wrapped.invoke(tok, "anything");
        assertEquals(1, calls[0]);
        assertTrue(c.isRevoked(tok));
    }

    @Test
    void cacheDoesNotGrowUnderRepeatedMarks() throws Exception {
        long now = 1_700_000_000_000L;
        TokensClient c = new TokensClient(fixedClock(now));
        String tok = makeJwt(Map.of("jti", "abc", "exp", (now / 1000) + 900));
        for (int i = 0; i < 100; i++) c.markRevoked(tok);
        assertEquals(1, c.size());
    }
}
