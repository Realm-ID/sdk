package dev.realmid.sdk.auth;

import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

/**
 * EVERY session-producing lane resolves the derived claims — not just the ones
 * someone remembered to list.
 *
 * <p>{@code DerivedClaimsLoginTest} covers {@code login} and
 * {@code completeLogin}; its header says "proving it here proves both", which
 * was true and is also exactly the shape of the problem. The Go SDK now derives
 * the lane set from the package AST ({@code derived_claims_lanes_test.go}), and
 * that guard found TWO uncovered lanes — {@code otpLogin} and {@code mfaVerify}
 * — where the defect report that prompted it had named only one, because the
 * report was written off a hand-maintained "three call sites" comment.
 *
 * <p>Java has no equivalent walk here, so this is the behavioural mirror: one
 * test per lane. If you add a method returning a {@link Session}, add its row.
 */
class DerivedClaimsLanesTest {

    private FakeServer fs;
    private AtomicReference<Map<String, Object>> mintBody;
    private AtomicInteger mints;
    private List<String> handlerArgs;

    private static final Map<String, Object> SESSION = Map.of(
            "access_token", "at-lane",
            "refresh_token", "rtok",
            "user", Map.of("id", "u1"),
            "tenants", List.of(Map.of("tenant_id", "t1", "role", "owner")));

    @BeforeEach
    void setUp() throws IOException {
        fs = new FakeServer();
        mintBody = new AtomicReference<>();
        mints = new AtomicInteger();
        handlerArgs = new ArrayList<>();
        fs.onJson("POST /auth/login", (body, rec) -> {
            if ("platform_api_key".equals(body.get("grant_type"))) {
                return FakeServer.Reply.json(200, Map.of(
                        "access_token", "pt-12345", "refresh_token", "rt",
                        "expires_in", 300, "subject_type", "platform"));
            }
            return FakeServer.Reply.json(200, SESSION);
        });
        fs.onJson("POST /auth/mfa/verify", (body, rec) -> FakeServer.Reply.json(200, SESSION));
        fs.onJson("POST /auth/token", (body, rec) -> {
            mints.incrementAndGet();
            mintBody.set(body);
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", "minted", "refresh_token", "rtok2",
                    "expires_in", 900, "subject_type", "user",
                    "tenant_id", "t1", "role", "owner"));
        });
    }

    @AfterEach
    void tearDown() { fs.close(); }

    private Realm realmWithScopes() {
        return Realm.builder().realmId("01HREALM").apiKey("rk_live_test")
                .baseUrl(fs.baseUrl).audience("acme.test")
                .scopes((tenantId, userId) -> {
                    handlerArgs.add(tenantId + "/" + userId);
                    return List.of("invoices:read");
                })
                .build();
    }

    /** An OTP login is a login. This lane was uncovered and no report named it. */
    @Test
    void otpLoginResolvesTheDerivedClaims() {
        Session s = realmWithScopes().auth()
                .otpLogin(new OtpLoginRequest("u@example.com", "123456", null, null));

        assertEquals(1, mints.get(), "the OTP lane must mint exactly once");
        assertEquals(List.of("t1/u1"), handlerArgs,
                "the scopes handler was never called on the OTP lane");
        assertNotNull(mintBody.get());
        assertEquals("invoices:read", mintBody.get().get("scope"));
        assertEquals("minted", s.accessToken());
    }

    /**
     * The step-up lane issues the token the user carries for the rest of the
     * session, so a claim-blind one here denies a partner's own gate at the
     * worst possible moment: immediately after a passed second factor.
     */
    @Test
    void mfaVerifyResolvesTheDerivedClaims() {
        Session s = realmWithScopes().auth()
                .mfaVerify(new MFAVerifyRequest("mfa-token", "000000", "totp", null));

        assertEquals(1, mints.get(), "the MFA lane must mint exactly once");
        assertEquals(List.of("t1/u1"), handlerArgs,
                "the scopes handler was never called on the MFA lane");
        assertEquals("invoices:read", mintBody.get().get("scope"));
        assertEquals("minted", s.accessToken());
    }

    /** mfaVerifyOtp delegates to mfaVerify; prove the delegation carries the mint. */
    @Test
    void mfaVerifyOtpInheritsTheMint() {
        realmWithScopes().auth()
                .mfaVerifyOtp(new MfaVerifyOtpRequest("mfa-token", "000000", null));

        assertEquals(1, mints.get(), "mfaVerifyOtp must mint exactly once");
        assertEquals("invoices:read", mintBody.get().get("scope"));
    }
}
