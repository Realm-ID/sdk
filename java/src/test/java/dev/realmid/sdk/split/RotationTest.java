package dev.realmid.sdk.split;

import dev.realmid.sdk.RealmException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.math.BigInteger;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static dev.realmid.sdk.split.SplitKit.*;
import static org.junit.jupiter.api.Assertions.*;

/**
 * SPEC14_12 / 14.5 self-rotation on a writable store (mirrors go rotation_test.go). The handshake answer is wrapped
 * {"data":{nonce,partial_ri}} (swagger required:[data]); other split routes are bare.
 */
class RotationTest {
    static final String BASE = "/platforms/" + REALM + "/signing-keys/split";

    private static List<Map<String, Object>> splitRoutes(Issuer f, boolean handshakeOk) {
        List<Map<String, Object>> ups = new ArrayList<>();
        f.on(BASE + "/rotation-lease", r -> json(200, Map.of("lease_id", "l1", "expires_at", "2026-10-29T00:00:00Z")));
        f.on(BASE, r -> {
            ups.add(r.body());
            return json(200, Map.of("status", "uploaded"));
        });
        f.on(BASE + "/k2/handshake", r -> {
            Map<String, Object> up = ups.get(ups.size() - 1);
            BigInteger n = new BigInteger(1, UB64.decode((String) up.get("n")));
            BigInteger dRI = new BigInteger(1, UB64.decode((String) up.get("d_ri")));
            String nonce = "bm9uY2U";
            byte[] msg = sha256("realmid-split-handshake/v1|" + REALM + "|k2|" + nonce);
            // GoFr envelope: the issuer returns a plain map here; lease/upload/complete are raw().
            return json(200, Map.of("data", Map.of("nonce", nonce,
                    "partial_ri", B64.encodeToString(fixed256(emsa(msg).modPow(dRI, n))))));
        });
        f.on(BASE + "/k2/handshake/complete", r -> handshakeOk
                ? json(200, Map.of("status", "ok"))
                : err(401, "handshake_failed", "no"));
        return ups;
    }

    @Test
    void fileStoreHappyPathOrderAndNoActor(@TempDir Path dir) throws Exception {
        try (Issuer f = new Issuer()) {
            List<Map<String, Object>> ups = splitRoutes(f, true);
            Key old = newKey("k1");
            WritableShareSource src = ShareSources.file(dir.resolve("s.json"), new FileShareOptions(null, true, REALM));
            src.store(old.bundle(REALM));
            f.realm(null).signingKeys().rotateSplit(src, new RotateSplitOptions("k2", false));
            List<String> want = List.of("POST " + BASE + "/rotation-lease", "POST " + BASE,
                    "POST " + BASE + "/k2/handshake", "POST " + BASE + "/k2/handshake/complete");
            List<String> seq = new ArrayList<>();
            for (String p : f.paths()) if (!p.equals("POST /auth/token") && !p.equals("GET /platforms/mine")) seq.add(p);
            assertEquals(want, seq, "call sequence");
            for (Seen s : f.all()) {
                if (s.path().equals("/auth/token") || s.path().equals("/platforms/mine")) continue;
                assertEquals("Bearer ptok", s.auth(), s.path() + ": rotation is the platform token (R67.3)");
                assertNull(s.userToken(), s.path() + ": rotation carries no actor (R67.3)");
            }
            assertEquals(1, ups.size(), "uploads");
            ShareBundle b = src.load().bundle();
            ShareEntry e = b.shares().get("k2");
            assertNotNull(e, "new share not stored");
            BigInteger n = new BigInteger(1, UB64.decode(e.n()));
            BigInteger d = new BigInteger(1, UB64.decode((String) ups.get(0).get("d_ri")))
                    .add(new BigInteger(1, UB64.decode(e.dPartner())));
            BigInteger m = BigInteger.valueOf(123456789);
            assertEquals(m, m.modPow(d, n).modPow(BigInteger.valueOf(65537), n),
                    "d_ri + d_partner is not the private exponent of the uploaded public key");
            assertEquals(1, b.previous().size(), "rotation must keep k1 as previous");
            assertEquals("k1", b.previous().get(0).kid());
            assertTrue(b.previous().get(0).trustUntil() != 0, "previous key lacks trust_until");
        }
    }

