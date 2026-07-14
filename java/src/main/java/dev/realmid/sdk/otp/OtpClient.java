package dev.realmid.sdk.otp;

import com.fasterxml.jackson.databind.JsonNode;
import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.RealmException;
import dev.realmid.sdk.http.HttpTransport;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Partner OTP primitive (issue / view / verify) — SPEC §X. Mirrors Go's
 * {@code OTPClient} (sdk/go/otp.go) and TS's {@code OtpClient}
 * (sdk/ts/src/otp.ts).
 *
 * <p>All three calls require a tenant-scoped user/service identity. The SDK
 * supports both shapes via the dual-mode bearer trio (see
 * {@link OtpIssueRequest}): {@code userBearer} (the user's access JWT rides as
 * {@code Authorization: Bearer}) or {@code userId} (BFF mode — the SDK uses its
 * cached platform token as bearer and forwards {@code X-On-Behalf-Of-User}).
 */
public final class OtpClient {

    private final HttpTransport http;

    public OtpClient(HttpTransport http) {
        this.http = http;
    }

    /**
     * SPEC §X.1 — {@code POST /auth/otp/issue}. Mints a fresh OTP for
     * {@code (subjectRef, purpose)}. The plaintext value is returned exactly
     * once; partners deliver it out-of-band.
     */
    public OtpIssueResponse issue(OtpIssueRequest req) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("subject_ref", req.subjectRef());
        body.put("purpose", req.purpose());
        if (req.deliveryMode() != null && !req.deliveryMode().isEmpty()) {
            body.put("delivery_mode", req.deliveryMode());
        }
        HttpTransport.Request r = HttpTransport.Request.of("POST", "/auth/otp/issue").body(body);
        applyBearerTrio(r, req.userId(), req.userBearer(), req.onBehalfOfIp());
        JsonNode raw = http.request(r);
        return http.mapper().convertValue(raw, OtpIssueResponse.class);
    }

    /**
     * SPEC §X.2 — {@code GET /auth/otp/{id}}. Issuer-scoped: only the user who
     * minted the OTP can fetch its plaintext value. Cross-issuer /
     * cross-tenant attempts return {@code not_found} with no info leak.
     */
    public OtpViewResponse view(String otpId, OtpViewOptions opts) {
        if (opts == null) opts = OtpViewOptions.empty();
        HttpTransport.Request r = HttpTransport.Request.of(
                "GET", "/auth/otp/" + URLEncoder.encode(otpId, StandardCharsets.UTF_8));
        applyBearerTrio(r, opts.userId(), opts.userBearer(), opts.onBehalfOfIp());
        JsonNode raw = http.request(r);
        return http.mapper().convertValue(raw, OtpViewResponse.class);
    }

    /**
     * SPEC §X.3 — {@code POST /auth/otp/verify}. Hash-matches a presented value
     * against active OTP rows in {@code (tenant, subjectRef, purpose)} and
     * consumes the matching row atomically. The response carries
     * {@code issuerUserId} + {@code issuedAt} so the partner backend can
     * attribute the action to the human who minted the code.
     */
    public OtpVerifyResponse verify(OtpVerifyRequest req) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("subject_ref", req.subjectRef());
        body.put("purpose", req.purpose());
        body.put("presented", req.presented());
        HttpTransport.Request r = HttpTransport.Request.of("POST", "/auth/otp/verify").body(body);
        applyBearerTrio(r, req.userId(), req.userBearer(), req.onBehalfOfIp());
        JsonNode raw = http.request(r);
        return http.mapper().convertValue(raw, OtpVerifyResponse.class);
    }

    /**
     * Resolve the dual-mode bearer trio onto a request (mirrors
     * {@code AuthClient.applyBearerTrio} and Go's {@code resolveOnBehalfOf}):
     * exactly one of {@code userBearer} (legacy mode, sent as the Authorization
     * bearer) or {@code userId} (BFF mode, sent as {@code X-On-Behalf-Of-User}
     * while the transport auto-attaches the platform token).
     * {@code onBehalfOfIp} is optional and only meaningful in BFF mode.
     */
    private static void applyBearerTrio(HttpTransport.Request r, String userId, String userBearer, String onBehalfOfIp) {
        boolean hasBearer = userBearer != null && !userBearer.isEmpty();
        boolean hasUserId = userId != null && !userId.isEmpty();
        if (hasBearer == hasUserId) {
            throw new RealmException(ErrorCode.BAD_REQUEST,
                    "realmid: exactly one of userBearer or userId is required");
        }
        if (hasBearer) {
            r.bearer(userBearer);
        } else {
            r.header("x-on-behalf-of-user", userId);
            if (onBehalfOfIp != null && !onBehalfOfIp.isEmpty()) {
                r.header("x-on-behalf-of-ip", onBehalfOfIp);
            }
        }
    }
}
