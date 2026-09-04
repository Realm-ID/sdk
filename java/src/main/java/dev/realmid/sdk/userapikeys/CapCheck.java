package dev.realmid.sdk.userapikeys;

import dev.realmid.sdk.Claims;

import java.util.ArrayList;
import java.util.List;

/**
 * The ADR-084 permissions-cap intersection (SPEC §6.6.2).
 *
 * <p>Effective authority is {@code permissions_cap ∩ live permissions},
 * re-resolved per request, so a cap can only ever UNDER-grant: demote the holder
 * and every key they hold shrinks with them.
 */
public final class CapCheck {

    /**
     * Returns the permissions a principal holds RIGHT NOW, from the caller's own
     * store. The second operand of the intersection.
     *
     * <p><b>⚠️ It must NOT derive its answer from the token's own claims.</b> A
     * resolver like {@code () -> PERMS_BY_ROLE.get(claims.role())} has the right
     * SHAPE — two operands, required parameter satisfied — and re-introduces
     * exactly the staleness this signature exists to remove, because
     * {@code role} is on the token. A demoted admin's token still says
     * {@code admin}, so the resolver returns admin permissions and
     * {@code capAllows} correctly allows them. Such a resolver is live with
     * respect to what a ROLE can do and stale with respect to WHICH role the
     * person holds — the case that matters. Key it off {@code claims.subject()}
     * and read the authority from your store.
     */
    @FunctionalInterface
    public interface LivePermissionResolver {
        List<String> resolve() throws Exception;
    }

    /**
     * Reports whether {@code permission} is allowed for a key-derived token.
     *
     * <p><b>⚠️ READ THIS FIRST: the intersection only exists for KEY-DERIVED
     * tokens.</b> {@code permissions_cap} is minted in exactly one place in the
     * issuer — the {@code grant_type=user_api_key} exchange — so a PLAIN USER
     * SESSION never carries one. On such a token this reduces to "does the live
     * set allow it?", a ONE-operand check, and the cap contributes nothing. If
     * you are gating human sessions, the safety property below is not the one
     * you are getting: your resolver is the whole of the decision and must be
     * correct on its own.
     *
     * <p><b>{@code resolveLive} is a required parameter, not an option</b>, and
     * that is the entire design of this signature: the insecure one-operand form —
     * "does the cap list this permission?" — is not expressible through this API,
     * so a partner cannot implement the stale-scope semantics ADR-084 rejected by
     * accident.
     *
     * <p>Fails CLOSED. Returns false when the cap omits the permission, when the
     * live set omits it, when the resolver throws, or when either argument is
     * null. An unavailable live operand means the intersection is unknown, and the
     * only safe reading of an unknown intersection is empty.
     *
     * <p>An ABSENT {@code permissions_cap} claim means the token is not
     * key-derived and is not capped; only the live set governs. A PRESENT-but-empty
     * cap means "capped to nothing" and denies everything. Those are different
     * states and must not be conflated — conflating them would turn every
     * empty-cap key into a full-authority one.
     *
     * <p>No pattern matching: RealmID never expands wildcards, applies hierarchy,
     * or implies {@code *}, and neither does this.
     */
    public static boolean capAllows(Claims claims, String permission, LivePermissionResolver resolveLive) {
        if (claims == null || permission == null || permission.isEmpty() || resolveLive == null) {
            return false;
        }
        List<String> cap = capFromClaims(claims);
        if (cap != null && !cap.contains(permission)) {
            return false;
        }
        List<String> live;
        try {
            live = resolveLive.resolve();
        } catch (Exception e) {
            return false;
        }
        return live != null && live.contains(permission);
    }

    /**
     * Extracts {@code permissions_cap}. Returns null for ABSENT (not a capped
     * token) and a list — possibly empty — when the claim is PRESENT.
     *
     * <p>A present-but-unparseable claim yields an empty list: the token asserts
     * it is capped and we cannot tell to what, so the only safe reading is "capped
     * to nothing".
     */
    static List<String> capFromClaims(Claims claims) {
        Object raw = claims.extra() == null ? null : claims.extra().get("permissions_cap");
        if (raw == null) {
            // Note: a JSON null is indistinguishable from absent here, and both
            // are treated as "not capped". A capped token always carries an
            // array — the issuer writes []string{}, never null.
            return null;
        }
        if (raw instanceof List<?> list) {
            List<String> out = new ArrayList<>(list.size());
            for (Object o : list) {
                if (o instanceof String s) out.add(s);
            }
            return out;
        }
        return List.of();
    }

    private CapCheck() {}
}
