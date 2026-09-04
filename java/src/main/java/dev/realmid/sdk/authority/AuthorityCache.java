package dev.realmid.sdk.authority;

import java.time.Instant;

/**
 * Records, per subject, the instant from which tokens are no longer trusted to
 * describe that subject's authority (ADR-107). A token is rejected iff its
 * {@code iat} predates the stored marker.
 *
 * <p><b>Why a second cache rather than a wider one.</b> The ADR-041 jti
 * denylist can only express "this TOKEN is dead", and it works for logout for
 * exactly one reason: the user presents their own token, so the SDK holds the
 * jti at the moment it needs to deny it. An admin demoting a colleague holds
 * neither that colleague's access token nor its jti, and there is no
 * user&nbsp;&rarr;&nbsp;live-jti lookup anywhere in the SDK. Demotion is
 * therefore structurally inexpressible on a jti key, whatever the interface is
 * called (ADR-107 C2).
 *
 * <p><b>The value is a TIMESTAMP and never a flag</b> (D3). A boolean could not
 * self-heal: it would reject the REFRESHED token too, locking the user out for
 * the entry's whole TTL and turning a routine demotion into an outage.
 *
 * <p>Reads sit on the hot path of every authenticated request, so keep
 * {@link #staleSince} cheap. Exceptions propagate to the verifier, which fails
 * closed (the request is rejected).
 */
public interface AuthorityCache {

    /**
     * Records that tokens for {@code sub} minted before {@code notBefore} no
     * longer describe its authority.
     *
     * @param sub       the {@code sub} claim — on this platform the
     *                  PER-MEMBERSHIP users-row id, not a person (D4)
     * @param notBefore the marker, already stamped with D8's skew allowance by
     *                  {@code Realm.notifyAuthorityChanged}
     * @param expiresAt the entry's TTL — the maximum access-token lifetime plus
     *                  leeway, after which no token minted before the change can
     *                  still verify and the entry is dead weight (D6)
     */
    void markStale(String sub, Instant notBefore, Instant expiresAt);

    /**
     * The marker for {@code sub}, or {@code null} when the subject has no live
     * entry.
     *
     * <p>{@code null} and {@link Instant#EPOCH} are NOT interchangeable: the
     * epoch is a real instant, and a cache returning it for "no entry" would
     * mark every subject stale forever-ago, which reads as working and silences
     * the whole feature.
     */
    Instant staleSince(String sub);
}
