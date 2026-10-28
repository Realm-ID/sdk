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
 * carries an actor (R60): {@code userToken} (X-User-Token, per call) or one the realm carries via
 * {@code withUserToken}. With neither the call is an {@code ActorRequiredException} (see
 * {@link OtpIssueRequest}); {@code userId} is attribution beside the token.
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
        http.applyActor(r, "OtpClient", req.userId(), req.userToken(), req.onBehalfOfIp());
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
        http.applyActor(r, "OtpClient.view", opts.userId(), opts.userToken(), opts.onBehalfOfIp());
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
        http.applyActor(r, "OtpClient", req.userId(), req.userToken(), req.onBehalfOfIp());
        JsonNode raw = http.request(r);
        return http.mapper().convertValue(raw, OtpVerifyResponse.class);
    }
}
