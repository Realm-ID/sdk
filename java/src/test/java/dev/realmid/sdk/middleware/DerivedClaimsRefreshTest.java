package dev.realmid.sdk.middleware;

import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.auth.ProductRolesHandler;
import dev.realmid.sdk.auth.ScopesHandler;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

/**
 * The REFRESH lane must resolve the derived claims, exactly as the login lanes
 * do.
 *
 * <h2>The defect these guard</h2>
 *
 * <p>{@code AuthClient.mintProductRoles} had two call sites — {@code login} and
 * {@code completeLogin} — and BOTH are login lanes. Nothing ran on refresh, and
 * {@code RealmFilter.handleRefresh} minted with
 * {@code new TokenRequest(candidate, tenantId, custom, null)} alone. So a
 * BFF-fronted session carried {@code product_roles} at login and lost it roughly
 * one access-TTL later, for the life of the session. {@code scope} had the
 * identical hole with a sharper edge — the issuer never STORES {@code scope} on
 * a session, so an unrequested claim is an absent one and every
 * {@code ScopePolicy} gate reads absence as "no granted authority".
 *
 * <p>{@code ProductRolesHandler} promised the opposite in writing the whole
 * time: "It runs on EVERY mint, refresh included, and nothing caches."
 *
 * <p><b>⚠️ THESE TESTS ARE LANE-SPECIFIC ON PURPOSE.</b> An assertion that "a
 * login carries the claim" passed throughout the entire life of the bug. The
 * LANE is the subject, not the claim.
 */
class DerivedClaimsRefreshTest {

    private static final String REALM_ID = "01HREALM";

    private FakeServer fs;
    /** Every /auth/token body the filter sent, in order. */
    private List<Map<String, Object>> mints;
    private AtomicInteger mintCount;
    private List<String> handlerArgs;

    @BeforeEach
    void setUp() throws IOException {
        fs = new FakeServer();
        mints = new ArrayList<>();
        mintCount = new AtomicInteger();
        handlerArgs = new ArrayList<>();
        fs.onJson("POST /auth/login", (body, rec) -> FakeServer.Reply.json(200, Map.of(
                "access_token", "pt-12345", "refresh_token", "rt",
                "expires_in", 300, "subject_type", "platform")));
        fs.onJson("POST /auth/token", (body, rec) -> {
            mintCount.incrementAndGet();
            mints.add(body);
            Map<String, Object> out = new LinkedHashMap<>();
            // A REAL 3-part token carrying `sub`, because the fix must recover
            // the subject from the token the issuer just handed back. Nothing
            // verifies it on this lane; the peek only base64-decodes the payload.
            out.put("access_token", jwtWithSub("u-refresh"));
            out.put("refresh_token", "rtok" + mintCount.get());
            out.put("expires_in", 900);
            out.put("subject_type", "user");
            out.put("tenant_id", "t1");
            out.put("role", "member");
            return FakeServer.Reply.json(200, out);
        });
    }

    @AfterEach
    void tearDown() { fs.close(); }

    private static String jwtWithSub(String sub) {
        Base64.Encoder e = Base64.getUrlEncoder().withoutPadding();
        String h = e.encodeToString("{\"alg\":\"RS256\",\"kid\":\"kid-1\"}".getBytes(StandardCharsets.UTF_8));
        String p = e.encodeToString(("{\"sub\":\"" + sub + "\",\"tenant_id\":\"t1\"}")
                .getBytes(StandardCharsets.UTF_8));
        return h + "." + p + ".c2ln";
    }

    private Realm realmWith(ProductRolesHandler pr, ScopesHandler sc) {
        Realm.Builder b = Realm.builder().realmId(REALM_ID).apiKey("rk_live_test")
                .baseUrl(fs.baseUrl).audience("acme.test");
        if (pr != null) b = b.productRoles(pr);
        if (sc != null) b = b.scopes(sc);
        return b.build();
    }

    /** Drives ONE refresh request through the filter's refresh route. */
    private RealmFilterTest.FakeRes driveRefresh(Realm realm) throws Exception {
        RealmFilter f = realm.middleware().buildFilter();
        RealmFilterTest.FakeReq req = new RealmFilterTest.FakeReq("POST", "/token");
        req.headers.put("Cookie", List.of("realmid_refresh=rtok"));
        req.body = "{\"tenant_id\":\"t1\"}".getBytes(StandardCharsets.UTF_8);
        RealmFilterTest.FakeRes res = new RealmFilterTest.FakeRes();
        f.doFilter(req, res, (rq, rs) -> { throw new AssertionError("chain must not run"); });
        return res;
    }

    /** The body of the FINAL mint — the one whose token the caller ends up
     *  holding. Asserting on the first would pass while the claim was dropped
     *  from the token that actually gets used. */
    private Map<String, Object> lastMint() {
        return mints.isEmpty() ? null : mints.get(mints.size() - 1);
    }

