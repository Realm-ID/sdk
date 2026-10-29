package dev.realmid.sdk.signingkeys;

import com.fasterxml.jackson.databind.JsonNode;
import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.RealmException;
import dev.realmid.sdk.http.HttpTransport;
import dev.realmid.sdk.split.CoSigner;
import dev.realmid.sdk.split.PreviousKey;
import dev.realmid.sdk.split.RotateSplitOptions;
import dev.realmid.sdk.split.ShareBundle;
import dev.realmid.sdk.split.ShareEntry;
import dev.realmid.sdk.split.ShareSource;
import dev.realmid.sdk.split.SplitState;
import dev.realmid.sdk.split.WritableShareSource;

import java.math.BigInteger;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.SecureRandom;
import java.security.interfaces.RSAPrivateCrtKey;
import java.security.interfaces.RSAPublicKey;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Owner-facing signing-key surface (roles/signing-keys overhaul).
 *
 * <p>A platform owner reads their realm's keyring and self-serve rotates
 * the active signing key:
 * <ul>
 *   <li>{@code GET  /platforms/{id}/signing-keys} — keyring + rotation policy</li>
 *   <li>{@code POST /platforms/{id}/signing-keys/rotate} — mint a new active key</li>
 * </ul>
 *
 * <p>Distinct from the base-staff ops rotate at {@code /admin/platforms/{id}/…}
 * (not part of this partner SDK). Both are realm-admin gated server-side;
 * this client targets the caller's own realm. Rotate shares the server-side
 * rate limiter (a 429 {@code rate_limited} surfaces as a {@code RealmException}).
 */
public final class SigningKeysClient {

    private final HttpTransport http;
    private final String realmId;

    private final SplitState splitState;
    private final Clock clock;

    public SigningKeysClient(HttpTransport http, String realmId) {
        this(http, realmId, null, Clock.systemUTC());
    }

    /** {@code splitState} (nullable) supplies the previous-key trust window; {@code clock} dates trust_until. */
    public SigningKeysClient(HttpTransport http, String realmId, SplitState splitState, Clock clock) {
        this.http = http;
        this.realmId = realmId;
        this.splitState = splitState;
        this.clock = clock == null ? Clock.systemUTC() : clock;
    }

    /** GET /platforms/{id}/signing-keys — keyring (newest-first) + rotation policy. */
    public SigningKeysResponse list() {
        JsonNode raw = http.request(HttpTransport.Request.of(
                "GET", "/platforms/" + enc(realmId) + "/signing-keys"));
        return http.mapper().convertValue(raw, SigningKeysResponse.class);
    }

    /** POST /platforms/{id}/signing-keys/rotate — self-serve rotate. */
    public RotateSigningKeyResult rotate() {
        JsonNode raw = http.request(HttpTransport.Request.of(
                "POST", "/platforms/" + enc(realmId) + "/signing-keys/rotate"));
        return http.mapper().convertValue(raw, RotateSigningKeyResult.class);
    }

