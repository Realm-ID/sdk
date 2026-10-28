package dev.realmid.sdk.auth;

import dev.realmid.sdk.Realm;
import dev.realmid.sdk.me.MeAuth;
import dev.realmid.sdk.pagination.PageOpts;
import dev.realmid.sdk.split.SplitKit.Issuer;
import dev.realmid.sdk.split.SplitKit.Seen;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static dev.realmid.sdk.split.SplitKit.json;
import static org.junit.jupiter.api.Assertions.*;

/**
 * SPEC14_10_actor (R60): platform token in Authorization, the person/key/SA token in X-User-Token (mirrors go
 * escort_test.go). Java's typed surface carries the actor with {@code Realm.withUserToken}; the per-call
 * {@code MeAuth} token is the other form. Both must read as the escort form.
 */
class EscortTest {

    private static Issuer escortFake() throws Exception {
        Issuer f = new Issuer();
        f.on("/me/contacts", r -> json(200, Map.of("items", List.of())));
        f.on("/tenants/t1", r -> json(200, Map.of("id", "t1")));
        return f;
    }

    private static void checkEscort(Issuer f, String path, String wantUser) {
        List<Seen> rs = f.reqs(path);
        assertFalse(rs.isEmpty(), path + ": no request reached the issuer");
        assertEquals("Bearer ptok", rs.get(0).auth(), path + ": Authorization must be the platform token (R60)");
        assertEquals(wantUser, rs.get(0).userToken(), path + ": X-User-Token");
    }

    @Test
    void meCallSendsPlatformBearerAndUserTokenHeader() throws Exception {
        try (Issuer f = escortFake()) {
            f.realm(null).me().listContacts(MeAuth.onBehalfOf("utok")).page(PageOpts.empty());
            checkEscort(f, "/me/contacts", "utok");
        }
    }

    @Test
    void withUserTokenRidesInHeaderOnTypedCalls() throws Exception {
        try (Issuer f = escortFake()) {
            Realm r = f.realm(null).withUserToken("utok2");
            r.tenants().get("t1");
            checkEscort(f, "/tenants/t1", "utok2");
        }
    }

    /**
     * R60 removes every mode that puts a user token in the bearer slot: java {@code applyBearerTrio} and the
     * {@code userBearer} / {@code MeAuth.bearer} surface. A text scan of the main sources (the Java analogue
     * of go's AST test); the examined-file count is asserted so an empty scan cannot pass.
     */
    @Test
    void noUserBearerApiRemains() throws IOException {
        Path root = Path.of("src/main/java");
        List<Path> files;
        try (Stream<Path> s = Files.walk(root)) {
            files = s.filter(p -> p.toString().endsWith(".java")).collect(Collectors.toList());
        }
        assertTrue(files.size() >= 150, "examined only " + files.size() + " source files; the scan is not looking at the SDK");
        StringBuilder bad = new StringBuilder();
        for (Path p : files) {
            String src = Files.readString(p);
            for (String needle : new String[] {"applyBearerTrio", "userBearer", "MeAuth bearer(", "MeAuth.bearer("}) {
                if (src.contains(needle)) bad.append(root.relativize(p)).append(": ").append(needle).append('\n');
            }
        }
        assertEquals("", bad.toString(), "user-bearer API survives (R60):\n" + bad);
    }
}
