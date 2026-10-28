package dev.realmid.sdk.split;

import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.RealmException;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static dev.realmid.sdk.split.SplitKit.*;
import static org.junit.jupiter.api.Assertions.*;

/** SPEC14_4: a split verifier trusts the bundle's public keys only, never RI's JWKS (mirrors go trust_test.go). */
class TrustTest {

    private static String jwks(Issuer f) { return "/" + REALM + "/.well-known/jwks.json"; }

    @Test
    void splitRealmWithoutShareSourceFailsToConstruct() throws Exception {
        try (Issuer f = new Issuer()) {
            assertThrows(RuntimeException.class, () -> f.realm(b -> b.split(true)),
                    "build() with split(true) and no shareSource succeeded; want a construction error (R4)");
        }
    }

    @Test
    void bundleKeyAcceptedAndRiJwksNeverFetched() throws Exception {
        Key k = newKey("split-1");
        try (Issuer f = new Issuer()) {
            f.on(jwks(f), r -> json(200, Map.of("keys", List.of())));
            Realm r = f.realm(b -> b.split(true).shareSource(new MemShares(k.bundle(REALM))));
            assertNotNull(r.verify(k.fullJwt(userClaims(f.issuer()))), "token under a pinned bundle key refused");
            assertEquals(0, f.reqs(jwks(f)).size(), "split verifier fetched RI's JWKS");
        }
    }

    @Test
    void riPublishedKidRefusedAsUnpinned() throws Exception {
        Key bundleKey = newKey("split-1");
        Key riKey = newKey("ri-full-1"); // published in RI's JWKS, not in the bundle
        try (Issuer f = new Issuer()) {
            f.on(jwks(f), r -> json(200, Map.of("keys", List.of(Map.of("kty", "RSA", "kid", "ri-full-1", "alg", "RS256",
                    "use", "sig", "n", b64(riKey.pub.getModulus()), "e", "AQAB")))));
            Realm r = f.realm(b -> b.split(true).shareSource(new MemShares(bundleKey.bundle(REALM))));
            RealmException e = assertThrows(RealmException.class, () -> r.verify(riKey.fullJwt(userClaims(f.issuer()))));
            assertEquals(ErrorCode.UNPINNED_KID, e.getCode(), "RI-published kid: " + e);
        }
    }

    @Test
    void previousKeyTrustedUntilTrustUntil() throws Exception {
        Key cur = newKey("split-2");
        Key old = newKey("split-1");
        try (Issuer f = new Issuer()) {
            Instant now = Instant.now();
            ShareBundle base = cur.bundle(REALM);
            ShareBundle b = new ShareBundle(REALM, base.shares(), List.of(new PreviousKey("split-1",
                    b64(old.pub.getModulus()), "AQAB", now.plusSeconds(3600).getEpochSecond())));
            AtomicReference<Instant> clock = new AtomicReference<>(now);
            Clock c = new Clock() {
                @Override public ZoneOffset getZone() { return ZoneOffset.UTC; }
                @Override public Clock withZone(java.time.ZoneId z) { return this; }
                @Override public Instant instant() { return clock.get(); }
            };
            Realm r = f.realm(x -> x.split(true).shareSource(new MemShares(b)).clock(c));
            assertNotNull(r.verify(old.fullJwt(userClaims(f.issuer()))), "previous key inside trust_until refused");
            Instant later = now.plus(Duration.ofHours(2));
            clock.set(later);
            Map<String, Object> claims = userClaims(f.issuer());
            claims.put("iat", later.getEpochSecond());
            claims.put("exp", later.plusSeconds(600).getEpochSecond());
            RealmException e = assertThrows(RealmException.class, () -> r.verify(old.fullJwt(claims)));
            assertEquals(ErrorCode.UNPINNED_KID, e.getCode(), "previous key past trust_until: " + e);
        }
    }
}