    /**
     * SPEC 14.5 / 14.12 partner-side rotation and lost-half recovery on a WRITABLE share source (mirrors sdk/go
     * rotation.go). Order: lease, keygen, store the new share FIRST, upload d_ri, handshake, complete, compact
     * the bundle. Every call carries the platform token and NO actor (R67.3). A failed handshake stops with an
     * error and is never retried (an unattended loop would burn the emergency-rotation cap). A read-only source
     * (environment) cannot rotate: {@code share_source_read_only}, and nothing is sent.
     */
    public void rotateSplit(ShareSource store, RotateSplitOptions opts) {
        if (!(store instanceof WritableShareSource w)) {
            throw new RealmException(ErrorCode.SHARE_SOURCE_READ_ONLY,
                    "this share source is read-only; rotate with the CLI, then reload the bundle");
        }
        if (opts == null || opts.kid() == null || opts.kid().isEmpty()) {
            throw new RealmException(ErrorCode.BAD_REQUEST, "rotateSplit needs a kid");
        }
        HttpTransport plat = http.withUserToken(null); // platform token only: no actor on any rotation call
        ShareBundle cur = w.load().bundle();
        String base = "/platforms/" + enc(realmId) + "/signing-keys/split";
        // The lease answers {lease_id, expires_at}; the upload of THIS rotation must carry the id.
        JsonNode lease = plat.request(HttpTransport.Request.of("POST", base + "/rotation-lease")
                .body(Map.of("reason", opts.recovery() ? "recovery" : "rotation")));
        String leaseId = lease == null ? "" : lease.path("lease_id").asText(lease.path("data").path("lease_id").asText(""));

        KeyPair pair;
        try {
            KeyPairGenerator g = KeyPairGenerator.getInstance("RSA");
            g.initialize(2048);
            pair = g.generateKeyPair();
        } catch (Exception e) {
            throw new RealmException(ErrorCode.BAD_REQUEST, "generate split key: " + e.getMessage(), e);
        }
        RSAPublicKey pub = (RSAPublicKey) pair.getPublic();
        RSAPrivateCrtKey priv = (RSAPrivateCrtKey) pair.getPrivate();
        BigInteger p1 = priv.getPrimeP().subtract(BigInteger.ONE);
        BigInteger q1 = priv.getPrimeQ().subtract(BigInteger.ONE);
        BigInteger lam = p1.multiply(q1).divide(p1.gcd(q1));
        BigInteger d = priv.getPrivateExponent().mod(lam);
        BigInteger dRi = new BigInteger(lam.bitLength() - 1, new SecureRandom());
        BigInteger dP = d.subtract(dRi).mod(lam);
        ShareEntry entry = new ShareEntry(b64(pub.getModulus()), b64(pub.getPublicExponent()), b64(dP));

        String realm = cur.realm() == null || cur.realm().isEmpty() ? realmId : cur.realm();
        Map<String, ShareEntry> shares = new LinkedHashMap<>(cur.shares() == null ? Map.of() : cur.shares());
        shares.put(opts.kid(), entry);
        List<PreviousKey> prev = cur.previous() == null ? new ArrayList<>() : new ArrayList<>(cur.previous());
        w.store(new ShareBundle(realm, shares, prev)); // BEFORE the upload: a crash never strands a half RI holds

        Map<String, Object> up = new LinkedHashMap<>();
        up.put("kid", opts.kid());
        up.put("n", entry.n());
        up.put("e", entry.e());
        up.put("d_ri", b64(dRi));
        if (!leaseId.isEmpty()) up.put("lease_id", leaseId);
        plat.request(HttpTransport.Request.of("POST", base).body(up));

        String kidPath = base + "/" + enc(opts.kid());
        JsonNode ch = plat.request(HttpTransport.Request.of("POST", kidPath + "/handshake"));
        byte[] ri;
        try {
            ri = Base64.getUrlDecoder().decode(ch.path("partial_ri").asText(""));
        } catch (IllegalArgumentException e) {
            throw new RealmException(ErrorCode.SERVER_ERROR, "handshake partial_ri is not base64url", e);
        }
        byte[] sig = CoSigner.completeHandshake(entry, realmId, opts.kid(), ch.path("nonce").asText(""), ri);
        plat.request(HttpTransport.Request.of("POST", kidPath + "/handshake/complete")
                .body(Map.of("sig", Base64.getUrlEncoder().withoutPadding().encodeToString(sig))));

        // Handshake done: the new key is the one current share.
        List<PreviousKey> keep = new ArrayList<>();
        if (!opts.recovery()) {
            Duration window = splitState != null ? splitState.previousTrustWindow()
                    : SplitState.TTL_FLOOR.plus(SplitState.TTL_SLACK);
            long until = clock.instant().plus(window).getEpochSecond();
            keep.addAll(prev);
            for (Map.Entry<String, ShareEntry> e : cur.shares() == null ? Map.<String, ShareEntry>of().entrySet()
                    : cur.shares().entrySet()) {
                if (!e.getKey().equals(opts.kid())) {
                    keep.add(new PreviousKey(e.getKey(), e.getValue().n(), e.getValue().e(), until));
                }
            }
        }
        Map<String, ShareEntry> only = new LinkedHashMap<>();
        only.put(opts.kid(), entry);
        try {
            w.store(new ShareBundle(realm, only, keep));
        } catch (RuntimeException e) {
            throw new RealmException(ErrorCode.SHARE_LOAD_FAILED,
                    "the new key is active at RealmID but the bundle could not be compacted: " + e.getMessage(), e);
        }
    }

    private static String b64(BigInteger i) {
        byte[] b = i.toByteArray();
        if (b.length > 1 && b[0] == 0) b = Arrays.copyOfRange(b, 1, b.length);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }

    private static String enc(String s) { return URLEncoder.encode(s, StandardCharsets.UTF_8); }
}
