package dev.realmid.sdk.scope;

import dev.realmid.sdk.Claims;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * ADR-097 layer 1 — the scope predicate.
 *
 * <p>A partner adding an endpoint to their own product must not have to update
 * configuration inside RealmID. RealmID stores identity and attestation; the
 * PARTNER'S REPO owns the route&nbsp;-&gt;&nbsp;scope and role&nbsp;-&gt;&nbsp;scope
 * maps; this package is the gate that evaluates one against the other.
 *
 * <p>The {@code scope} claim (RFC 9068 §2.2.3, defined by reference to RFC 8693
 * §4.2, in RFC 6749 §3.3 format) is a space-delimited STRING of the partner's
 * own scope strings. RealmID never parses, validates or stores them — but it
 * DOES intersect them with any user-API-key {@code permissions_cap} at mint, so
 * the token carries ONE effective set. Nothing here has to intersect anything.
 *
 * <h2>Token scope vs {@code CapCheck.capAllows} — which to use</h2>
 *
 * <p>Both are correct; they trade different things, and mixing them without
 * deciding gets the worst of both. Token scope: no per-request I/O, revocation
 * lag equal to the realm's {@code access_ttl_seconds} (1..86400).
 * {@code capAllows}: one live read per check, ZERO revocation lag.
 *
 * <p>Use token scope by DEFAULT. Use {@code capAllows} for operations where a
 * stale grant is unacceptable — money movement, permission administration, data
 * export. {@code capAllows} is not deprecated and is not going away.
 */
public final class Scopes {

    private Scopes() {}

    /**
     * Returns the scopes a verified token carries, in the order the issuer wrote
     * them.
     *
     * <p>Returns an empty list for a token with no {@code scope} claim — which
     * every caller here treats as "no granted authority", the fail-closed
     * reading. That is also the correct reading of a token minted before ADR-097,
     * and of one whose caller simply asked for nothing.
     *
     * <p>A non-String {@code scope} yields empty. The claim is a STRING by RFC
     * 9068 §2.2.3, and quietly accepting a List here would mask a wire mismatch
     * that ought to be loud.
     */
    public static List<String> scopesFrom(Claims claims) {
        if (claims == null || claims.extra() == null) {
            return Collections.emptyList();
        }
        Object raw = claims.extra().get("scope");
        if (!(raw instanceof String s) || s.isBlank()) {
            return Collections.emptyList();
        }
        List<String> out = new ArrayList<>();
        for (String part : s.trim().split("\\s+")) {
            if (!part.isEmpty()) {
                out.add(part);
            }
        }
        return out;
    }

    /**
     * Reports whether the token carries EVERY required scope (all-of).
     *
     * <p>All-of is the default because it is the safe reading of silence: a
     * partner passing {@code ["orders:read", "orders:write"]} and getting any-of
     * would be granted on half the evidence they asked for, and nothing would
     * tell them. {@link #scopeAllowsAny} exists for the cases where any-of is
     * meant, and has to be named.
     *
     * <p>Fails CLOSED: false when claims are null, when the {@code scope} claim
     * is absent or malformed, or when ANY required scope is missing.
     *
     * <p>Called with NO required scopes it returns FALSE, not true. "Requires
     * nothing" is almost always a route someone forgot to configure, and
     * vacuous-true on an empty requirement is how a gate silently stops gating.
     * A genuinely public route is DECLARED — see {@link ScopeRule#isPublic()}.
     *
     * <p>Comparison is EXACT and CASE-SENSITIVE. No wildcards, no prefixes, no
     * hierarchy — the same rule {@code capAllows} states, for the same reason:
     * RealmID does not interpret a partner's vocabulary, and neither does this.
     */
    public static boolean scopeAllows(Claims claims, List<String> required) {
        if (required == null || required.isEmpty()) {
            return false;
        }
        Set<String> held = heldSet(claims);
        if (held.isEmpty()) {
            return false;
        }
        return held.containsAll(required);
    }

    /**
     * Reports whether the token carries AT LEAST ONE of the required scopes.
     * Same exact, case-sensitive matching and the same fail-closed rules as
     * {@link #scopeAllows}, including the empty-required case.
     */
    public static boolean scopeAllowsAny(Claims claims, List<String> required) {
        if (required == null || required.isEmpty()) {
            return false;
        }
        Set<String> held = heldSet(claims);
        for (String r : required) {
            if (held.contains(r)) {
                return true;
            }
        }
        return false;
    }

    private static Set<String> heldSet(Claims claims) {
        return new LinkedHashSet<>(scopesFrom(claims));
    }

    /**
     * RFC 6749 §3.3: {@code 1*( %x21 / %x23-5B / %x5D-7E )} — printable ASCII
     * minus SPACE, {@code "} and {@code \}.
     *
     * <p>Exposed through {@link ScopePolicy#validate()} so a partner learns at
     * STARTUP that RealmID would refuse to mint a scope they have written into
     * their route map — which would otherwise present as a route no token can
     * ever satisfy.
     */
    public static boolean isRfc6749ScopeToken(String s) {
        if (s == null || s.isEmpty()) {
            return false;
        }
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == 0x21) continue;
            if (c >= 0x23 && c <= 0x5B) continue;
            if (c >= 0x5D && c <= 0x7E) continue;
            return false;
        }
        return true;
    }
}
