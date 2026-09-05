package dev.realmid.sdk.auth;

import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@code docs/design/pre-mint-hook.md} §10.2 —
 * {@code TestIdentityResolvedFiresOnEveryDerivedClaimsLane} and
 * {@code TestIdentityResolvedFiresOncePerTenant}, ported to Java.
 *
 * <p>OQ-1 is central to this change: the hook must fire on refresh, not only
 * on the five login lanes, because in a BFF deployment the refresh route IS
 * the tenant-choice route.
 */
class IdentityResolvedLanesTest {

    private FakeServer fs;
    private List<IdentityResolvedEvent> fired;

    private static final Map<String, Object> SESSION = Map.of(
            "access_token", "at-lane",
            "refresh_token", "rtok",
            "user", Map.of("id", "u1"),
            "tenants", List.of(Map.of("tenant_id", "t1", "role", "owner")));

    private static final Map<String, Object> MULTI_TENANT_SESSION = Map.of(
            "refresh_token", "rtok-multi",
            "user", Map.of("id", "u1"),
            "tenants", List.of(
                    Map.of("tenant_id", "t1", "role", "owner"),
                    Map.of("tenant_id", "t2", "role", "member")));

    @BeforeEach
    void setUp() throws IOException {
        fs = new FakeServer();
        fired = new ArrayList<>();
        fs.onJson("POST /auth/login", (body, rec) -> {
            if ("platform_api_key".equals(body.get("grant_type"))) {
                return FakeServer.Reply.json(200, Map.of(
                        "access_token", "pt-12345", "refresh_token", "rt",
                        "expires_in", 300, "subject_type", "platform"));
            }
            return FakeServer.Reply.json(200, SESSION);
        });
        fs.onJson("POST /auth/mfa/verify", (body, rec) -> FakeServer.Reply.json(200, SESSION));
        fs.onJson("POST /auth/token", (body, rec) -> FakeServer.Reply.json(200, Map.of(
                "access_token", "minted", "refresh_token", "rtok2",
                "expires_in", 900, "subject_type", "user",
                "tenant_id", "t1", "role", "owner")));
    }

    @AfterEach
    void tearDown() { fs.close(); }

    private Realm realm() {
        return Realm.builder().realmId("01HREALM").apiKey("rk_live_test")
                .baseUrl(fs.baseUrl).audience("acme.test")
                .onIdentityResolved(fired::add)
                .build();
    }

    @Test
    void loginFiresOnceWithFlowLogin() {
        realm().auth().login(new LoginRequest("google", "provider-token", null, null, null));
        assertEquals(1, fired.size());
        assertEquals(AuthFlow.LOGIN, fired.get(0).flow());
        assertEquals("t1", fired.get(0).tenantId());
        assertEquals("u1", fired.get(0).userId());
        assertEquals("01HREALM", fired.get(0).realmId());
    }

    @Test
    void otpLoginFiresOnceWithFlowOtp() {
        realm().auth().otpLogin(new OtpLoginRequest("u@example.com", "123456", null, null));
        assertEquals(1, fired.size());
        assertEquals(AuthFlow.OTP, fired.get(0).flow());
    }

    @Test
    void passwordLoginFiresOnceWithFlowPassword() {
        realm().auth().passwordLogin(new PasswordLoginRequest("u@example.com", "hunter2", null, null));
        assertEquals(1, fired.size());
        assertEquals(AuthFlow.PASSWORD, fired.get(0).flow());
    }

    @Test
    void mfaVerifyFiresOnceWithFlowMfaVerify() {
        realm().auth().mfaVerify(new MFAVerifyRequest("mfa-token", "000000", "totp", null));
        assertEquals(1, fired.size());
        assertEquals(AuthFlow.MFA_VERIFY, fired.get(0).flow());
    }

    /** mfaVerifyOtp delegates to mfaVerify — it must fire ONCE, not twice. */
    @Test
    void mfaVerifyOtpFiresExactlyOnce() {
        realm().auth().mfaVerifyOtp(new MfaVerifyOtpRequest("mfa-token", "000000", null));
        assertEquals(1, fired.size(), "mfaVerifyOtp delegates to mfaVerify and must fire once, not twice");
        assertEquals(AuthFlow.MFA_VERIFY, fired.get(0).flow());
    }