    /**
     * THE REGRESSION TEST. Red before the fix: the refresh minted without ever
     * calling the handler, so {@code product_roles} was absent from the wire.
     */
    @Test
    void refreshResolvesProductRoles() throws Exception {
        Realm realm = realmWith((tenantId, userId) -> {
            handlerArgs.add(tenantId + "/" + userId);
            return List.of("dispatch");
        }, null);

        RealmFilterTest.FakeRes res = driveRefresh(realm);

        assertEquals(200, res.status);
        assertFalse(handlerArgs.isEmpty(),
                "the product_roles handler was never called on the REFRESH lane — "
                        + "ProductRolesHandler promises it 'runs on EVERY mint, refresh included'");
        // The subject must come from the minted token, not be invented or left
        // blank: resolving roles for the empty user is a silent wrong answer.
        assertEquals(List.of("t1/u-refresh"), handlerArgs);
        assertNotNull(lastMint(), "no /auth/token call was made at all");
        assertEquals(List.of("dispatch"), lastMint().get("product_roles"),
                "product_roles must ride the FINAL mint");
    }

    /**
     * The same lane, the same hole, for ADR-097 granted authority. This is the
     * one that blocked a partner: with {@code scope} absent, {@code scopesFrom}
     * reads empty and every {@code ScopePolicy} gate denies about one
     * access-TTL into every session.
     */
    @Test
    void refreshResolvesScopes() throws Exception {
        Realm realm = realmWith(null, (tenantId, userId) -> {
            handlerArgs.add(tenantId + "/" + userId);
            return List.of("invoices:read", "invoices:write");
        });

        RealmFilterTest.FakeRes res = driveRefresh(realm);

        assertEquals(200, res.status);
        assertEquals(List.of("t1/u-refresh"), handlerArgs,
                "the scopes handler was never called on the REFRESH lane");
        assertNotNull(lastMint(), "no /auth/token call was made at all");
        // SPACE-DELIMITED on the wire (RFC 6749 §3.3), not an array — the
        // issuer's `scope` claim is a string and scopesFrom splits on fields.
        assertEquals("invoices:read invoices:write", lastMint().get("scope"));
    }

    /**
     * COST GUARD, and the assertion most likely to rot. The re-mint is a SECOND
     * round trip, so a consumer who adopts neither handler must keep paying for
     * exactly one. Asserting only the body would let the extra call creep in
     * unnoticed — this asserts the COUNT.
     */
    @Test
    void noHandlerMintsExactlyOnce() throws Exception {
        Realm realm = realmWith(null, null);

        driveRefresh(realm);

        assertEquals(1, mintCount.get(),
                "with no handler configured the refresh must mint exactly once");
        assertFalse(lastMint().containsKey("product_roles"),
                "product_roles must be ABSENT, not empty, when no handler is configured");
        assertFalse(lastMint().containsKey("scope"),
                "scope must be ABSENT, not empty, when no handler is configured");
    }

    /**
     * An empty result mints NO claim, not {@code []}. Absent and empty must mean
     * the same thing for these two, because every token issued before the
     * feature has no claim at all and a reader handles absence regardless.
     *
     * <p><b>⚠️ This rule is NOT shared by {@code role_permissions}</b>, where an
     * empty non-null list is a real instruction the issuer answers with a 403.
     * Do not harmonise them.
     */
    @Test
    void emptyOrNullResultMintsNoClaim() throws Exception {
        Realm realm = realmWith((t, u) -> List.of(), (t, u) -> null);

        driveRefresh(realm);

        assertFalse(lastMint().containsKey("product_roles"),
                "an empty handler result must mint NO product_roles claim");
        assertFalse(lastMint().containsKey("scope"),
                "a null handler result must mint NO scope claim");
    }

    /**
     * The re-mint must spend the ROTATED refresh token, not the one the first
     * mint already consumed — replaying it would come back
     * {@code 401 refresh_invalid} and log the session out on every refresh.
     */
    @Test
    void reMintUsesTheRotatedRefreshToken() throws Exception {
        Realm realm = realmWith(null, (t, u) -> List.of("invoices:read"));

        driveRefresh(realm);

        assertEquals(2, mintCount.get(), "a configured handler costs exactly one extra mint");
        assertEquals("rtok", mints.get(0).get("refresh_token"));
        assertEquals("rtok1", mints.get(1).get("refresh_token"),
                "the second mint must present the token the FIRST mint rotated to");
        assertNotEquals(mints.get(0).get("refresh_token"), mints.get(1).get("refresh_token"));
    }

    /**
     * A handler error REFUSES the refresh rather than minting without the claim.
     * Minting anyway hands back a token every gate reads as "denied" — turning a
     * transient blip in the partner's store into an authorization outage our own
     * logs record as a clean 200.
     */
    @Test
    void handlerErrorRefusesTheRefresh() throws Exception {
        Realm realm = realmWith(null, (t, u) -> { throw new IllegalStateException("scope store down"); });

        RealmFilterTest.FakeRes res = driveRefresh(realm);

        assertEquals(500, res.status,
                "a failing scopes handler must refuse the refresh, not mint without the claim");
        Map<?, ?> body = FakeServer.M.readValue(res.bytes(), Map.class);
        assertEquals("server_error", ((Map<?, ?>) body.get("error")).get("code"));
    }
}
