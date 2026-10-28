package dev.realmid.sdk.split;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.util.Arrays;
import java.util.Set;
import java.util.stream.Stream;

import static dev.realmid.sdk.split.SplitKit.*;
import static org.junit.jupiter.api.Assertions.*;

/** SPEC14_5: core sources are env (read-only) and file (atomic, 0600, KEK outside local dev). */
class ShareSourceTest {

    @Test
    void envLoadsBundleAndIsReadOnly() throws Exception {
        Key k = newKey("split-1");
        String raw = M.writeValueAsString(k.bundle("r1"));
        ShareSource src = ShareSources.env("RI_TEST_SHARE_BUNDLE", n -> raw);
        ShareSource.Loaded l = src.load();
        assertNotNull(l.bundle());
        assertEquals(k.entry().dPartner(), l.bundle().shares().get("split-1").dPartner());
        assertTrue(l.version() != null && !l.version().isEmpty(), "version empty");
        assertFalse(src instanceof WritableShareSource, "env source must be read-only (no store)");
    }

    /** A refusal, not the S7 stub's UnsupportedOperationException (which would make this test vacuous). */
    private static void assertRefuses(org.junit.jupiter.api.function.Executable e, String what) {
        RuntimeException t = assertThrows(RuntimeException.class, e, what);
        assertFalse(t instanceof UnsupportedOperationException, what + ": stub, not a refusal: " + t);
    }

    @Test
    void envUnsetOrMalformedIsAnError() {
        assertRefuses(() -> ShareSources.env("X", n -> "").load(), "unset env");
        assertRefuses(() -> ShareSources.env("X", n -> null).load(), "absent env");
        assertRefuses(() -> ShareSources.env("X", n -> "{not json").load(), "malformed env");
    }

    @Test
    void fileRoundTripMode0600AtomicAndVersioned(@TempDir Path dir) throws Exception {
        Path path = dir.resolve("shares.json");
        WritableShareSource src = ShareSources.file(path, new FileShareOptions(null, true, REALM));
        Key k = newKey("split-1");
        String v1 = src.store(k.bundle("r1"));
        ShareSource.Loaded l = src.load();
        assertEquals(k.entry().dPartner(), l.bundle().shares().get("split-1").dPartner());
        assertEquals(v1, l.version());
        assertEquals(Set.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE),
                Files.getPosixFilePermissions(path), "mode must be 0600");
        Key k2 = newKey("split-2");
        ShareBundle b2 = k.bundle("r1");
        b2.shares().put("split-2", k2.entry());
        String v2 = src.store(b2);
        assertNotEquals(v1, v2, "version did not change on write");
        try (Stream<Path> s = Files.list(dir)) {
            assertEquals(1, s.count(), "atomic rename left stray entries in the directory");
        }
    }

    @Test
    void fileRequiresKekOutsideLocalDev(@TempDir Path dir) {
        assertRefuses(() -> ShareSources.file(dir.resolve("shares.json"),
                new FileShareOptions(null, false, REALM)), "no KEK and not local dev: want a constructor error");
    }

    @Test
    void fileWithKekEncryptsAtRestAndWrongKekFails(@TempDir Path dir) throws Exception {
        Path path = dir.resolve("shares.json");
        byte[] kek = new byte[32];
        Arrays.fill(kek, (byte) 7);
        WritableShareSource src = ShareSources.file(path, new FileShareOptions(kek, false, "r1"));
        Key k = newKey("split-1");
        src.store(k.bundle("r1"));
        String raw = Files.readString(path);
        assertFalse(raw.contains(k.entry().dPartner()), "d_partner is in the file in the clear despite a KEK");
        assertEquals(k.entry().dPartner(), src.load().bundle().shares().get("split-1").dPartner());
        byte[] wrong = new byte[32];
        Arrays.fill(wrong, (byte) 9);
        WritableShareSource other = ShareSources.file(path, new FileShareOptions(wrong, false, "r1"));
        assertThrows(RuntimeException.class, other::load, "wrong KEK loaded the bundle");
    }
}
