package dev.realmid.sdk.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.realmid.sdk.auth.TokenResponse;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * What the winner of a per-session refresh lock stores for the callers waiting
 * behind it (SPEC §10.1 step 4a): the mint result or the error, plus the request
 * fingerprint. Shared by the middleware's refresh / MFA routes and by
 * {@code AuthClient.token} / the direct MFA calls, so every lock holder speaks
 * the same stored shape. Holds live credentials: it goes into the
 * {@link SessionStateStore} as opaque bytes with a short TTL.
 *
 * <p>INTERNAL to the SDK (public only so sibling packages can use it): no stability promise, and the
 * wire shape of the stored bytes is not a contract.
 */
public record RefreshOutcome(String fp, boolean ok, int status, String code, String message,
                             Map<String, Object> details, String accessToken, Object expiresIn,
                             String tenantId, String role, String refreshToken, String minted,
                             long refreshExp, long idleTtl, String subjectType, long retryAfterSeconds) {

    /** Without a stored {@code Retry-After}. */
    public RefreshOutcome(String fp, boolean ok, int status, String code, String message,
                          Map<String, Object> details, String accessToken, Object expiresIn,
                          String tenantId, String role, String refreshToken, String minted,
                          long refreshExp, long idleTtl, String subjectType) {
        this(fp, ok, status, code, message, details, accessToken, expiresIn, tenantId, role, refreshToken,
                minted, refreshExp, idleTtl, subjectType, 0L);
    }

    /** This outcome carrying the issuer's {@code Retry-After} (whole seconds; zero or less means none). */
    public RefreshOutcome withRetryAfter(long seconds) {
        return new RefreshOutcome(fp, ok, status, code, message, details, accessToken, expiresIn, tenantId, role,
                refreshToken, minted, refreshExp, idleTtl, subjectType, Math.max(0L, seconds));
    }

    /** Never prints a credential. */
    @Override
    public String toString() {
        return "RefreshOutcome[fp=" + fp + ", ok=" + ok + ", status=" + status + ", message=" + message + ", tenantId=" + tenantId + ", role=" + role + ", idleTtl=" + idleTtl + ", subjectType=" + subjectType + "]";
    }


    /** The fingerprint of an MFA verify / recovery redeem outcome (SPEC §4.3). */
    public static final String MFA_FINGERPRINT = "mfa-verify";

    public static RefreshOutcome success(String fp, TokenResponse t, String minted) {
        return new RefreshOutcome(fp, true, 200, null, null, null, t.accessToken(), t.expiresIn(),
                t.tenantId(), t.role(), t.refreshToken(), minted, t.refreshExp(), t.idleTtl(), t.subjectType());
    }

    public static RefreshOutcome error(String fp, int status, String code, String message,
                                       Map<String, Object> details) {
        return new RefreshOutcome(fp, false, status, code, message, details, null, null, null, null, null, null,
                0L, 0L, null);
    }

    /**
     * A failure AFTER the first mint rotated the refresh token (SPEC4_2_rotate_handover): the error
     * plus the rotated session, so a waiter or a retry presents the live token, never the spent one.
     */
    public static RefreshOutcome errorCarrying(String fp, int status, String code, String message,
                                               Map<String, Object> details, String accessToken,
                                               String refreshToken, String minted) {
        return new RefreshOutcome(fp, false, status, code, message, details, accessToken, null, null, null,
                refreshToken, minted, 0L, 0L, null);
    }

    /** An error outcome that carries a rotated refresh token (and so is never a token-level failure). */
    public boolean carriesSession() {
        // SPEC4_2_carry_all rule 1: no status or code exclusion; an outcome holding a rotated token
        // is only ever built after the first mint (a first-mint failure carries nothing).
        return !ok && refreshToken != null && !refreshToken.isEmpty();
    }

    /** The outcome an MFA verify / recovery redeem leaves: only the rotated refresh token matters. */
    public static RefreshOutcome mfaVerify(String rotated, String minted) {
        return new RefreshOutcome(MFA_FINGERPRINT, true, 200, null, null, null, null, null, null, null,
                rotated, minted, 0L, 0L, null);
    }

    /** Rotated iff the response's refresh token is non-empty and differs from the candidate that minted. */
    public boolean rotated() {
        return ok && refreshToken != null && !refreshToken.isEmpty() && !refreshToken.equals(minted);
    }

    /** The mint result a same-fingerprint waiter adopts. */
    public TokenResponse toTokenResponse() {
        long exp = expiresIn instanceof Number n ? n.longValue() : 0L;
        return new TokenResponse(accessToken, refreshToken, exp, refreshExp, idleTtl, subjectType, tenantId, role);
    }

    public byte[] encode(ObjectMapper m) {
        Map<String, Object> o = new LinkedHashMap<>();
        o.put("fp", fp);
        o.put("ok", ok);
        o.put("status", status);
        o.put("code", code);
        o.put("message", message);
        o.put("details", details);
        o.put("access_token", accessToken);
        o.put("expires_in", expiresIn);
        o.put("tenant_id", tenantId);
        o.put("role", role);
        o.put("refresh_token", refreshToken);
        o.put("minted", minted);
        o.put("refresh_exp", refreshExp);
        o.put("idle_ttl", idleTtl);
        o.put("subject_type", subjectType);
        o.put("retry_after", retryAfterSeconds);
        try {
            return m.writeValueAsBytes(o);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    @SuppressWarnings("unchecked")
    public static RefreshOutcome decode(ObjectMapper m, byte[] b) throws IOException {
        Map<String, Object> o = m.readValue(b, Map.class);
        return new RefreshOutcome((String) o.get("fp"), Boolean.TRUE.equals(o.get("ok")),
                o.get("status") instanceof Number n ? n.intValue() : 500,
                (String) o.get("code"), (String) o.get("message"), (Map<String, Object>) o.get("details"),
                (String) o.get("access_token"), o.get("expires_in"), (String) o.get("tenant_id"),
                (String) o.get("role"), (String) o.get("refresh_token"), (String) o.get("minted"),
                o.get("refresh_exp") instanceof Number n ? n.longValue() : 0L,
                o.get("idle_ttl") instanceof Number n ? n.longValue() : 0L,
                (String) o.get("subject_type"),
                o.get("retry_after") instanceof Number n ? n.longValue() : 0L);
    }
}
