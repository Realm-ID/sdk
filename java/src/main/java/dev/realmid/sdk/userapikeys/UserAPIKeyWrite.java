package dev.realmid.sdk.userapikeys;

import java.util.List;

/**
 * The write payload for an end-user API key (SPEC §6.6), shared by
 * {@link UserAPIKeysClient#create} and {@link UserAPIKeysClient#update}
 * (ADR-100 D12).
 *
 * <p><b>⚠️ UPDATE RESETS WHAT IT OMITS.</b> {@code update} is a PUT, not a
 * PATCH: it replaces the whole key, so a caller changing only the cap must READ
 * THE KEY FIRST and pass {@code label} back unchanged. Pass just the cap and the
 * label is blanked. That is the price of one write schema instead of two, and it
 * is deliberate — PATCH would make {@code permissionsCap} and {@code uncapped}
 * an order-dependent pair that can arrive half-specified.
 *
 * <p><b>⚠️ ADR-105 REMOVED {@code orgScope} and {@code orgIds}.</b> A key is
 * bound to the minting principal's own org and the mint takes no org input at
 * all. The components are GONE rather than accepted-and-ignored: a record
 * component left behind would look like a live knob. This is a source-breaking
 * change to the canonical constructor — use the {@code capped} / {@code uncapped}
 * factories, which is what every caller should already be doing.
 *
 * <p><b>This record replaces {@code UserAPIKeyCreate}, and its
 * {@code of(label)} factory is gone on purpose.</b> That factory passed four
 * nulls and produced {@code {"label": "…"}} — the exact wire shape ADR-100
 * exists to make illegal, because before ADR-100 it minted a key carrying the
 * holder's FULL authority. A caller who wants an unrestricted key now says so
 * with {@link #uncapped(String)}; a caller who wants a narrow one names the
 * permissions with {@link #capped(String, List)}. There is no third factory,
 * because there is no third state.
 *
 * @param label          required human label — the only handle on a key that
 *                       never shows its plaintext again
 * @param uncapped       <b>required — a key's authority is stated, never
 *                       inferred.</b> {@code TRUE} means all current AND FUTURE
 *                       permissions of the holder and needs the realm's
 *                       {@code user_api_keys.allow_uncapped}
 *                       ({@code 403 uncapped_not_allowed} otherwise);
 *                       {@code FALSE} requires a non-empty {@code permissionsCap}.
 *                       A {@code null} here travels as JSON null and the server
 *                       answers {@code 400} — deliberately, so "I did not say"
 *                       fails loudly instead of defaulting
 * @param permissionsCap the cap. For the {@code realmid} audience these are
 *                       validated against RealmID's ADR-074 catalog at mint
 *                       ({@code 400 unknown_permission}); for a partner audience
 *                       they are opaque to RealmID and shape-validated only.
 *                       Must be non-empty when {@code uncapped} is FALSE and
 *                       empty when it is TRUE — the two together are
 *                       self-contradicting and are refused ({@code 400})
 * @param ttlSeconds     null = the realm default; above the realm ceiling returns
 *                       {@code 400 ttl_exceeds_max}; {@code 0} requests a
 *                       non-expiring key, which needs
 *                       {@code user_api_keys.allow_non_expiring}. Mutable on
 *                       {@code update} (ADR-100 D13)
 */
public record UserAPIKeyWrite(
        String label,
        Boolean uncapped,
        List<String> permissionsCap,
        Integer ttlSeconds
) {
    /**
     * A key narrowed to exactly {@code permissions}, with realm defaults for
     * everything else.
     *
     * <p>To freeze TODAY's permission set, pass today's permissions here.
     * {@link #uncapped(String)} is not a shorthand for that — it is
     * forward-inclusive.
     */
    public static UserAPIKeyWrite capped(String label, List<String> permissions) {
        return new UserAPIKeyWrite(label, Boolean.FALSE, permissions, null);
    }

    /**
     * A key carrying ALL CURRENT AND FUTURE permissions of the holder.
     *
     * <p>Named rather than defaulted, and gated at the server on the realm's
     * {@code user_api_keys.allow_uncapped}. On a {@code realmid}-audience key
     * this is RealmID admin authority.
     */
    public static UserAPIKeyWrite uncapped(String label) {
        return new UserAPIKeyWrite(label, Boolean.TRUE, null, null);
    }
}
