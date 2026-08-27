package dev.realmid.sdk.userapikeys;

import dev.realmid.sdk.Claims;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@link CapCheck#capAllows} is the one helper in this SDK whose SIGNATURE is a
 * security control (SPEC §6.6.2): the live-permission resolver is a required
 * third argument, so the insecure one-operand form — "does the cap list this
 * permission?" — cannot be written through this API at all.
 */
class CapCheckTest {

    private static Claims claimsWithCap(Object cap) {
        Map<String, Object> extra = new LinkedHashMap<>();
        if (cap != null) extra.put("permissions_cap", cap);
        return new Claims("https://auth.realmid.dev/r1", "u1", "realmid:plt_x",
                1L, 1L, 9999999999L, "jti", "azp", "t1", "member", extra);
    }

    private static CapCheck.LivePermissionResolver live(String... perms) {
        return () -> List.of(perms);
    }

    @Test
    void requiresBothOperands() {
        assertTrue(CapCheck.capAllows(claimsWithCap(List.of("reports:read")),
                "reports:read", live("reports:read", "users:read")));

        // In the cap but no longer live: the holder's role shrank. This is the case
        // the whole design exists for — a stale cap must not resurrect lost
        // authority.
        assertFalse(CapCheck.capAllows(claimsWithCap(List.of("users:manage")),
                "users:manage", live("reports:read")));

        // Live but outside the cap: the key is narrower than the human.
        assertFalse(CapCheck.capAllows(claimsWithCap(List.of("reports:read")),
                "users:manage", live("users:manage")));
    }

    @Test
    void failsClosed() {
        Claims claims = claimsWithCap(List.of("reports:read"));
        // A throwing resolver means the live operand is unknown, and the only safe
        // reading of an unknown intersection is empty.
        assertFalse(CapCheck.capAllows(claims, "reports:read", () -> {
            throw new IllegalStateException("store down");
        }));
        // A null resolver is also the shape a caller would reach for if they
        // wanted the one-operand version.
        assertFalse(CapCheck.capAllows(claims, "reports:read", null));
        assertFalse(CapCheck.capAllows(null, "reports:read", live("reports:read")));
        assertFalse(CapCheck.capAllows(claims, "", live("reports:read")));
        assertFalse(CapCheck.capAllows(claims, null, live("reports:read")));
        // A resolver returning null is a broken resolver, not an empty set.
        assertFalse(CapCheck.capAllows(claims, "reports:read", () -> null));
    }

    @Test
    void absentCapDiffersFromEmptyCap() {
        // ABSENT = not key-derived = uncapped. Only the live set governs, so an
        // ordinary session keeps working through this helper.
        assertTrue(CapCheck.capAllows(claimsWithCap(null), "users:manage", live("users:manage")));
        assertFalse(CapCheck.capAllows(claimsWithCap(null), "users:manage", live("reports:read")));

        // PRESENT but empty = capped to nothing = deny everything. Conflating this
        // with "absent" would turn every empty-cap key into a FULL-AUTHORITY one,
        // which is the worst direction for the bug to go.
        //
        // ⚠️ ADR-100 made this a state the SERVER CAN NO LONGER PRODUCE: {} is
        // not a storable cap, and an empty intersection at mint is a 403 rather
        // than an empty claim. This assertion is deliberately kept anyway. It is
        // not dead coverage — it pins the behaviour for a claim that arrives
        // GARBLED or hostile off the wire, where "I am capped, to something
        // unreadable" must still read as "to nothing". We no longer emit the
        // state; we still deny on it. Do not delete it on the grounds that the
        // issuer cannot reach it.
        assertFalse(CapCheck.capAllows(claimsWithCap(List.of()), "users:manage", live("users:manage")));
    }

    @Test
    void malformedCapIsCappedToNothing() {
        for (Object bad : new Object[]{"reports:read", 42, Map.of("reports", "read")}) {
            assertFalse(CapCheck.capAllows(claimsWithCap(bad), "reports:read", live("reports:read")),
                    "a present-but-unparseable cap must be read as capped to nothing: " + bad);
        }
        // A mixed list keeps the entries it understood: dropping junk only narrows,
        // which is always safe.
        assertTrue(CapCheck.capAllows(claimsWithCap(List.of("reports:read", 7)),
                "reports:read", live("reports:read")));
    }

    @Test
    void neverExpandsWildcardsOrHierarchy() {
        // RealmID does not pattern-match these strings, and neither may the SDK —
        // a partner who saw "users:*" work here would build a mental model the
        // server does not share.
        assertFalse(CapCheck.capAllows(claimsWithCap(List.of("users:*")), "users:read", live("users:read")));
        assertFalse(CapCheck.capAllows(claimsWithCap(List.of("users")), "users:read", live("users:read")));
        assertFalse(CapCheck.capAllows(claimsWithCap(List.of("Users:Read")), "users:read", live("users:read")));
    }

    @Test
    void revokedKeysOffRevokedAt() {
        UserAPIKey live = new UserAPIKey("k1", null, "pfx", "l", OrgScope.SELECTED,
                List.of("o1"), Boolean.FALSE, List.of("audit:read"), null, 1L, null, null, null);
        assertFalse(live.revoked());
        // uncapped=TRUE with a null cap, which is the only shape the server can
        // now return for an unrestricted key (ADR-100 D1: {} is not storable).
        UserAPIKey dead = new UserAPIKey("k2", null, "pfx", "l", OrgScope.SELECTED,
                List.of("o1"), Boolean.TRUE, null, null, 1L, null, null, 1000L);
        assertTrue(dead.revoked());
    }
}
