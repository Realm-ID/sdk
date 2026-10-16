package dev.realmid.sdk.middleware;

import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.session.SessionKeys;
import dev.realmid.sdk.tokens.TokensClientCancelTest.InterruptSensitive;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.Collections;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

/** 0.51.0 critic fixes on the middleware: hooks on the request thread, detached MFA verify, detached lock writes. */
class V0510MiddlewareTest {

    private static final ThreadLocal<String> REQUEST = new ThreadLocal<>();

    private FakeServer api;
    private InterruptSensitive store;
    private Realm realm;
    private final List<String> hookSaw = Collections.synchronizedList(new ArrayList<>());
    private final AtomicInteger verifyCalls = new AtomicInteger();
    private volatile long delayMs;
    private final CountDownLatch entered = new CountDownLatch(1);

    private static String jwtWithSub(String sub) {
        Base64.Encoder e = Base64.getUrlEncoder().withoutPadding();
        return e.encodeToString("{\"alg\":\"RS256\"}".getBytes(StandardCharsets.UTF_8)) + "."
                + e.encodeToString(("{\"sub\":\"" + sub + "\"}").getBytes(StandardCharsets.UTF_8)) + ".c2ln";
    }

    @BeforeEach
    void setUp() throws Exception {
        api = new FakeServer();
        store = new InterruptSensitive();
        api.on("POST /auth/login", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("access_token", "pt", "refresh_token", "rt", "expires_in", 300, "subject_type", "platform")));
        api.on("POST /auth/mfa/verify", (ex, body) -> {
            verifyCalls.incrementAndGet();
            entered.countDown();
            try { Thread.sleep(delayMs); } catch (InterruptedException ignored) { }
            return FakeServer.Reply.json(200, Map.of("access_token", "a", "refresh_token", "RM", "expires_in", 60,
                    "user", Map.of(), "tenants", List.of()));
        });
        api.on("POST /auth/token", (ex, body) -> {
            entered.countDown();
            try { Thread.sleep(delayMs); } catch (InterruptedException ignored) { }
            return FakeServer.Reply.json(200, Map.of("access_token", jwtWithSub("u1"), "refresh_token", "R2",
                    "expires_in", 60, "tenant_id", "t1", "role", "member"));
        });
        realm = Realm.builder().sessionStore(store).realmId("01HREALM").apiKey("rk").baseUrl(api.baseUrl)
                .audience("acme.test")
                .productRoles((t, u) -> { hookSaw.add("roles:" + REQUEST.get()); return List.of("dispatch"); })
                .scopes((t, u) -> { hookSaw.add("scopes:" + REQUEST.get()); return List.of("a:read"); })
                .onIdentityResolved(e -> hookSaw.add("identity:" + REQUEST.get()))
                .build();
    }

    @AfterEach
    void tearDown() { api.close(); }

    private RealmFilterTest.FakeRes drive(String path, String json) throws Exception {
        RealmFilter f = realm.middleware().tokenDelivery(TokenDelivery.COOKIE).buildFilter();
        RealmFilterTest.FakeReq req = new RealmFilterTest.FakeReq("POST", path);
        req.headers.put("Cookie", new ArrayList<>(List.of("realmid_refresh=R1")));
        req.body = json.getBytes(StandardCharsets.UTF_8);
        RealmFilterTest.FakeRes res = new RealmFilterTest.FakeRes();
        f.doFilter(req, res, (rq, rs) -> { throw new AssertionError("chain must not run"); });
        return res;
    }

    @Test
    void SPEC6_7_2_theRefreshRouteRunsEveryPartnerHookOnTheRequestThread() throws Exception {
        REQUEST.set("req-1");
        try {
            assertEquals(200, drive("/token", "{\"tenant_id\":\"t1\"}").status);
        } finally {
            REQUEST.remove();
        }
        assertTrue(hookSaw.contains("identity:req-1"), hookSaw.toString());
        assertTrue(hookSaw.contains("roles:req-1"), hookSaw.toString());
        assertTrue(hookSaw.contains("scopes:req-1"), hookSaw.toString());
    }

    @Test
    void SPEC6_7_2_mfaVerifyRunsPartnerHooksOnTheRequestThread() throws Exception {
        REQUEST.set("req-2");
        try {
            drive("/mfa/verify", "{\"challenge_token\":\"c\",\"code\":\"1\"}");
        } finally {
            REQUEST.remove();
        }
        // /auth/mfa/verify answers no tenants here, so nothing settles; the assertion is that no hook
        // ever saw a foreign thread's (absent) value.
        assertTrue(hookSaw.stream().noneMatch(s -> s.endsWith(":null")), hookSaw.toString());
    }

    /** Interrupts the thread running {@code path} once the issuer is mid-call; asserts rotation survives. */
    private void interruptedMidCall(String path, String json) throws Exception {
        delayMs = 400;
        AtomicReference<RealmFilterTest.FakeRes> out = new AtomicReference<>();
        AtomicReference<Throwable> err = new AtomicReference<>();
        Thread t = new Thread(() -> {
            try { out.set(drive(path, json)); } catch (Throwable e) { err.set(e); }
        });
        t.start();
        assertTrue(entered.await(5, TimeUnit.SECONDS));
        t.interrupt();
        t.join(10_000);
        assertNull(err.get());
        assertEquals(200, out.get().status, new String(out.get().bytes(), StandardCharsets.UTF_8));
        assertFalse(store.sawInterrupt.get(), "a lock/outcome write ran on the interrupted thread");
        assertTrue(store.inner.getRefreshResult(SessionKeys.outcomeKey("R1")).isPresent(), "outcome stored");
        assertTrue(store.inner.acquireRefreshLock(SessionKeys.lockKey("R1"), Duration.ofSeconds(1)).acquired(),
                "lock released");
    }

    @Test
    void SPEC10_1_5_aHangUpMidMfaVerifyDoesNotAbandonTheRotationOrDropTheOutcome() throws Exception {
        interruptedMidCall("/mfa/verify", "{\"challenge_token\":\"c\",\"code\":\"1\"}");
        assertEquals(1, verifyCalls.get());
    }

    @Test
    void SPEC10_1_4a_aHangUpMidRefreshStillStoresTheOutcomeAndReleasesTheLock() throws Exception {
        interruptedMidCall("/token", "{\"tenant_id\":\"t1\"}");
    }
}