    /** A multi-tenant login does not settle a tenant, so the hook must NOT fire. */
    @Test
    void multiTenantLoginDoesNotFireUntilSettled() {
        fs.onJson("POST /auth/login", (body, rec) -> {
            if ("platform_api_key".equals(body.get("grant_type"))) {
                return FakeServer.Reply.json(200, Map.of(
                        "access_token", "pt-12345", "refresh_token", "rt",
                        "expires_in", 300, "subject_type", "platform"));
            }
            return FakeServer.Reply.json(200, MULTI_TENANT_SESSION);
        });

        Session s = realm().auth().login(new LoginRequest("google", "provider-token", null, null, null));

        assertTrue(s.needsTenantChoice());
        assertEquals(0, fired.size(), "a multi-tenant login must not fire the hook until a tenant is settled");
    }

    /**
     * {@code completeLogin} settles the tenant choice, fires once for it, and a
     * SECOND {@code completeLogin} for a different tenant fires again — that is
     * the mirror's own contract ("(tenant, user) is settled"), not a leak.
     */
    @Test
    void completeLoginFiresOncePerTenant() {
        fs.onJson("POST /auth/login", (body, rec) -> {
            if ("platform_api_key".equals(body.get("grant_type"))) {
                return FakeServer.Reply.json(200, Map.of(
                        "access_token", "pt-12345", "refresh_token", "rt",
                        "expires_in", 300, "subject_type", "platform"));
            }
            return FakeServer.Reply.json(200, MULTI_TENANT_SESSION);
        });
        fs.onJson("POST /auth/token", (body, rec) -> FakeServer.Reply.json(200, Map.of(
                "access_token", "minted", "refresh_token", "rtok2",
                "expires_in", 900, "subject_type", "user",
                "tenant_id", body.get("tenant_id"), "role", "member")));

        Realm r = realm();
        Session s = r.auth().login(new LoginRequest("google", "provider-token", null, null, null));
        assertEquals(0, fired.size());

        r.auth().completeLogin(s, "t1", null);
        assertEquals(1, fired.size());
        assertEquals("t1", fired.get(0).tenantId());
        assertEquals(AuthFlow.TENANT_CHOICE, fired.get(0).flow());

        r.auth().completeLogin(s, "t2", null);
        assertEquals(2, fired.size(), "switching tenants must fire again, for the new tenant");
        assertEquals("t2", fired.get(1).tenantId());
    }

    /**
     * The refresh lane, driven directly against {@link AuthClient#enrichRefreshMint}
     * (the middleware itself is out of scope for this change — §3.2/§13 rule 1).
     */
    @Test
    void refreshFiresWithFlowRefreshAndReadsFieldsFromTheMintedToken() {
        Realm r = realm();
        TokenResponse minted = new TokenResponse(jwtWithClaims("u-refresh", "u@ex.com", "Ada"),
                "rtok-rotated", 900, 0, 0, "user", "t1", null);

        r.auth().enrichRefreshMint(minted, "t1");

        assertEquals(1, fired.size());
        IdentityResolvedEvent ev = fired.get(0);
        assertEquals(AuthFlow.REFRESH, ev.flow());
        assertEquals("t1", ev.tenantId());
        assertEquals("u-refresh", ev.userId());
        assertEquals("u@ex.com", ev.email());
        assertEquals("Ada", ev.displayName());
    }

    /** No refresh token at all (ADR-089 credential-bootstrapped session) — nothing to fire on. */
    @Test
    void refreshWithNoRefreshTokenDoesNotFire() {
        Realm r = realm();
        TokenResponse minted = new TokenResponse("at", null, 900, 0, 0, "user", "t1", null);

        r.auth().enrichRefreshMint(minted, "t1");

        assertEquals(0, fired.size());
    }

    private static String jwtWithClaims(String sub, String email, String name) {
        Base64.Encoder e = Base64.getUrlEncoder().withoutPadding();
        String h = e.encodeToString("{\"alg\":\"RS256\"}".getBytes(StandardCharsets.UTF_8));
        String p = e.encodeToString(("{\"sub\":\"" + sub + "\",\"email\":\"" + email
                + "\",\"name\":\"" + name + "\"}").getBytes(StandardCharsets.UTF_8));
        return h + "." + p + ".sig";
    }
}
