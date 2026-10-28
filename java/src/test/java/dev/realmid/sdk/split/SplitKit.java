package dev.realmid.sdk.split;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.session.MemorySessionStore;

import java.io.IOException;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.interfaces.RSAPrivateCrtKey;
import java.security.interfaces.RSAPublicKey;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;

/**
 * Shared fixtures for the split-signing / escort red tests (S3, mirrors sdk/go split_testutil_test.go).
 * A fake issuer records Authorization and X-User-Token per request and serves the platform mint ONLY at
 * {@code /auth/token} (R49/R71); a platform_api_key sent to {@code /auth/login} is answered 400
 * {@code login_grant_removed}.
 */
public final class SplitKit {
    private SplitKit() {}

    public static final String REALM = "01HREALM";
    public static final String AUD = "acme.test";
    public static final ObjectMapper M = new ObjectMapper();
    public static final Base64.Encoder B64 = Base64.getUrlEncoder().withoutPadding();
    public static final Base64.Decoder UB64 = Base64.getUrlDecoder();
    private static final SecureRandom RND = new SecureRandom();

    public static String b64(BigInteger i) {
        byte[] b = i.toByteArray();
        if (b.length > 1 && b[0] == 0) b = java.util.Arrays.copyOfRange(b, 1, b.length);
        return B64.encodeToString(b);
    }

    public static byte[] fixed256(BigInteger i) {
        byte[] b = i.toByteArray();
        byte[] out = new byte[256];
        int src = Math.max(0, b.length - 256);
        System.arraycopy(b, src, out, 256 - (b.length - src), b.length - src);
        return out;
    }

    public static byte[] sha256(String s) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** EMSA-PKCS1-v1_5 encoding of a SHA-256 digest into 256 bytes, as an integer. */
    public static BigInteger emsa(byte[] digest) {
        byte[] prefix = {0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, (byte) 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02,
                0x01, 0x05, 0x00, 0x04, 0x20};
        int tLen = prefix.length + digest.length;
        byte[] em = new byte[256];
        em[1] = 0x01;
        for (int i = 2; i < 256 - tLen - 1; i++) em[i] = (byte) 0xff;
        System.arraycopy(prefix, 0, em, 256 - tLen, prefix.length);
        System.arraycopy(digest, 0, em, 256 - digest.length, digest.length);
        return new BigInteger(1, em);
    }

    public static boolean verifies(RSAPublicKey pub, byte[] signingInput, byte[] sig) {
        try {
            Signature s = Signature.getInstance("SHA256withRSA");
            s.initVerify(pub);
            s.update(signingInput);
            return s.verify(sig);
        } catch (Exception e) {
            return false;
        }
    }

    /** An RSA-2048 key with d = d_ri + d_partner (mod lambda). */
    public static final class Key {
        public final String kid;
        public final RSAPublicKey pub;
        public final KeyPair pair;
        public final BigInteger dRI;
        public final BigInteger dP;

        Key(String kid) throws Exception {
            this.kid = kid;
            KeyPairGenerator g = KeyPairGenerator.getInstance("RSA");
            g.initialize(2048);
            this.pair = g.generateKeyPair();
            this.pub = (RSAPublicKey) pair.getPublic();
            RSAPrivateCrtKey priv = (RSAPrivateCrtKey) pair.getPrivate();
            BigInteger p1 = priv.getPrimeP().subtract(BigInteger.ONE);
            BigInteger q1 = priv.getPrimeQ().subtract(BigInteger.ONE);
            BigInteger lam = p1.multiply(q1).divide(p1.gcd(q1));
            BigInteger d = priv.getPrivateExponent().mod(lam);
            this.dRI = new BigInteger(lam.bitLength() - 1, RND);
            this.dP = d.subtract(dRI).mod(lam);
        }

        public ShareEntry entry() {
            return new ShareEntry(b64(pub.getModulus()), b64(pub.getPublicExponent()), b64(dP));
        }

        public ShareBundle bundle(String realm) {
            Map<String, ShareEntry> shares = new LinkedHashMap<>();
            shares.put(kid, entry());
            return new ShareBundle(realm, shares, new ArrayList<>());
        }

        public byte[] riPartial(byte[] digest) {
            return fixed256(emsa(digest).modPow(dRI, pub.getModulus()));
        }

        /** {header, payload} base64url segments of an RS256 JWT carrying {@code claims}. */
        public String[] signingInput(Map<String, Object> claims) {
            return signingInput("JWT", claims);
        }

