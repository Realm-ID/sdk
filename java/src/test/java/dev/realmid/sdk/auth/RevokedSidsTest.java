package dev.realmid.sdk.auth;

import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.me.MeAuth;
import dev.realmid.sdk.me.SetPasswordRequest;
import dev.realmid.sdk.session.MemorySessionStore;
import dev.realmid.sdk.session.SessionState;
import dev.realmid.sdk.session.SessionStateStore;
import dev.realmid.sdk.tokens.TokenRevokedException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ADR-104 R-e (java 0.51.0, mirrors go 0.65.0 revoked_sids_test.go): the three whole-identity
 * revokes return {@code revoked_sids}, and the SDK writes each into the SessionStore exactly as
 * logout does, so the next request carrying that session is refused.
 */
class RevokedSidsTest {
    private FakeServer fs;

    @AfterEach
    void tearDown() { if (fs != null) fs.close(); }

    private record Call(String name, Function<Realm, List<String>> run, boolean wrapped) {}

    private static final List<Call> CALLS = List.of(
            new Call("password_login_change_at_sign_in", r -> r.auth().passwordLogin(
                    PasswordLoginRequest.of("a@b.c", "old").withNewPassword("brand-new-pass-1")).revokedSids(), false),
            new Call("me_set_password", r -> r.me().setPassword(SetPasswordRequest.of("a-long-new-password"),
                    MeAuth.bearer("ub")).revokedSids(), true),
            new Call("consume_password_reset", r -> r.auth().consumePasswordReset("tok", "a-long-new-password")
                    .revokedSids(), true));

    private Realm realm(SessionStateStore store, Map<String, Object> extra, boolean wrap) throws IOException {
        fs = new FakeServer();
        fs.on("POST /auth/login", (ex, b) -> FakeServer.Reply.json(200, merge(Map.of(
                "access_token", "a", "refresh_token", "r", "expires_in", 300, "user", Map.of("id", "u")), extra, false)));
        fs.on("POST /auth/password/reset", (ex, b) -> FakeServer.Reply.json(200,
                merge(Map.of("status", "password_set"), extra, wrap)));
        fs.on("PUT /me/password", (ex, b) -> FakeServer.Reply.json(200,
                merge(Map.of("status", "updated"), extra, wrap)));
        return Realm.builder().sessionStore(store).realmId("01HREALM").apiKey("rk").baseUrl(fs.baseUrl)
                .audience("acme.test").build();
    }

    private static Map<String, Object> merge(Map<String, Object> base, Map<String, Object> extra, boolean wrap) {
        Map<String, Object> m = new LinkedHashMap<>(base);
        m.putAll(extra);
        return wrap ? Map.of("data", m) : m;
    }

    private static String tok(String sid) {
        Base64.Encoder e = Base64.getUrlEncoder().withoutPadding();
        String h = e.encodeToString("{\"alg\":\"none\"}".getBytes(StandardCharsets.UTF_8));
        String p = e.encodeToString(("{\"sid\":\"" + sid + "\",\"sub\":\"u1\",\"iat\":" + Instant.now().getEpochSecond()
                + "}").getBytes(StandardCharsets.UTF_8));
        return h + "." + p + ".sig";
    }

    private static boolean refused(Realm r, String sid) {
        try {
            r.tokens().gateRequest(tok(sid));
            return false;
        } catch (TokenRevokedException e) {
            return true;
        }
    }

    @Test
    void revokedSids_writtenToStoreAndTokenRefused() throws Exception {
        for (Call c : CALLS) {
            tearDown();
            Realm r = realm(new MemorySessionStore(), Map.of("revoked_sids", List.of("s1", "s2")), true);
            assertFalse(refused(r, "s1") || refused(r, "s2"), c.name() + ": precondition");
            assertEquals(List.of("s1", "s2"), c.run().apply(r), c.name());
            assertTrue(refused(r, "s1") && refused(r, "s2"), c.name() + ": listed sid must be refused");
            assertFalse(refused(r, "s3"), c.name() + ": unlisted sid keeps passing");
        }
    }

    @Test
    void revokedSids_emptyOrAbsentWritesNothing() throws Exception {
        Map<String, Map<String, Object>> shapes = Map.of(
                "empty", Map.of("revoked_sids", List.of()),
                "absent", Map.of(),
                "malformed", Map.of("revoked_sids", "s1"));
        for (Call c : CALLS) {
            for (var shape : shapes.entrySet()) {
                tearDown();
                Realm r = realm(new MemorySessionStore(), shape.getValue(), true);
                assertEquals(List.of(), c.run().apply(r), c.name() + "/" + shape.getKey());
                assertFalse(refused(r, "s1"), c.name() + "/" + shape.getKey());
            }
        }
    }

    /** A store whose revoke write always fails. */
    private static final class FailingStore implements SessionStateStore {
        private final MemorySessionStore d = new MemorySessionStore();
        @Override public void revokeSession(String key, Instant until) { throw new RuntimeException("store down"); }
        @Override public void raiseNotBefore(String key, Instant nb, Instant until) { d.raiseNotBefore(key, nb, until); }
        @Override public List<SessionState> sessionStates(List<String> keys) { return d.sessionStates(keys); }
        @Override public void evict(String prefix) { d.evict(prefix); }
        @Override public RefreshLock acquireRefreshLock(String key, Duration ttl) { return d.acquireRefreshLock(key, ttl); }
        @Override public void putRefreshResult(String key, byte[] result, Duration ttl) { d.putRefreshResult(key, result, ttl); }
        @Override public Optional<byte[]> getRefreshResult(String key) { return d.getRefreshResult(key); }
    }

    @Test
    void revokedSids_storeWriteErrorIsNotReturned() throws Exception {
        for (Call c : CALLS) {
            tearDown();
            Realm r = realm(new FailingStore(), Map.of("revoked_sids", List.of("s1")), true);
            List<String> got = assertDoesNotThrow(() -> c.run().apply(r), c.name());
            assertEquals(List.of("s1"), got, c.name());
        }
    }

    /** The issuer wraps /me/password and the consume in {"data":…}; a bare top-level list is not relied on. */
    @Test
    void revokedSids_unwrappedTopLevelIsNotRelied_onWrappedRoutes() throws Exception {
        for (Call c : CALLS) {
            if (!c.wrapped()) continue; // login is raw(...): bare is its real shape
            tearDown();
            Realm r = realm(new MemorySessionStore(), Map.of("revoked_sids", List.of("s1")), false);
            assertEquals(List.of(), c.run().apply(r), c.name());
            assertFalse(refused(r, "s1"), c.name());
        }
    }
}
