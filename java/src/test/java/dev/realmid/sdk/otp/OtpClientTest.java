package dev.realmid.sdk.otp;

import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.RealmException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;

class OtpClientTest {
    private FakeServer fs;
    private Realm realm;

    @BeforeEach
    void setUp() throws IOException {
        fs = new FakeServer();
        // Platform-token mint (POST /auth/login with grant_type=platform_api_key).
        fs.on("POST /auth/login", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("access_token", "pt-12345", "refresh_token", "rt",
                        "expires_in", 300, "subject_type", "platform")));
        realm = Realm.builder()
                .realmId("01HREALM")
                .apiKey("rk_live_test")
                .baseUrl(fs.baseUrl)
                .audience("acme.test")
                .build();
    }

    @AfterEach
    void tearDown() { fs.close(); }

    @Test
    void issuePostsSubjectRefAndPurposeBffMode() {
        AtomicReference<FakeServer.Recorded> seen = new AtomicReference<>();
        fs.on("POST /auth/otp/issue", (ex, body) -> {
            seen.set(fs.last());
            return FakeServer.Reply.json(200, Map.of(
                    "id", "otp-1",
                    "value", "123456",
                    "expires_at", "2026-05-08T12:00:00Z",
                    "purpose", "delivery",
                    "subject_ref", "booking:X"));
        });
        OtpIssueResponse out = realm.otp().issue(
                OtpIssueRequest.forUser("booking:X", "delivery", "manager-A"));
        assertEquals("otp-1", out.id());
        assertEquals("123456", out.value());
        assertEquals("2026-05-08T12:00:00Z", out.expiresAt());
        assertEquals("booking:X", out.subjectRef());
        // BFF mode: platform token bearer + on-behalf-of-user header.
        assertEquals("Bearer pt-12345", seen.get().header("authorization"));
        assertEquals("manager-A", seen.get().header("x-on-behalf-of-user"));
        assertEquals("booking:X", seen.get().bodyAsMap().get("subject_ref"));
        assertEquals("delivery", seen.get().bodyAsMap().get("purpose"));
    }

    @Test
    void verifySuccessReturnsIssuerAttributionLegacyBearer() {
        AtomicReference<FakeServer.Recorded> seen = new AtomicReference<>();
        fs.on("POST /auth/otp/verify", (ex, body) -> {
            seen.set(fs.last());
            return FakeServer.Reply.json(200, Map.of(
                    "otp_id", "otp-1",
                    "issuer_user_id", "manager-A",
                    "issued_at", "2026-05-08T11:00:00Z",
                    "subject_ref", "booking:X",
                    "purpose", "delivery"));
        });
        OtpVerifyResponse out = realm.otp().verify(
                OtpVerifyRequest.withBearer("booking:X", "delivery", "123456", "agent-svc-jwt"));
        assertEquals("otp-1", out.otpId());
        assertEquals("manager-A", out.issuerUserId());
        // Legacy mode: the user's own access JWT is the Authorization bearer.
        assertEquals("Bearer agent-svc-jwt", seen.get().header("authorization"));
        assertEquals("123456", seen.get().bodyAsMap().get("presented"));
    }

    @Test
    void verifyInvalidSurfacesInvalidOtp() {
        fs.on("POST /auth/otp/verify", (ex, body) -> FakeServer.Reply.json(401, Map.of(
                "error", Map.of("code", "invalid_otp", "message", "invalid OTP"))));
        RealmException ex = assertThrows(RealmException.class, () -> realm.otp().verify(
                OtpVerifyRequest.withBearer("booking:X", "delivery", "wrong", "agent-svc-jwt")));
        assertEquals(ErrorCode.INVALID_OTP, ex.getCode());
    }

    @Test
    void verifyExpiredSurfacesOtpExpired() {
        fs.on("POST /auth/otp/verify", (ex, body) -> FakeServer.Reply.json(401, Map.of(
                "error", Map.of("code", "otp_expired", "message", "expired"))));
        RealmException ex = assertThrows(RealmException.class, () -> realm.otp().verify(
                OtpVerifyRequest.withBearer("booking:X", "delivery", "123456", "agent-svc-jwt")));
        assertEquals(ErrorCode.OTP_EXPIRED, ex.getCode());
    }

    @Test
    void verifyLockedSurfacesOtpLocked() {
        fs.on("POST /auth/otp/verify", (ex, body) -> FakeServer.Reply.json(429, Map.of(
                "error", Map.of("code", "otp_locked", "message", "locked"))));
        RealmException ex = assertThrows(RealmException.class, () -> realm.otp().verify(
                OtpVerifyRequest.withBearer("booking:X", "delivery", "123456", "agent-svc-jwt")));
        assertEquals(ErrorCode.OTP_LOCKED, ex.getCode());
    }

    @Test
    void viewReturnsIssuerUserIdIssuerScoped() {
        AtomicReference<FakeServer.Recorded> seen = new AtomicReference<>();
        fs.on("GET /auth/otp/otp-1", (ex, body) -> {
            seen.set(fs.last());
            return FakeServer.Reply.json(200, Map.of(
                    "id", "otp-1",
                    "value", "654321",
                    "expires_at", "2026-05-08T12:00:00Z",
                    "purpose", "login",
                    "subject_ref", "user:bob",
                    "issuer_user_id", "manager-A"));
        });
        OtpViewResponse out = realm.otp().view("otp-1", OtpViewOptions.withBearer("manager-jwt"));
        assertEquals("654321", out.value());
        assertEquals("manager-A", out.issuerUserId());
        assertEquals("Bearer manager-jwt", seen.get().header("authorization"));
    }

    @Test
    void viewExpiredSurfacesNotFound() {
        fs.on("GET /auth/otp/otp-1", (ex, body) -> FakeServer.Reply.json(404, Map.of(
                "error", Map.of("code", "otp_not_found", "message", "not found"))));
        RealmException ex = assertThrows(RealmException.class, () -> realm.otp().view(
                "otp-1", OtpViewOptions.withBearer("manager-jwt")));
        assertEquals(ErrorCode.OTP_NOT_FOUND, ex.getCode());
    }

    @Test
    void issueRejectsBothBearerAndUserId() {
        RealmException ex = assertThrows(RealmException.class, () -> realm.otp().issue(
                new OtpIssueRequest("booking:X", "delivery", "u1", "user-jwt", null)));
        assertEquals(ErrorCode.BAD_REQUEST, ex.getCode());
    }

    @Test
    void issueThreadsDeliveryModeViewBff() {
        AtomicReference<FakeServer.Recorded> seen = new AtomicReference<>();
        fs.on("POST /auth/otp/issue", (ex, body) -> {
            seen.set(fs.last());
            return FakeServer.Reply.json(200, Map.of(
                    "id", "otp-1", "value", "123456",
                    "expires_at", "2026-07-14T00:00:00Z",
                    "purpose", "login", "subject_ref", "user:sa-1"));
        });
        realm.otp().issue(OtpIssueRequest.forUser("user:sa-1", "login", "u-owner")
                .withDeliveryMode(OtpIssueRequest.DELIVERY_MODE_VIEW_BFF));
        assertEquals("view_bff", seen.get().bodyAsMap().get("delivery_mode"));
    }

    @Test
    void issueOmitsDeliveryModeWhenUnset() {
        AtomicReference<FakeServer.Recorded> seen = new AtomicReference<>();
        fs.on("POST /auth/otp/issue", (ex, body) -> {
            seen.set(fs.last());
            return FakeServer.Reply.json(200, Map.of(
                    "id", "otp-2", "value", "222222",
                    "expires_at", "2026-07-14T00:00:00Z",
                    "purpose", "delivery", "subject_ref", "booking:X"));
        });
        realm.otp().issue(OtpIssueRequest.forUser("booking:X", "delivery", "u1"));
        assertFalse(seen.get().bodyAsMap().containsKey("delivery_mode"));
    }
}
