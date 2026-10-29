package dev.realmid.sdk.split;

import com.fasterxml.jackson.databind.JsonNode;
import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.RealmException;
import dev.realmid.sdk.auth.TokenRequest;
import dev.realmid.sdk.auth.TokenResponse;
import org.junit.jupiter.api.Test;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.interfaces.RSAPublicKey;
import java.security.KeyFactory;
import java.security.spec.RSAPublicKeySpec;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;

import static dev.realmid.sdk.split.SplitKit.*;
import static org.junit.jupiter.api.Assertions.*;

/**
 * SPEC14_2 / 14_3 / 14_6 (mirrors sdk/go cosign_test.go). Vectors: sdk/testdata/split-vectors/vectors.json,
 * whose handshake format is [inferred].
 */
class CosignTest {

    static final class Vectors {
        final JsonNode root;
        final ShareEntry entry;
        final RSAPublicKey pub;

        Vectors() throws Exception {
            root = M.readTree(Files.readString(Path.of("../testdata/split-vectors/vectors.json")));
            BigInteger n = hex(root.at("/key/n").asText());
            BigInteger dp = hex(root.at("/key/d_partner").asText());
            BigInteger e = BigInteger.valueOf(root.at("/key/e").asLong());
            entry = new ShareEntry(b64(n), b64(e), b64(dp));
            pub = (RSAPublicKey) KeyFactory.getInstance("RSA").generatePublic(new RSAPublicKeySpec(n, e));
        }
    }

    static BigInteger hex(String s) { return new BigInteger(1, HexFormat.of().parseHex(s)); }

    static byte[] hexb(String s) { return HexFormat.of().parseHex(s); }

    @Test
    void everyVectorSignatureVerifiesWithAStockRsaVerifier() throws Exception {
        Vectors v = new Vectors();
        JsonNode cases = v.root.get("jwt_cases");
        assertEquals(5, cases.size(), "examined jwt cases");
        for (JsonNode c : cases) {
            assertTrue(verifies(v.pub, c.get("signing_input").asText().getBytes(StandardCharsets.UTF_8),
                    hexb(c.get("s").asText())), c.get("name").asText());
        }
        // the handshake message is the digest itself, so verify the raw EMSA block: s^e mod n == EMSA(message)
        BigInteger s = hex(v.root.at("/handshake/s").asText());
        BigInteger m = s.modPow(v.pub.getPublicExponent(), v.pub.getModulus());
        assertEquals(emsa(hexb(v.root.at("/handshake/message").asText())), m, "handshake signature");
        int negatives = 0;
        for (JsonNode n : v.root.get("negative_cases")) {
            negatives++;
            String[] parts = n.get("rejected_jwt").asText().split("\\.");
            assertFalse(verifies(v.pub, (parts[0] + "." + parts[1]).getBytes(StandardCharsets.UTF_8),
                    UB64.decode(parts[2])), "negative " + n.get("name").asText() + " verifies");
        }
        assertTrue(negatives > 0, "examined negative cases");
    }

    @Test
    void completePartialReproducesEveryVectorSignature() throws Exception {
        Vectors v = new Vectors();
        for (JsonNode c : v.root.get("jwt_cases")) {
            String name = c.get("name").asText();
            byte[] sig = CoSigner.completePartial(v.entry, c.get("signing_input").asText(), hexb(c.get("s_ri").asText()));
            assertEquals(c.get("s").asText(), HexFormat.of().formatHex(sig), name + ": combined signature differs from vector s");
            assertTrue(verifies(v.pub, c.get("signing_input").asText().getBytes(StandardCharsets.UTF_8), sig),
                    name + ": result does not verify");
        }
    }

    @Test
    void completePartialRefusesCorruptOrWrongPartials() throws Exception {
        Vectors v = new Vectors();
        JsonNode c = v.root.get("jwt_cases").get(0);
        String input = c.get("signing_input").asText();
        // control: the right partial completes (so a refusal below is not just a stub throwing)
        assertNotNull(CoSigner.completePartial(v.entry, input, hexb(c.get("s_ri").asText())), "control");
        byte[] bad = hexb(c.get("s_ri").asText());
        bad[100] ^= 0x01;
        assertThrows(RealmException.class, () -> CoSigner.completePartial(v.entry, input, bad), "bit-flipped partial_ri");
        assertThrows(RealmException.class, () -> CoSigner.completePartial(v.entry, input, new byte[256]), "all-zero partial_ri");
        byte[] other = hexb(v.root.get("jwt_cases").get(1).get("s_ri").asText());
        assertThrows(RealmException.class, () -> CoSigner.completePartial(v.entry, input, other), "another message's partial_ri");
    }

    @Test
    void handshakeVector() throws Exception {
        Vectors v = new Vectors();
        JsonNode h = v.root.get("handshake");
        byte[] sig = CoSigner.completeHandshake(v.entry, h.get("realm").asText(), h.get("kid").asText(),
                h.get("nonce").asText(), hexb(h.get("s_ri").asText()));
        assertEquals(h.get("s").asText(), HexFormat.of().formatHex(sig), "handshake signature differs from vector");
    }

