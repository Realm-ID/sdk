package dev.realmid.sdk.verifier;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.RealmException;
import org.junit.jupiter.api.Test;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Audit e-02 (owner ruling 8): the shared claim-fold vectors, sdk/SPEC.md
 * SPEC4_2_claim_fold. Runs every case (never skips), asserts the declared
 * counts and the reserved-set drift check, and drives one refusal per reason
 * through a SIGNED token so the check is proven wired into verify().
 */
class ClaimFoldVectorsTest {

    private static final ObjectMapper M = new ObjectMapper();
    private static final Path FILE = Path.of("..", "testdata", "claim-fold-vectors", "vectors.json");

    @Test
    void sharedVectors() throws Exception {
        JsonNode v = M.readTree(Files.readAllBytes(FILE));
        List<String> reserved = new ArrayList<>();
        v.get("reserved").forEach(n -> reserved.add(n.asText()));
        assertEquals(reserved.stream().sorted().toList(), ClaimFold.RESERVED.stream().sorted().toList(),
                "reserved-set drift");

        int k = 0, p = 0, failed = 0;
        for (JsonNode c : v.get("keys")) {
            k++;
            String want = c.get("expect").asText();
            String got = switch (ClaimFold.checkKey(c.get("key").asText())) {
                case ACCEPT -> "accept";
                case REFUSE_RESERVED -> "refuse_reserved";
                case REFUSE_CHARSET -> "refuse_charset";
            };
            if (!want.equals(got)) { failed++; System.err.println("key " + c.get("id").asText() + ": want " + want + " got " + got); }
        }
        for (JsonNode c : v.get("payloads")) {
            p++;
            boolean want = "accept".equals(c.get("expect").asText());
            boolean got = ClaimFold.payloadAcceptable(c.get("payload_json").asText().getBytes(StandardCharsets.UTF_8));
            if (want != got) { failed++; System.err.println("payload " + c.get("id").asText() + ": want accept=" + want); }
        }
        System.out.println("claim-fold-vectors java: ran " + k + " key + " + p + " payload cases, " + failed + " failed");
        assertTrue(k > 0 && p > 0);
        assertEquals(v.get("key_case_count").asInt(), k);
        assertEquals(v.get("payload_case_count").asInt(), p);
        assertEquals(0, failed);
    }

    private static final String REALM_ID = "01HXYZREALM";
    private static final String AUD = "example.com";

    private static String payload(String base, String extraRaw) {
        long now = Instant.now().getEpochSecond();
        return "{\"iss\":\"" + base + "/" + REALM_ID + "\",\"sub\":\"u1\",\"aud\":\"" + AUD
                + "\",\"iat\":" + now + ",\"exp\":" + (now + 600) + extraRaw + "}";
    }

    @Test
    void verifyRefusesEachReasonAsMalformed401AndAcceptsTheControl() throws Exception {
        VerifierTestKeys keys = new VerifierTestKeys();
        byte[] jwks = M.writeValueAsBytes(keys.jwks());
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/" + REALM_ID + "/.well-known/jwks.json", ex -> {
            ex.getResponseHeaders().add("content-type", "application/json");
            ex.sendResponseHeaders(200, jwks.length);
            try (OutputStream os = ex.getResponseBody()) { os.write(jwks); }
        });
        server.start();
        try {
            String base = "http://127.0.0.1:" + server.getAddress().getPort();
            Verifier ver = new Verifier(base, AUD, null, null, null, null, null, null, null, null, null, null, REALM_ID);
            assertEquals("u1", ver.verify(keys.signRaw(payload(base, ",\"outlets\":[\"o1\"]"))).subject());
            String[] refuse = {
                    ",\"Sid\":\"x\"",                  // fold of a reserved name
                    ",\"\\u017fub\":\"victim\"",        // non-ASCII after unescaping
                    ",\"outlets\":1,\"Outlets\":2",     // two non-reserved keys that fold-collide
                    ",\"outlets\":1,\"outlets\":2",     // exact duplicate
                    ",\"Acr\":\"mfa\"",                 // ruling 8
            };
            for (String extra : refuse) {
                RealmException e = assertThrows(RealmException.class,
                        () -> ver.verify(keys.signRaw(payload(base, extra))), extra);
                assertEquals(ErrorCode.MALFORMED, e.getCode(), extra);
                assertEquals(401, e.getHttpStatus(), extra);
            }
        } finally {
            server.stop(0);
        }
    }
}
