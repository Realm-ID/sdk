package dev.realmid.sdk.scope;

import dev.realmid.sdk.Claims;
import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.RealmException;

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

    // ---- ADR-097 mint half: turning a scope list into the wire value ----
    //
    // Everything else here READS a `scope` claim. This WRITES one. It is the
    // operand the enforcement layer evaluates, and until java 0.39.0 /
    // go 0.49.0 / ts 0.42.0 no SDK could put it on the wire at all — so
    // ScopePolicy was reachable only by a partner who bypassed the SDK and
    // hand-rolled POST /auth/token.

    /**
     * Joins a scope list into the wire's space-delimited string (RFC 6749 §3.3),
     * refusing any entry that would not survive the round trip.
     *
     * <p>Returns {@code null} for a null or empty list, which the caller omits
     * from the body entirely: the issuer's {@code parseScope} trims and returns
     * nil for {@code ""}, so an empty scope and an absent one are the same
     * request.
     *
     * <p>Throws {@link RealmException} with {@link ErrorCode#BAD_REQUEST} for an
     * unsendable entry. Joining it anyway would not fail — it would SUCCEED and
     * mint a different set of scopes than the caller asked for, which is the
     * whole reason the SDK takes a list rather than the raw wire string.
     *
     * <p>The per-realm bounds ({@code max_permission_strings},
     * {@code max_permission_string_len}) are NOT checked here: those are realm
     * configuration and a client-side copy would drift into refusing what the
     * server accepts. The charset is fixed by RFC and cannot.
     */
    public static String wireValue(List<String> scopes) {
        if (scopes == null || scopes.isEmpty()) return null;
        for (String s : scopes) {
            if (!isRfc6749ScopeToken(s)) {
                throw new RealmException(ErrorCode.BAD_REQUEST,
                        "realmid: scope entry is not an RFC 6749 §3.3 scope-token: \"" + s
                        + "\" — entries are joined with a space, so one containing a space, "
                        + "a quote, a backslash or a non-printable byte would silently become "
                        + "a different set of scopes than you asked for");
            }
        }
        return String.join(" ", scopes);
    }
}