    @Test
    void recoveryKeepsNoPreviousKey() throws Exception {
        try (Issuer f = new Issuer()) {
            splitRoutes(f, true);
            MemShares src = new MemShares(newKey("k1").bundle(REALM));
            f.realm(null).signingKeys().rotateSplit(src, new RotateSplitOptions("k2", true));
            assertTrue(src.bundle.shares().containsKey("k2"), "recovery stored no new share");
            assertTrue(src.bundle.previous() == null || src.bundle.previous().isEmpty(),
                    "recovery = no overlap, but previous = " + src.bundle.previous());
        }
    }

    @Test
    void handshakeFailureStopsAndDoesNotLoop() throws Exception {
        try (Issuer f = new Issuer()) {
            splitRoutes(f, false);
            MemShares src = new MemShares(newKey("k1").bundle(REALM));
            assertThrows(RealmException.class,
                    () -> f.realm(null).signingKeys().rotateSplit(src, new RotateSplitOptions("k2", false)),
                    "handshake failure returned normally");
            assertEquals(1, f.reqs(BASE + "/k2/handshake/complete").size(), "handshake/complete calls (stop, never loop)");
            assertEquals(1, f.reqs(BASE).size(), "upload calls");
        }
    }

    @Test
    void leaseHeldStopsBeforeKeygenOrUpload() throws Exception {
        try (Issuer f = new Issuer()) {
            f.on(BASE + "/rotation-lease", r -> err(409, "rotation_lease_held", "held"));
            MemShares src = new MemShares(newKey("k1").bundle(REALM));
            assertThrows(RealmException.class,
                    () -> f.realm(null).signingKeys().rotateSplit(src, new RotateSplitOptions("k2", false)),
                    "lease held: want a RealmException");
            assertEquals(0, f.reqs(BASE).size(), "uploaded despite a held lease");
            assertFalse(src.bundle.shares().containsKey("k2"), "stored a new share despite a held lease");
        }
    }

    @Test
    void envSourceCannotRotateAndSendsNothing() throws Exception {
        try (Issuer f = new Issuer()) {
            ShareSource env = ShareSources.env("RI_TEST_SHARE_BUNDLE", n -> "{\"realm\":\"r\",\"shares\":{}}");
            assertThrows(RealmException.class,
                    () -> f.realm(null).signingKeys().rotateSplit(env, new RotateSplitOptions("k2", false)),
                    "env source rotation: want a RealmException (read-only; rotation_due path)");
            for (String p : f.paths()) assertEquals("POST /auth/token", p, "env-source rotation sent " + p);
        }
    }

    @Test
    void uploadCarriesLeaseId() throws Exception {
        try (Issuer f = new Issuer()) {
            List<Map<String, Object>> ups = splitRoutes(f, true);
            MemShares src = new MemShares(newKey("k1").bundle(REALM));
            f.realm(null).signingKeys().rotateSplit(src, new RotateSplitOptions("k2", false));
            assertEquals(1, ups.size());
            assertEquals("l1", ups.get(0).get("lease_id"), "upload must carry the lease call's lease_id");
        }
    }

    @Test
    void uploadLeaseHeldSurfacesAndIsNotRetried() throws Exception {
        try (Issuer f = new Issuer()) {
            f.on(BASE + "/rotation-lease", r -> json(200, Map.of("lease_id", "l1", "expires_at", "2026-10-29T00:00:00Z")));
            f.on(BASE, r -> err(409, "rotation_lease_held", "held"));
            MemShares src = new MemShares(newKey("k1").bundle(REALM));
            RealmException e = assertThrows(RealmException.class,
                    () -> f.realm(null).signingKeys().rotateSplit(src, new RotateSplitOptions("k2", false)));
            assertEquals(409, e.getHttpStatus());
            assertEquals(1, f.reqs(BASE).size(), "upload must not be retried");
        }
    }
}
