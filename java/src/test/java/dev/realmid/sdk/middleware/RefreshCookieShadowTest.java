package dev.realmid.sdk.middleware;

import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;

import jakarta.servlet.FilterChain;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Cookie shadowing (Traide incident, 2026-07-28).
 *
 * <p>Setting or changing {@code cookieDomain} on a deployment with live
 * sessions leaves every browser holding TWO cookies named {@code
 * realmid_refresh} at different scopes — RFC 6265 makes a Domain-scoped
 * Set-Cookie unable to overwrite a host-only entry of the same name. Rotation
 * then updates one and freezes the other; the filter returned the FIRST name
 * match (which RFC 6265 §5.4 orders as the OLDER one at equal path length), so
 * it read the stale token on every refresh, forever. Logout did not help,
 * because it too only cleared the configured scope.
 *
 * <p>Two halves, tested separately because they fix different things: reading
 * every candidate RESTORES service for an already-stranded browser, and
 * evicting the other scopes is what actually CLEANS UP.
 */
class RefreshCookieShadowTest {

    private static final String REALM_ID = "01HREALM";

    private FakeServer api;
    private Realm realm;
    private final AtomicInteger tokenCalls = new AtomicInteger();

    @BeforeEach
    void setUp() throws Exception {
        api = new FakeServer();
        api.on("POST /auth/login", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("access_token", "pt", "refresh_token", "rt",
                        "expires_in", 300, "subject_type", "platform")));
        // Mints only for "live". This mirrors the real issuer for a
        // rotated-away token: an unrecognised refresh hash resolves to nothing
        // and comes back 401 refresh_invalid — and crucially it revokes
        // NOTHING on a miss, which is what makes trying each candidate safe.
        api.onJson("POST /auth/token", (body, rec) -> {
            tokenCalls.incrementAndGet();
            if (!"live".equals(String.valueOf(body.get("refresh_token")))) {
                return FakeServer.Reply.json(401, Map.of("error", Map.of(
                        "code", "refresh_invalid",
                        "message", "refresh token is invalid, expired, or revoked")));
            }
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", "at", "refresh_token", "rotated",
                    "expires_in", 300, "tenant_id", "t-1", "role", "member"));
        });
        api.on("POST /auth/logout", (ex, body) -> FakeServer.Reply.json(200, Map.of("status", "ok")));

        realm = Realm.builder()
                .realmId(REALM_ID)
                .apiKey("rk")
                .baseUrl(api.baseUrl)
                .audience("acme.test")
                .build();
    }

    @AfterEach
    void tearDown() {
        api.close();
    }

    private static final FilterChain NOOP = (rq, rs) -> { };

    private RealmFilter filter(MiddlewareConfig.Builder b) {
        return b.tokenDelivery(TokenDelivery.COOKIE).buildFilter();
    }

    private static RealmFilterTest.FakeReq refreshReq(String cookieHeader) {
        RealmFilterTest.FakeReq req = new RealmFilterTest.FakeReq("POST", "/token");
        req.headers.put("Cookie", new ArrayList<>(List.of(cookieHeader)));
        req.body = "{\"tenant_id\":\"t-1\"}".getBytes(StandardCharsets.UTF_8);
        return req;
    }

    // ---- read every candidate ----

    @Test
    void staleShadowCookieDoesNotStrandTheSession() throws Exception {
        RealmFilter f = filter(new MiddlewareConfig.Builder(realm).cookieDomain(".example.com"));
        RealmFilterTest.FakeRes res = new RealmFilterTest.FakeRes();

        // Stale first — the order a real browser sends, and the reason the old
        // first-match read failed 100% of the time rather than intermittently.
        f.doFilter(refreshReq("realmid_refresh=stale; realmid_refresh=live"), res, NOOP);

        assertEquals(200, res.status,
                "a shadowed jar must still refresh: " + new String(res.bytes(), StandardCharsets.UTF_8));
        assertEquals(2, tokenCalls.get(), "want the stale candidate tried, then the live one");
    }

    @Test
    void allCandidatesInvalidStillReportsRefreshInvalid() throws Exception {
        RealmFilter f = filter(new MiddlewareConfig.Builder(realm));
        RealmFilterTest.FakeRes res = new RealmFilterTest.FakeRes();

        f.doFilter(refreshReq("realmid_refresh=a; realmid_refresh=b"), res, NOOP);

        // The error surface must not change shape just because a browser
        // happened to carry a stale twin — partners branch on refresh_invalid.
        assertEquals(401, res.status);
        assertTrue(new String(res.bytes(), StandardCharsets.UTF_8).contains("refresh_invalid"),
                "want refresh_invalid preserved");
    }

    // ---- evict the other scopes ----

    private static List<String> setCookies(RealmFilterTest.FakeRes res) {
        Collection<String> v = res.getHeaders("Set-Cookie");
        return new ArrayList<>(v);
    }

    @Test
    void rotationEvictsTheHostOnlyTwin() throws Exception {
        RealmFilter f = filter(new MiddlewareConfig.Builder(realm).cookieDomain(".example.com"));
        RealmFilterTest.FakeRes res = new RealmFilterTest.FakeRes();

        f.doFilter(refreshReq("realmid_refresh=live"), res, NOOP);

        List<String> cookies = setCookies(res);
        assertEquals(2, cookies.size(), "want a deletion + the write, got " + cookies);
        // The host-only deletion carries NO Domain attribute — that is exactly
        // what scopes it to the twin rather than to the cookie being written.
        assertFalse(cookies.get(0).contains("Domain="), "deletion must be host-only: " + cookies.get(0));
        assertTrue(cookies.get(0).contains("Max-Age=0"), "first header must be a deletion");
        assertTrue(cookies.get(1).contains("Domain=.example.com"), "second must be the live write");
        assertTrue(cookies.get(1).contains("realmid_refresh=rotated"));
    }

    @Test
    void hostOnlyConfigEmitsNoStrayDeletion() throws Exception {
        RealmFilter f = filter(new MiddlewareConfig.Builder(realm));
        RealmFilterTest.FakeRes res = new RealmFilterTest.FakeRes();

        f.doFilter(refreshReq("realmid_refresh=live"), res, NOOP);

        // The default has no other scope to evict, and inventing one would
        // delete the very cookie being written.
        assertEquals(1, setCookies(res).size(), "want only the write");
    }

    @Test
    void migrateFromEvictsTheNamedScope() throws Exception {
        // Tightening/removing a domain is the direction the SDK cannot discover
        // on its own: the wider cookie is invisible to a config that no longer
        // writes it, so the partner has to name the scope being left.
        RealmFilter f = filter(new MiddlewareConfig.Builder(realm)
                .cookieDomainMigrateFrom(List.of(".example.com")));
        RealmFilterTest.FakeRes res = new RealmFilterTest.FakeRes();

        f.doFilter(refreshReq("realmid_refresh=live"), res, NOOP);

        List<String> cookies = setCookies(res);
        assertEquals(2, cookies.size(), "want the named deletion + the write, got " + cookies);
        assertTrue(cookies.get(0).contains("Domain=.example.com"));
        assertTrue(cookies.get(0).contains("Max-Age=0"));
    }

    @Test
    void neverDeletesTheScopeBeingWritten() throws Exception {
        // A partner who leaves the old value configured after finishing the
        // migration must not thereby delete their own live cookie on every
        // write — including when the two are spelled with/without the dot,
        // which name the SAME scope under RFC 6265.
        RealmFilter f = filter(new MiddlewareConfig.Builder(realm)
                .cookieDomain(".example.com")
                .cookieDomainMigrateFrom(List.of("example.com")));
        RealmFilterTest.FakeRes res = new RealmFilterTest.FakeRes();

        f.doFilter(refreshReq("realmid_refresh=live"), res, NOOP);

        for (String c : setCookies(res)) {
            assertFalse(c.contains("Domain=example.com") && c.contains("Max-Age=0"),
                    "must never delete the scope being written: " + c);
            assertFalse(c.contains("Domain=.example.com") && c.contains("Max-Age=0"),
                    "must never delete the scope being written: " + c);
        }
        assertTrue(setCookies(res).get(setCookies(res).size() - 1).contains("realmid_refresh=rotated"),
                "the live write must survive");
    }

    @Test
    void logoutClearsEveryScopeAndRevokesEveryCandidate() throws Exception {
        RealmFilter f = filter(new MiddlewareConfig.Builder(realm)
                .cookieDomain(".example.com")
                .cookieDomainMigrateFrom(List.of(".old.example.com")));
        RealmFilterTest.FakeRes res = new RealmFilterTest.FakeRes();

        RealmFilterTest.FakeReq req = new RealmFilterTest.FakeReq("POST", "/logout");
        req.headers.put("Cookie", new ArrayList<>(List.of("realmid_refresh=stale; realmid_refresh=live")));
        f.doFilter(req, res, NOOP);

        // Clearing only the configured scope is why signing out and back in did
        // not recover a stranded browser.
        List<String> cookies = setCookies(res);
        assertEquals(3, cookies.size(),
                "want host-only + migrated-from + configured deletions, got " + cookies);
        for (String c : cookies) {
            assertTrue(c.contains("Max-Age=0"), "every header must be a deletion: " + c);
        }
    }
}