        public String[] signingInput(String typ, Map<String, Object> claims) {
            try {
                Map<String, Object> hdr = new LinkedHashMap<>();
                hdr.put("alg", "RS256");
                hdr.put("typ", typ);
                hdr.put("kid", kid);
                return new String[] {B64.encodeToString(M.writeValueAsBytes(hdr)),
                        B64.encodeToString(M.writeValueAsBytes(claims))};
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        }

        /** A whole-signed JWT (what a verifier sees after co-signing). */
        public String fullJwt(Map<String, Object> claims) {
            try {
                String[] hp = signingInput(claims);
                Signature s = Signature.getInstance("SHA256withRSA");
                s.initSign(pair.getPrivate());
                s.update((hp[0] + "." + hp[1]).getBytes(StandardCharsets.UTF_8));
                return hp[0] + "." + hp[1] + "." + B64.encodeToString(s.sign());
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        }

        /** The {@code /auth/token/partial} body for {@code claims}. */
        public Map<String, Object> partialAnswer(Map<String, Object> claims, String refresh) {
            String[] hp = signingInput(claims);
            Map<String, Object> signing = new LinkedHashMap<>();
            signing.put("kid", kid);
            signing.put("header", hp[0]);
            signing.put("payload", hp[1]);
            signing.put("partial_ri", B64.encodeToString(riPartial(sha256(hp[0] + "." + hp[1]))));
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("status", "ok");
            out.put("token_type", "partial");
            out.put("subject_type", "user");
            out.put("expires_in", 600);
            out.put("signing", signing);
            if (refresh != null && !refresh.isEmpty()) out.put("refresh_token", refresh);
            return out;
        }
    }

    public static Key newKey(String kid) {
        try {
            return new Key(kid);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    public static Map<String, Object> userClaims(String iss) {
        long now = System.currentTimeMillis() / 1000;
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("iss", iss);
        c.put("sub", "01HUSER");
        c.put("aud", AUD);
        c.put("iat", now);
        c.put("exp", now + 600);
        return c;
    }

    /** In-memory writable share source. */
    public static final class MemShares implements WritableShareSource {
        public volatile ShareBundle bundle;
        private volatile int version;

        public MemShares(ShareBundle b) { this.bundle = b; }

        @Override public Loaded load() { return new Loaded(bundle, Integer.toString(version)); }

        @Override public String store(ShareBundle b) {
            this.bundle = b;
            return Integer.toString(++version);
        }
    }

    /** One recorded issuer request. */
    public record Seen(String method, String path, String auth, String userToken, Map<String, Object> body) {}

    @FunctionalInterface
    public interface Handler {
        FakeServer.Reply handle(Seen req);
    }

    public static FakeServer.Reply json(int status, Object body) { return FakeServer.Reply.json(status, body); }

    public static FakeServer.Reply err(int status, String code, String message) {
        return json(status, Map.of("error", Map.of("code", code, "message", message)));
    }

    /** The fake issuer. */
    public static final class Issuer implements AutoCloseable {
        public final FakeServer fs;
        /** An issuer from before R49: no {@code /auth/token} at all. */
        public volatile boolean oldIssuer;
        private final List<Seen> seen = Collections.synchronizedList(new ArrayList<>());
        private final Map<String, Handler> handlers = new ConcurrentHashMap<>();

        public Issuer() throws IOException {
            fs = new FakeServer();
            for (String m : new String[] {"GET", "POST", "PUT", "PATCH", "DELETE"}) {
                fs.on(m + " /*", (ex, raw) -> {
                    Map<String, Object> body = new LinkedHashMap<>();
                    if (raw != null && raw.length > 0) {
                        try {
                            @SuppressWarnings("unchecked")
                            Map<String, Object> p = M.readValue(raw, Map.class);
                            if (p != null) body = p;
                        } catch (Exception ignored) { }
                    }
                    Seen s = new Seen(ex.getRequestMethod(), ex.getRequestURI().getPath(),
                            ex.getRequestHeaders().getFirst("Authorization"),
                            ex.getRequestHeaders().getFirst("X-User-Token"), body);
                    seen.add(s);
                    return serve(s);
                });
            }
        }

        private FakeServer.Reply serve(Seen s) {
            Object grant = s.body().get("grant_type");
            if (oldIssuer && s.path().equals("/auth/token")) return err(404, "not_found", "old issuer");
            if (s.path().equals("/auth/token") && "platform_api_key".equals(grant)) {
                return json(200, Map.of("status", "ok", "subject_type", "platform", "access_token", "ptok",
                        "expires_in", 300));
            }
            if (s.path().equals("/auth/login") && "platform_api_key".equals(grant)) {
                return err(400, "login_grant_removed", "use /auth/token");
            }
            if (s.path().equals("/platforms/mine")) {
                return json(200, Map.of("items", List.of(Map.of("id", REALM, "audience", AUD))));
            }
            Handler h = handlers.get(s.path());
            if (h != null) return h.handle(s);
            return err(404, "not_found", s.path());
        }

        public Issuer on(String path, Handler h) {
            handlers.put(path, h);
            return this;
        }

        public String url() { return fs.baseUrl; }

        public String issuer() { return fs.baseUrl + "/" + REALM; }

        public List<Seen> all() {
            synchronized (seen) { return new ArrayList<>(seen); }
        }

        public List<Seen> reqs(String path) {
            List<Seen> out = new ArrayList<>();
            for (Seen s : all()) if (s.path().equals(path)) out.add(s);
            return out;
        }

        public List<String> paths() {
            List<String> out = new ArrayList<>();
            for (Seen s : all()) out.add(s.method() + " " + s.path());
            return out;
        }

        /** Seen requests that are user mints (not the platform mint). */
        public List<Seen> userMints() {
            List<Seen> out = new ArrayList<>();
            for (Seen s : reqs("/auth/token")) if (!"platform_api_key".equals(s.body().get("grant_type"))) out.add(s);
            return out;
        }

        public Realm realm(Consumer<Realm.Builder> mut) {
            Realm.Builder b = Realm.builder().sessionStore(new MemorySessionStore()).realmId(REALM).apiKey("rk")
                    .baseUrl(fs.baseUrl).audience(AUD).origin("https://app.example.com");
            if (mut != null) mut.accept(b);
            return b.build();
        }

        @Override public void close() { fs.close(); }
    }
}
