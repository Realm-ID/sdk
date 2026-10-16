package dev.realmid.sdk.me;

import com.fasterxml.jackson.databind.JsonNode;
import dev.realmid.sdk.auth.AuthClient;
import dev.realmid.sdk.http.HttpTransport;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Consumer;

/**
 * Membership self-service — {@code realm.me()} (ADR-092 D5): settle the
 * single-tenant picker, decline an invitation, leave an org.
 *
 * <p>Every route here is authorized by the END USER, never by the platform
 * credential alone: the subject is whoever the session says it is, so no path
 * parameter names someone else. See {@link MeAuth} for the two auth modes.
 */
public final class MeClient {

    private final HttpTransport http;

    /** Writes one revoked session id into the partner's session store (ADR-104 R-e). */
    private final Consumer<String> sessionRevoker;

    public MeClient(HttpTransport http) {
        this(http, null);
    }

    /**
     * @param sessionRevoker where {@link #setPassword} writes each {@code revoked_sids} entry
     *                       (the realm's logout path); null writes nothing
     */
    public MeClient(HttpTransport http, Consumer<String> sessionRevoker) {
        this.http = http;
        this.sessionRevoker = sessionRevoker;
    }

    /**
     * Sets or changes the signed-in member's own password — {@code PUT /me/password} (ADR-104
     * R7e). Both /me lanes apply, as on every {@code realm.me()} call: the member's own bearer
     * ({@link MeAuth#bearer}) or the BFF lane (platform token + {@link MeAuth#onBehalfOf}).
     *
     * <p>A success ends every OTHER session of the person in the realm and keeps the caller's; the
     * response's {@code revoked_sids} are written into the session store before this returns, so a
     * local verify refuses those tokens (a store write error is logged, never thrown, as in
     * logout). Errors arrive typed by the SDK's usual mapping: {@code current_password_required},
     * {@code invalid_credentials} (wrong current password), {@code verified_email_required} (409);
     * {@code password_too_short} / {@code password_too_long} arrive as {@code details.server_code}.
     * The SDK does not pre-validate lengths. Both passwords are secrets and are never logged.
     */
    public PasswordSet setPassword(SetPasswordRequest req, MeAuth auth) {
        Map<String, Object> body = new LinkedHashMap<>();
        if (req.currentPassword() != null && !req.currentPassword().isEmpty()) {
            body.put("current_password", req.currentPassword());
        }
        body.put("new_password", req.newPassword());
        JsonNode raw = http.request(apply(HttpTransport.Request.of("PUT", "/me/password").body(body), auth));
        // The issuer returns a plain map here, which GoFr wraps: {"data":{status, revoked_sids}}.
        JsonNode data = raw == null ? null : raw.get("data");
        if (data == null || !data.isObject()) return new PasswordSet("", java.util.List.of());
        java.util.List<String> ids = AuthClient.sessionIds(null, data.get("revoked_sids"));
        if (sessionRevoker != null) for (String id : ids) sessionRevoker.accept(id);
        JsonNode status = data.get("status");
        return new PasswordSet(status != null && status.isTextual() ? status.asText() : "", ids);
    }