    @Test
    void downgradeVector() throws Exception {
        Vectors v = new Vectors();
        JsonNode d = v.root.get("downgrade");
        String pre = "realmid-split-downgrade/v1|" + d.get("realm").asText() + "|" + d.get("kid").asText() + "|"
                + d.get("nonce").asText();
        assertEquals(pre, d.get("preimage").asText());
        byte[] sig = CoSigner.completePartial(v.entry, pre, hexb(d.get("s_ri").asText()));
        assertEquals(d.get("s").asText(), HexFormat.of().formatHex(sig), "downgrade signature differs from vector");
        assertThrows(RuntimeException.class, () -> CoSigner.completeHandshake(v.entry, d.get("realm").asText(),
                d.get("kid").asText(), d.get("nonce").asText(), hexb(d.get("s_ri").asText())), "purposes must not cross");
    }

    @Test
    void coSignReleasesBasicVectorJwt() throws Exception {
        Vectors v = new Vectors();
        JsonNode c = v.root.get("jwt_cases").get(0);
        String[] hp = c.get("signing_input").asText().split("\\.", 2);
        String got = CoSigner.coSign(v.entry, "https://auth.realmid.dev/r1",
                new PartialSigning("k1", hp[0], hp[1], B64.encodeToString(hexb(c.get("s_ri").asText()))));
        assertEquals(c.get("jwt").asText(), got, "jwt differs from vector");
    }

    private static PartialSigning signedBy(Key k, String typ, String iss) {
        Map<String, Object> claims = new LinkedHashMap<>();
        claims.put("iss", iss);
        claims.put("sub", "u");
        String[] hp = k.signingInput(typ, claims);
        return new PartialSigning(k.kid, hp[0], hp[1], B64.encodeToString(k.riPartial(sha256(hp[0] + "." + hp[1]))));
    }

    @Test
    void refusesForeignIssuerAndTyp() {
        Key k = newKey("k1");
        String iss = "https://auth.example/r1";
        String ok = CoSigner.coSign(k.entry(), iss, signedBy(k, "JWT", iss));
        assertTrue(ok != null && !ok.isEmpty(), "control (good iss/typ) refused");
        assertThrows(RealmException.class, () -> CoSigner.coSign(k.entry(), iss, signedBy(k, "JWT", "https://evil.example/r1")),
                "foreign iss");
        assertThrows(RealmException.class, () -> CoSigner.coSign(k.entry(), iss, signedBy(k, "at+evil", iss)), "foreign typ");
    }

    @Test
    void verifyBeforeReleaseWrongShareYieldsNoToken() {
        Key k = newKey("k1");
        Key other = newKey("k1"); // the partner holds a share of a DIFFERENT key
        String iss = "https://auth.example/r1";
        assertThrows(RealmException.class, () -> CoSigner.coSign(other.entry(), iss, signedBy(k, "JWT", iss)),
                "a mismatched share must not release a token");
    }

    @Test
    void shareNeverPrintedByToString() {
        Key k = newKey("k1");
        ShareEntry e = k.entry();
        ShareBundle b = k.bundle("r1");
        assertFalse(e.toString().contains(e.dPartner()), "ShareEntry.toString printed d_partner");
        assertFalse(b.toString().contains(e.dPartner()), "ShareBundle.toString printed d_partner");
    }

    @Test
    void splitRealmTokenUsesPartialEndpointAndFinishes() throws Exception {
        Key k = newKey("split-1");
        try (Issuer f = new Issuer()) {
            Map<String, Object> claims = userClaims(f.issuer());
            f.on("/auth/token/partial", r -> json(200, k.partialAnswer(claims, "rt-rotated")));
            Realm r = f.realm(b -> b.split(true).shareSource(new MemShares(k.bundle(REALM))));
            TokenResponse out = r.auth().token(TokenRequest.of("rt-old", "t1"));
            assertEquals("rt-rotated", out.refreshToken(), "rotated refresh token not stored");
            assertTrue(f.userMints().isEmpty(), "a split realm minted a user token at /auth/token: " + f.userMints());
            String[] parts = out.accessToken().split("\\.");
            assertEquals(3, parts.length, "access token is not a finished JWT: " + out.accessToken());
            assertTrue(verifies(k.pub, (parts[0] + "." + parts[1]).getBytes(StandardCharsets.UTF_8), UB64.decode(parts[2])),
                    "finished token does not verify under the split key");
            var pr = f.reqs("/auth/token/partial");
            assertEquals(1, pr.size());
            assertEquals("Bearer ptok", pr.get(0).auth());
            assertEquals("rt-old", pr.get(0).body().get("refresh_token"));
        }
    }

    @Test
    void splitRealmCorruptPartialReleasesNoToken() throws Exception {
        Key k = newKey("split-1");
        try (Issuer f = new Issuer()) {
            f.on("/auth/token/partial", r -> {
                Map<String, Object> a = k.partialAnswer(userClaims(f.issuer()), "rt2");
                @SuppressWarnings("unchecked")
                Map<String, Object> signing = (Map<String, Object>) a.get("signing");
                signing.put("partial_ri", B64.encodeToString(new byte[256]));
                return json(200, a);
            });
            Realm r = f.realm(b -> b.split(true).shareSource(new MemShares(k.bundle(REALM))));
            // the exchange must be refused as a corrupt partial, i.e. the call reaches the partial endpoint
            try {
                TokenResponse out = r.auth().token(TokenRequest.of("rt", "t1"));
                assertTrue(out == null || out.accessToken() == null || out.accessToken().isEmpty(),
                        "corrupt partial released an access token");
            } catch (RealmException expected) {
                // refusal is the wanted outcome
            }
            assertEquals(1, f.reqs("/auth/token/partial").size(), "the split realm never called /auth/token/partial");
        }
    }
}
