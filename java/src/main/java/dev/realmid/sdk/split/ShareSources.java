package dev.realmid.sdk.split;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.RealmException;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.function.Function;

/**
 * Core share sources, stdlib only (SPEC 14.5; mirrors sdk/go sharesource.go): environment (read-only) and file
 * (atomic rename, mode 0600, KEK outside local dev). A share is never logged or printed; every failure is a
 * {@link RealmException} with {@link ErrorCode#SHARE_LOAD_FAILED}.
 */
public final class ShareSources {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Base64.Encoder B64 = Base64.getUrlEncoder().withoutPadding();
    private static final SecureRandom RND = new SecureRandom();

    private ShareSources() {}

    private static RealmException fail(String m) {
        return new RealmException(ErrorCode.SHARE_LOAD_FAILED, "realmid: " + m);
    }

    private static byte[] sha256(byte[]... parts) {
        try {
            MessageDigest d = MessageDigest.getInstance("SHA-256");
            for (byte[] p : parts) d.update(p);
            return d.digest();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static String version(byte[] raw) {
        return HexFormat.of().formatHex(sha256(raw), 0, 8);
    }

    private static ShareBundle parseBundle(byte[] raw) {
        ShareBundle b;
        try {
            b = JSON.readValue(raw, ShareBundle.class);
        } catch (Exception e) {
            // Jackson's message can echo input bytes; say nothing about them.
            throw fail("share bundle is not valid JSON");
        }
        if (b == null) throw fail("share bundle is not valid JSON");
        return b.shares() != null ? b : new ShareBundle(b.realm(), new HashMap<>(), b.previous());
    }

    /** Read-only source over one environment variable. */
    public static ShareSource env(String name) {
        return env(name, System::getenv);
    }

    /** The same, reading through {@code lookup} (a test seam: Java cannot set an environment variable). */
    public static ShareSource env(String name, Function<String, String> lookup) {
        return () -> {
            String raw = lookup.apply(name);
            if (raw == null || raw.isEmpty()) throw fail("share bundle environment variable " + name + " is not set");
            byte[] b = raw.getBytes(StandardCharsets.UTF_8);
            return new ShareSource.Loaded(parseBundle(b), version(b));
        };
    }

    /** Writable file source: atomic rename, mode 0600, KEK unless local dev. */
    public static WritableShareSource file(Path path, FileShareOptions opts) {
        return new FileSource(path, opts);
    }

    private static final class FileSource implements WritableShareSource {
        private final Path path;
        private final SecretKeySpec key; // null = plaintext (local dev)
        private final String kid;
        private final byte[] aad;

        FileSource(Path path, FileShareOptions opts) {
            this.path = path;
            if (opts.kek() != null && opts.kek().length > 0) {
                if (opts.kek().length != 32) throw fail("the share-file KEK must be 32 bytes");
                if (opts.realm() == null || opts.realm().isEmpty()) {
                    throw fail("a share file with a KEK needs FileShareOptions.realm (the envelope is bound to the realm)");
                }
                key = new SecretKeySpec(opts.kek(), "AES");
                kid = HexFormat.of().formatHex(
                        sha256("realmid-kek-id/v1".getBytes(StandardCharsets.UTF_8), opts.kek())).substring(0, 16);
                aad = ("realmid-share/v1|" + opts.realm() + "|" + kid).getBytes(StandardCharsets.UTF_8);
            } else if (opts.localDev()) {
                key = null;
                kid = null;
                aad = null;
            } else {
                throw fail("a share file needs a KEK outside local development (FileShareOptions.kek)");
            }
        }

        @Override
        public synchronized Loaded load() {
            byte[] raw;
            try {
                raw = Files.readAllBytes(path);
            } catch (IOException e) {
                throw fail("read share file: " + e.getClass().getSimpleName());
            }
            byte[] plain = raw;
            if (key != null) {
                try {
                    var env = JSON.readTree(raw);
                    if (env == null || env.path("v").asInt() != 1 || !"A256GCM".equals(env.path("alg").asText())) {
                        throw fail("share file is not an encrypted bundle");
                    }
                    if (!kid.equals(env.path("kek_id").asText())) {
                        throw fail("share file is sealed under KEK \"" + env.path("kek_id").asText()
                                + "\", not the configured \"" + kid + "\"");
                    }
                    byte[] nonce = Base64.getUrlDecoder().decode(env.path("nonce").asText());
                    byte[] ct = Base64.getUrlDecoder().decode(env.path("ct").asText());
                    if (nonce.length != 12) throw fail("share file envelope is malformed");
                    Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
                    c.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, nonce));
                    c.updateAAD(aad);
                    plain = c.doFinal(ct);
                } catch (RealmException e) {
                    throw e;
                } catch (javax.crypto.AEADBadTagException e) {
                    throw fail("share file did not decrypt (wrong KEK or realm?)");
                } catch (Exception e) {
                    throw fail("share file envelope is malformed");
                }
            }
            return new Loaded(parseBundle(plain), version(raw));
        }

        @Override
        public synchronized String store(ShareBundle b) {
            byte[] out;
            try {
                byte[] plain = JSON.writeValueAsBytes(b);
                out = plain;
                if (key != null) {
                    byte[] nonce = new byte[12];
                    RND.nextBytes(nonce);
                    Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
                    c.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(128, nonce));
                    c.updateAAD(aad);
                    ObjectNode env = JSON.createObjectNode();
                    env.put("v", 1);
                    env.put("alg", "A256GCM");
                    env.put("kek_id", kid);
                    env.put("nonce", B64.encodeToString(nonce));
                    env.put("ct", B64.encodeToString(c.doFinal(plain)));
                    out = JSON.writeValueAsBytes(env);
                }
            } catch (Exception e) {
                throw fail("encode share file");
            }
            Path dir = path.toAbsolutePath().getParent();
            Path tmp = null;
            try {
                tmp = Files.createTempFile(dir, ".shares-", ".tmp",
                        PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
                try (FileChannel ch = FileChannel.open(tmp, StandardOpenOption.WRITE)) {
                    ByteBuffer bb = ByteBuffer.wrap(out);
                    while (bb.hasRemaining()) ch.write(bb);
                    ch.force(true);
                }
                try {
                    Files.move(tmp, path, StandardCopyOption.ATOMIC_MOVE);
                } catch (AtomicMoveNotSupportedException e) {
                    Files.move(tmp, path, StandardCopyOption.REPLACE_EXISTING);
                }
                tmp = null;
            } catch (IOException e) {
                throw fail("write share file: " + e.getClass().getSimpleName());
            } finally {
                if (tmp != null) {
                    try { Files.deleteIfExists(tmp); } catch (IOException ignored) { }
                }
            }
            return version(out);
        }
    }
}