    /**
     * Answers the picker raised by {@code Session.tenantChoiceRequired} —
     * {@code POST /me/tenant-choice}. Keeps {@code tenantId}, gives up the
     * caller's other memberships in that realm.
     *
     * <p>An OWNED organization cannot be given up: {@code tenants.owner_user_id}
     * is NOT NULL, so releasing the owner's membership would strand it. The
     * server refuses with {@code owner_cannot_be_revoked} (409) BEFORE mutating
     * anything, so a rejected choice never leaves the caller half-reconciled;
     * ownership must be transferred (ADR-076) first.
     * {@code single_tenant_not_required} (409) means the realm does not require
     * single-tenant membership — there is nothing to settle.
     *
     * @param tenantId the membership to KEEP
     */
    public TenantChoiceResult chooseTenant(String tenantId, MeAuth auth) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("tenant_id", tenantId);
        HttpTransport.Request r = HttpTransport.Request.of("POST", "/me/tenant-choice").body(body);
        JsonNode raw = http.request(apply(r, auth));
        return raw == null
                ? new TenantChoiceResult(tenantId, "", 0)
                : http.mapper().convertValue(raw, TenantChoiceResult.class);
    }

    /**
     * Accepts a PENDING invitation —
     * {@code POST /me/invitations/{tenantId}/accept}.
     *
     * <p>The mirror of {@link #rejectInvitation}, and the reason both exist: a
     * realm on {@code invitation_acceptance: "explicit"} (ADR-095 D2) no longer
     * activates an invitation implicitly at login, so a decline path with no
     * matching accept path would leave an invitee able to say no and unable to
     * say yes.
     *
     * <p>On a realm using the default {@code "auto"} mode this still works — it
     * settles a row the invitee's next sign-in would have settled anyway. Only
     * an offer can be accepted: an already-active membership answers
     * {@code not_invited} (409), and an invitation already answered, revoked or
     * expired answers {@code not_pending}.
     */
    public MembershipResult acceptInvitation(String tenantId, MeAuth auth) {
        return membershipOp("/me/invitations/" + enc(tenantId) + "/accept", tenantId, auth);
    }

    /**
     * Declines a PENDING invitation —
     * {@code POST /me/invitations/{tenantId}/reject}.
     *
     * <p>Only an offer can be declined: an active member wanting out uses
     * {@link #leave} instead, and the server keeps the two apart with
     * {@code not_invited} / {@code not_pending} (409). The outcome is recorded
     * rather than deleted, and the live-invite unique index is partial, so the
     * tenant MAY invite the same person again later. A 404 deliberately does
     * not distinguish "no such tenant" from "not yours" — that difference would
     * be an existence oracle for tenant ids. {@code invitations_unavailable}
     * (501) means the issuer runs without an invitation-lifecycle store.
     */
    public MembershipResult rejectInvitation(String tenantId, MeAuth auth) {
        return membershipOp("/me/invitations/" + enc(tenantId) + "/reject", tenantId, auth);
    }

    /**
     * Ends the caller's own membership of a tenant —
     * {@code POST /me/memberships/{tenantId}/leave}. This is the recovery path
     * out of a picker-induced suspension, which is why it is authorized by the
     * caller's realm session rather than a session in the tenant being left:
     * requiring the latter would demand the very access this recovers from.
     *
     * <p>Sessions for that membership are revoked, so leaving is not cosmetic
     * for a token TTL. The tenant's OWNER is refused with
     * {@code owner_cannot_leave} (409 — transfer ownership first, ADR-076); an
     * already-ended membership answers {@code already_left} (409).
     */
    public MembershipResult leave(String tenantId, MeAuth auth) {
        return membershipOp("/me/memberships/" + enc(tenantId) + "/leave", tenantId, auth);
    }

    /** The two no-body {@code {tenant_id, status}} routes. */
    private MembershipResult membershipOp(String path, String tenantId, MeAuth auth) {
        JsonNode raw = http.request(apply(HttpTransport.Request.of("POST", path), auth));
        return raw == null
                ? new MembershipResult(tenantId, "")
                : http.mapper().convertValue(raw, MembershipResult.class);
    }

    /** Applies the end-user credential; see {@link MeAuth}. */
    private static HttpTransport.Request apply(HttpTransport.Request r, MeAuth auth) {
        if (auth == null) return r;
        if (auth.userBearer() != null && !auth.userBearer().isEmpty()) {
            return r.bearer(auth.userBearer());
        }
        if (auth.userToken() != null && !auth.userToken().isEmpty()) {
            // Additive: the platform token stays the bearer and the verified
            // user JWT names the caller.
            return r.header("X-User-Token", auth.userToken());
        }
        return r;
    }

    private static String enc(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8);
    }
}
