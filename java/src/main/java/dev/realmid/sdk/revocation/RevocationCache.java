package dev.realmid.sdk.revocation;

import java.time.Instant;

/**
 * Partner-pluggable JTI denylist consulted by the verifier (ADR-041 follow-up).
 *
 * <p>RealmID's refresh-token revocation is server-tracked and instant. Access
 * tokens are not: they are stateless RS256 JWTs that verify on signature and
 * {@code exp} alone until they naturally expire — up to
 * {@code access_ttl_seconds}, 900s by default. So between "the user clicked
 * logout" and that expiry, a stolen access token still works.
 *
 * <p>Wiring a cache closes that window. The verifier checks it after signature
 * and claim verification, so a junk jti never reaches the cache, and a cache hit
 * rejects the request as {@code unauthorized}.
 *
 * <p><b>This arrived in Java late.</b> go and ts have carried it since ADR-041;
 * Java had no equivalent at all until 2026-09-04, which meant Java partners had
 * no stop-the-bleed on logout and nothing in the API said so. Found while
 * building ADR-107, whose own rationale had assumed this existed here.
 *
 * <p>Not to be confused with {@code TokensClient} (SPEC §6.7), which caches
 * revocations of a token the CALLER already holds. This one is consulted on
 * every verify, for tokens presented by anyone.
 *
 * <p><b>Distinct from {@code AuthorityCache} (ADR-107) and not a replacement for
 * it.</b> This is keyed by {@code jti} and ends a session; that one is keyed by
 * {@code sub}, stores a timestamp, and deliberately does NOT end the session.
 * Two keys, two lifetimes, two questions.
 *
 * <p>OPT-IN: unset means no-op and the verifier behaves as it always has.
 * Reads are on the hot path of every authenticated request, so keep
 * {@link #isRevoked} cheap.
 */
public interface RevocationCache {

    /**
     * Marks {@code jti} revoked.
     *
     * @param expiresAt the JWT's {@code exp}, used as the entry TTL —
     *                  implementations should evict on expiry so the cache never
     *                  grows unboundedly. A null or zero value means "no known
     *                  expiry": keep the entry rather than dropping it, since
     *                  dropping it would un-revoke the token.
     */
    void revoke(String jti, Instant expiresAt);

    /**
     * True when {@code jti} is revoked and its TTL has not elapsed.
     *
     * <p>Exceptions propagate to the verifier, which fails CLOSED (the request is
     * rejected). A partner running an unreliable backend should swallow transient
     * errors inside their implementation rather than have every request fail.
     */
    boolean isRevoked(String jti);
}
