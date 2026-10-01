package dev.realmid.sdk.tokens;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.realmid.sdk.session.MemorySessionStore;
import dev.realmid.sdk.session.SessionState;
import dev.realmid.sdk.session.SessionStateStore;
import org.junit.jupiter.api.Test;

import java.lang.System.Logger;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.ResourceBundle;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.*;

/** SPEC6_7: the session-keyed revocation / supersession cache (v0.63.0). */
class TokensClientTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final long T0 = 1_700_000_000L;
    private static final long H = 24 * 3600;

    /** Mutable clock, in epoch seconds. */
    static final class Clk extends Clock {
        final AtomicLong sec = new AtomicLong(T0);
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId z) { return this; }
        @Override public Instant instant() { return Instant.ofEpochSecond(sec.get()); }
    }

    static final class Log implements Logger {
        final List<String> warnings = new ArrayList<>();
        @Override public String getName() { return "t"; }
        @Override public boolean isLoggable(Level l) { return true; }
        @Override public void log(Level l, ResourceBundle b, String msg, Throwable t) {
            if (l == Level.WARNING) warnings.add(msg);
        }
        @Override public void log(Level l, ResourceBundle b, String fmt, Object... p) {
            if (l == Level.WARNING) warnings.add(java.text.MessageFormat.format(fmt, p));
        }
    }

    /** Records every call; can fail reads or writes. */
    static final class Spy implements SessionStateStore {
        final SessionStateStore inner;
        final List<String> calls = new ArrayList<>();
        boolean failReads, failWrites;
        Spy(SessionStateStore inner) { this.inner = inner; }
        @Override public void revokeSession(String k, Instant until) {
            calls.add("revoke " + k);
            if (failWrites) throw new IllegalStateException("down");
            inner.revokeSession(k, until);
        }
        @Override public void raiseNotBefore(String k, Instant nb, Instant until) {
            calls.add("raise " + k);
            if (failWrites) throw new IllegalStateException("down");
            inner.raiseNotBefore(k, nb, until);
        }
        @Override public List<SessionState> sessionStates(List<String> keys) {
            calls.add("states " + keys);
            if (failReads) throw new IllegalStateException("down");
            return inner.sessionStates(keys);
        }
        @Override public void evict(String prefix) { calls.add("evict " + prefix); inner.evict(prefix); }
        @Override public RefreshLock acquireRefreshLock(String k, Duration ttl) { return inner.acquireRefreshLock(k, ttl); }
        @Override public void putRefreshResult(String k, byte[] r, Duration ttl) { inner.putRefreshResult(k, r, ttl); }
        @Override public java.util.Optional<byte[]> getRefreshResult(String k) { return inner.getRefreshResult(k); }
    }

    private final Clk clk = new Clk();
    private final MemorySessionStore mem = new MemorySessionStore(clk);
    private final Spy spy = new Spy(mem);
    private final Log log = new Log();
    private final AtomicInteger modeFetches = new AtomicInteger();
    private volatile String mode = "concurrent";
    private final Function<String, String> modeOf = iss -> { modeFetches.incrementAndGet(); return mode; };
    private final TokensClient c = new TokensClient(spy, clk, log, modeOf);

    private static String jwt(Map<String, Object> claims) throws Exception {
        Base64.Encoder enc = Base64.getUrlEncoder().withoutPadding();
        String header = enc.encodeToString("{\"alg\":\"RS256\",\"typ\":\"JWT\"}".getBytes(StandardCharsets.UTF_8));
        return header + "." + enc.encodeToString(MAPPER.writeValueAsBytes(claims)) + ".sig";
    }

    private static String tok(String sid, String jti, String sub, Long iat, Long exp) throws Exception {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("iss", "https://auth.realmid.dev/r1");
        if (sid != null) m.put("sid", sid);
        if (jti != null) m.put("jti", jti);
        if (sub != null) m.put("sub", sub);
        if (iat != null) m.put("iat", iat);
        if (exp != null) m.put("exp", exp);
        return jwt(m);
    }

    // ---- 18-23a: key + lifetime ----

    @Test
    void SPEC6_7_sessionKeyPrefersSidThenJtiThenNone() throws Exception {
        assertEquals("S", dev.realmid.sdk.session.SessionKeys.peek(tok("S", "J", "u", 1L, 1L)).sessionKey());
        assertEquals("J", dev.realmid.sdk.session.SessionKeys.peek(tok(null, "J", "u", 1L, 1L)).sessionKey());
        assertEquals("J", dev.realmid.sdk.session.SessionKeys.peek(tok("", "J", "u", 1L, 1L)).sessionKey());
        assertNull(dev.realmid.sdk.session.SessionKeys.peek(tok(null, null, "u", 1L, 1L)).sessionKey());
    }

    @Test
    void SPEC6_7_markRevokedRefusesAnotherTokenOfTheSameSidDifferentJti() throws Exception {
        String t1 = tok("S", "j1", "u", T0, T0 + 900);
        String t2 = tok("S", "j2", "u", T0 + 5, T0 + 905);
        assertFalse(c.isRevoked(t2)); // positive control
        c.markRevoked(t1);
        assertTrue(c.isRevoked(t2));
        assertFalse(c.isRevoked(tok("OTHER", "j3", "u", T0, T0 + 900)));
    }

    @Test
    void SPEC6_7_jtiOnlyTokensAndNoKeyTokens() throws Exception {
        c.markRevoked(tok(null, "J", "u", T0, T0 + 900));
        assertTrue(c.isRevoked(tok(null, "J", "u", T0 + 1, T0 + 901)));
        TokensClient fresh = new TokensClient(new MemorySessionStore(clk), clk);
        fresh.markRevoked(tok(null, null, "u", T0, T0 + 900));
        assertFalse(fresh.isRevoked(tok(null, null, "u", T0, T0 + 900)));
        assertFalse(fresh.isRevoked("garbage"));
        assertFalse(fresh.isRevoked(null));
    }

    @Test
    void SPEC6_7_revocationLivesTwentyFourHoursFromNowEvenForAnExpiredToken() throws Exception {
        c.markRevoked(tok("S", "j", "u", T0 - 7200, T0 - 3600)); // expired token
        String live = tok("S", "j2", "u", T0, T0 + 900);
        assertTrue(c.isRevoked(live));
        clk.sec.set(T0 + H - 1);
        assertTrue(c.isRevoked(live));
        clk.sec.set(T0 + H);
        assertFalse(c.isRevoked(live));
    }

    @Test
    void SPEC6_7_laterMarkNeverShortensAndNeedsNoTokenTimes() throws Exception {
        c.markRevoked(tok("S", null, "u", null, null)); // no exp/iat: still recorded
        String t = tok("S", "x", "u", T0, T0 + 900);
        assertTrue(c.isRevoked(t));
        clk.sec.set(T0 + 3600);
        c.markRevoked(tok("S", "j", "u", T0, T0 + 900));
        clk.sec.set(T0 + H + 1800); // beyond the first write, inside the second
        assertTrue(c.isRevoked(t));
    }

    @Test
    void SPEC6_7_revokeSessionByKeyRefusesEverySessionTokenAndEmptyIsNoop() throws Exception {
        c.revokeSession("");
        c.revokeSession(null);
        assertFalse(c.isRevoked(tok("S", "j", "u", T0, T0 + 900)));
        c.revokeSession("S");
        assertTrue(c.isRevoked(tok("S", "j9", "u", T0, T0 + 900)));
    }

    // ---- 24-27: supersession ----

    @Test
    void SPEC6_7_recordRefreshRefusesStrictlyOlderIat() throws Exception {
        c.recordRefresh(tok("S", "j", "u", T0, T0 + 900));
        assertTrue(c.isRevoked(tok("S", "a", "u", T0 - 1, T0 + 900)));
        assertFalse(c.isRevoked(tok("S", "b", "u", T0, T0 + 900)));
        assertFalse(c.isRevoked(tok("S", "c", "u", T0 + 1, T0 + 900)));
    }

    @Test
    void SPEC6_7_recordRefreshIsMonotonicAndExtendsLifetime() throws Exception {
        c.recordRefresh(tok("S", "j", "u", T0 + 10, T0 + 900));
        clk.sec.set(T0 + 100);
        c.recordRefresh(tok("S", "j", "u", T0 + 5, T0 + 900)); // older iat, later write
        assertTrue(c.isRevoked(tok("S", "a", "u", T0 + 9, T0 + 900)), "nb stays at T0+10");
        clk.sec.set(T0 + 100 + H - 1);
        assertTrue(c.isRevoked(tok("S", "a", "u", T0 + 9, T0 + H)));
        clk.sec.set(T0 + 100 + H);
        assertFalse(c.isRevoked(tok("S", "a", "u", T0 + 9, T0 + H)));
    }

    @Test
    void SPEC6_7_liveMarkAndTokenWithoutIatIsRefused() throws Exception {
        c.recordRefresh(tok("S", "j", "u", T0, T0 + 900));
        assertTrue(c.isRevoked(tok("S", "x", "u", null, T0 + 900)));
    }

    @Test
    void SPEC6_7_gateRequestThrowsTheSameErrorForRevokedAndSuperseded() throws Exception {
        c.recordRefresh(tok("S", "j", "u", T0, T0 + 900));
        TokenRevokedException e = assertThrows(TokenRevokedException.class,
                () -> c.gateRequest(tok("S", "a", "u", T0 - 5, T0 + 900)));
        assertEquals(Boolean.TRUE, e.getDetails().get("revoked"));
        assertEquals(dev.realmid.sdk.ErrorCode.UNAUTHORIZED, e.getCode());
        c.gateRequest(tok("S", "b", "u", T0, T0 + 900));
    }

    // ---- 29-32: logout wrapper, evict, store errors ----

    @Test
    void SPEC6_7_revokeOnLogoutMarksOnFailureAndPeeksBeforeTheCall() throws Exception {
        String t = tok("S", "j", "u", T0, T0 + 900);
        String[] holder = {t};
        TokensClient.WrappedLogout<String> w = c.revokeOnLogout(req -> {
            holder[0] = "mutated";
            throw new IllegalStateException("network");
        });
        assertThrows(IllegalStateException.class, () -> w.invoke(t, "r"));
        assertTrue(c.isRevoked(tok("S", "z", "u", T0, T0 + 900)));
        TokensClient ok = new TokensClient(new MemorySessionStore(clk), clk);
        ok.revokeOnLogout((String r) -> {}).invoke(t, "r");
        assertTrue(ok.isRevoked(t));
    }

    @Test
    void SPEC6_7_evictClearsRevokedSessionMarkAndEveryMembershipMark() throws Exception {
        c.markRevoked(tok("S", "j", "u", T0, T0 + 900));
        c.recordRefresh(tok("S", "j", "u1", T0, T0 + 900));
        c.recordRefresh(tok("S", "j", "u2", T0, T0 + 900));
        c.recordRefresh(tok("S2", "j", "u1", T0, T0 + 900));
        c.evict("S");
        assertFalse(c.isRevoked(tok("S", "n", "u1", T0 - 1, T0 + 900)));
        assertFalse(c.isRevoked(tok("S", "n", "u2", T0 - 1, T0 + 900)));
        assertTrue(c.isRevoked(tok("S2", "n", "u1", T0 - 1, T0 + 900)), "other session untouched");
        // the spy is not the in-memory store, so go through a client on `mem` itself
        TokensClient direct = new TokensClient(mem, clk, log, modeOf);
        direct.evict("");
        assertFalse(direct.isRevoked(tok("S2", "n", "u1", T0 - 1, T0 + 900)), "empty clears the in-memory store");
    }

    @Test
    void SPEC6_7_evictEmptyOnASharedStoreIsNoopWithOneWarning() {
        c.evict("");
        assertTrue(spy.calls.stream().noneMatch(s -> s.startsWith("evict")), spy.calls.toString());
        assertEquals(1, log.warnings.size());
    }

    @Test
    void SPEC6_7_storeReadErrorFailsOpenWithOneWarning() throws Exception {
        c.markRevoked(tok("S", "j", "u", T0, T0 + 900));
        spy.failReads = true;
        assertFalse(c.isRevoked(tok("S", "j2", "u", T0, T0 + 900)));
        assertEquals(1, log.warnings.size());
    }

    @Test
    void SPEC6_7_storeWriteErrorIsLoggedNeverThrown() throws Exception {
        spy.failWrites = true;
        c.markRevoked(tok("S", "j", "u", T0, T0 + 900));
        c.revokeSession("S");
        c.recordRefresh(tok("S", "j", "u", T0, T0 + 900));
        assertTrue(log.warnings.size() >= 3, log.warnings.toString());
    }

    // ---- 36a / 37-37h: keys and org-session mode ----

    @Test
    void SPEC6_7_5_keyNamespacesAreExactAndEscaped() throws Exception {
        c.markRevoked(tok("a|b%", "j", "c", T0, T0 + 900));
        c.recordRefresh(tok("a|b%", "j", "c", T0, T0 + 900));
        assertTrue(spy.calls.contains("revoke realmid:v1:rev|a%7Cb%25"), spy.calls.toString());
        assertTrue(spy.calls.contains("raise realmid:v1:nb|a%7Cb%25"));
        assertTrue(spy.calls.contains("raise realmid:v1:nb|a%7Cb%25|c"));
        assertNotEquals(
                dev.realmid.sdk.session.SessionKeys.membershipMarkKey("a|b", "c"),
                dev.realmid.sdk.session.SessionKeys.membershipMarkKey("a", "b|c"));
        assertTrue(spy.calls.stream().noneMatch(s -> s.contains("realmid:v1:sub|")));
    }

    @Test
    void SPEC6_7_3_recordRefreshWritesBothMarksEveryTimeAndNoopsWithoutSub() throws Exception {
        c.recordRefresh(tok("S", "j", "u", T0, T0 + 900));
        assertEquals(2, spy.calls.stream().filter(s -> s.startsWith("raise")).count());
        spy.calls.clear();
        c.recordRefresh(tok("S", "j", null, T0, T0 + 900));
        c.recordRefresh(tok(null, null, "u", T0, T0 + 900));
        c.recordRefresh(tok("S", "j", "u", null, T0 + 900));
        assertTrue(spy.calls.isEmpty(), spy.calls.toString());
    }

    @Test
    void SPEC6_7_3_concurrentModeIsPerMembership() throws Exception {
        c.recordRefresh(tok("S", "j", "globex", T0, T0 + 900));
        assertFalse(c.isRevoked(tok("S", "a", "acme", T0 - 5, T0 + 900)), "other org passes");
        assertTrue(c.isRevoked(tok("S", "g", "globex", T0 - 5, T0 + 900)), "older same-org refused");
    }

    @Test
    void SPEC6_7_3_exclusiveModeIsPerSessionAndSwitchesAtCheckTime() throws Exception {
        c.recordRefresh(tok("S", "j", "globex", T0, T0 + 900));
        String acme = tok("S", "a", "acme", T0 - 5, T0 + 900);
        assertFalse(c.isRevoked(acme));
        mode = "exclusive"; // marks were recorded under concurrent; no re-recording
        TokensClient c2 = new TokensClient(spy, clk, log, modeOf);
        assertTrue(c2.isRevoked(acme));
        assertTrue(c2.isRevoked(tok("S", "g", "globex", T0 - 5, T0 + 900)));
    }

    @Test
    void SPEC6_7_3_modeIsNeverFetchedWithoutALiveMark() throws Exception {
        assertFalse(c.isRevoked(tok("S", "a", "acme", T0, T0 + 900)));
        assertEquals(0, modeFetches.get());
        c.markRevoked(tok("S", "a", "acme", T0, T0 + 900));
        assertTrue(c.isRevoked(tok("S", "b", "acme", T0, T0 + 900)));
        assertEquals(0, modeFetches.get(), "a revoked entry decides without the mode");
    }

    @Test
    void SPEC6_7_integrationTokenKeyedByItsOwnJti() throws Exception {
        String i1 = tok(null, "int-1", null, T0, T0 + 900);
        c.markRevoked(i1);
        assertTrue(c.isRevoked(i1));
        assertFalse(c.isRevoked(tok(null, "int-2", null, T0, T0 + 900)));
    }
}
