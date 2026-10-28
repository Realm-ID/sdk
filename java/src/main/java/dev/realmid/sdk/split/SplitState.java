package dev.realmid.sdk.split;

import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.RealmException;

import java.lang.System.Logger;
import java.lang.System.Logger.Level;
import java.math.BigInteger;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.spec.RSAPublicKeySpec;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/**
 * A Realm's view of its share bundle (SPEC 14.4, 14.5; mirrors sdk/go trust.go). A verifier of a split realm
 * trusts ONLY the bundle's public keys (plus a previous key until its trust_until) and never fetches RI's JWKS.
 * INTERNAL: public only so {@code Realm}, {@code AuthClient} and {@code SigningKeysClient} can share it.
 */
public final class SplitState {
    /** One rate-limited re-read on an unknown kid, so forged kids cannot hammer the custody store. */
    static final Duration RELOAD_MIN = Duration.ofSeconds(5);
    /** The poll that picks up a rotation made by another pod. */
    static final Duration REFRESH_EVERY = Duration.ofSeconds(30);
    /** R91: a retired key stays trusted for one access-token lifetime, floor 15 minutes, plus slack. */
    public static final Duration TTL_FLOOR = Duration.ofMinutes(15);
    public static final Duration TTL_SLACK = Duration.ofMinutes(5);

    private record KeyInfo(PublicKey pub, long trustUntil) {}

    private final ShareSource src; // null: a full-signing realm, only the TTL tracker is used
    private final Clock clock;
    private final Logger logger;
    private final String expectedIssuer;
    private final AtomicLong maxExpiresIn = new AtomicLong();

    private ShareBundle bundle;
    private Map<String, KeyInfo> keys = Map.of();
    private Instant loaded;

    public SplitState(ShareSource src, Clock clock, Logger logger, String expectedIssuer) {
        this.src = src;
        this.clock = clock;
        this.logger = logger;
        this.expectedIssuer = expectedIssuer;
    }

    public boolean isSplit() { return src != null; }

    /** The iss a co-signed token must carry: the realm's own issuer URL. */
    public String expectedIssuer() { return expectedIssuer; }

    /** Records a co-signed mint's expires_in (seconds) for the previous-key window. */
    public void noteExpiresIn(long seconds) {
        for (long old = maxExpiresIn.get(); seconds > old; old = maxExpiresIn.get()) {
            if (maxExpiresIn.compareAndSet(old, seconds)) break;
        }
    }

    /** How long a retired key stays trusted after a rotation. */
    public Duration previousTrustWindow() {
        Duration ttl = Duration.ofSeconds(maxExpiresIn.get());
        if (ttl.compareTo(TTL_FLOOR) < 0) ttl = TTL_FLOOR;
        return ttl.plus(TTL_SLACK);
    }

    private static PublicKey pub(String n, String e, String what) {
        try {
            BigInteger nn = new BigInteger(1, Base64.getUrlDecoder().decode(n));
            BigInteger ee = new BigInteger(1, Base64.getUrlDecoder().decode(e));
            if (nn.bitLength() < 2048 || !nn.testBit(0) || ee.bitLength() > 62 || ee.longValue() < 3) {
                throw new IllegalArgumentException("not a usable RSA key");
            }
            return KeyFactory.getInstance("RSA").generatePublic(new RSAPublicKeySpec(nn, ee));
        } catch (Exception ex) {
            throw new RealmException(ErrorCode.SHARE_LOAD_FAILED, "realmid: " + what + " is not a usable public key");
        }
    }

    private void reloadLocked() {
        ShareSource.Loaded l;
        try {
            l = src.load();
        } catch (RealmException e) {
            throw e;
        } catch (RuntimeException e) {
            throw new RealmException(ErrorCode.SHARE_LOAD_FAILED, "realmid: split share source: " + e.getMessage(), e);
        }
        if (l == null || l.bundle() == null) {
            throw new RealmException(ErrorCode.SHARE_LOAD_FAILED, "realmid: split share source returned no bundle");
        }
        ShareBundle b = l.bundle();
        Map<String, KeyInfo> m = new HashMap<>();
        if (b.shares() != null) {
            for (Map.Entry<String, ShareEntry> e : b.shares().entrySet()) {
                m.put(e.getKey(), new KeyInfo(pub(e.getValue().n(), e.getValue().e(), "share " + e.getKey()), 0));
            }
        }
        if (b.previous() != null) {
            for (PreviousKey p : b.previous()) {
                if (m.containsKey(p.kid())) continue;
                m.put(p.kid(), new KeyInfo(pub(p.n(), p.e(), "previous key " + p.kid()), p.trustUntil()));
            }
        }
        bundle = b;
        keys = m;
        loaded = clock.instant();
    }

    private synchronized ShareBundle current() {
        if (bundle == null || Duration.between(loaded, clock.instant()).compareTo(REFRESH_EVERY) >= 0) {
            try {
                reloadLocked();
            } catch (RealmException e) {
                if (bundle == null) throw e;
                logger.log(Level.WARNING, "realmid split share reload failed; keeping the loaded bundle");
            }
        }
        return bundle;
    }

    private void rereadIfDue() {
        if (Duration.between(loaded, clock.instant()).compareTo(RELOAD_MIN) >= 0) {
            try {
                reloadLocked();
            } catch (RealmException ignored) {
                // the previous bundle stays; the caller reports the kid as unpinned
            }
        }
    }

    /** The partner share for kid, with one rate-limited re-read when it is unknown. */
    public synchronized ShareEntry entry(String kid) {
        ShareBundle b = current();
        ShareEntry e = b.shares() == null ? null : b.shares().get(kid);
        if (e != null) return e;
        rereadIfDue();
        e = bundle.shares() == null ? null : bundle.shares().get(kid);
        if (e != null) return e;
        throw new RealmException(ErrorCode.UNPINNED_KID, "realmid: signing kid \"" + kid + "\" is not in the share bundle");
    }

    /** The verifier hook: resolves kid from the bundle only. */
    public synchronized PublicKey publicKey(String realmId, String kid) {
        current();
        KeyInfo k = keys.get(kid);
        if (k == null) {
            rereadIfDue();
            k = keys.get(kid);
        }
        if (k != null && k.trustUntil() != 0 && clock.instant().getEpochSecond() >= k.trustUntil()) k = null;
        if (k == null) {
            logger.log(Level.ERROR, "realmid verify refused an unpinned kid {0}", kid);
            throw new RealmException(ErrorCode.UNPINNED_KID,
                    "realmid: signing kid \"" + kid + "\" is not pinned by the share bundle", 401, null);
        }
        return k.pub();
    }
}
