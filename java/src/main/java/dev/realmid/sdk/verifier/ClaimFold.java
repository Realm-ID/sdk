package dev.realmid.sdk.verifier;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;

import java.io.IOException;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * SPEC §4.2 {@code SPEC4_2_claim_fold} (audit e-02, owner ruling 8): reserved claim names are
 * compared by ASCII fold, and custom-claim keys are printable ASCII.
 *
 * <p>{@code fold(k)} maps ASCII {@code A-Z} to {@code a-z} and nothing else. The charset rule runs
 * first, so every surviving key is ASCII and ASCII fold equals Unicode simple fold: no decoder can
 * bind a key this check did not see. Normative cases: {@code sdk/testdata/claim-fold-vectors/}.
 */
public final class ClaimFold {

    /** The issuer's {@code reservedClaims} from v0.151.0 plus {@code acr} (ruling 8). */
    public static final List<String> RESERVED = List.of(
            "iss", "sub", "aud", "iat", "nbf", "exp", "jti", "azp", "tenant_id", "role", "mfa_at",
            "amr", "token_class", "scope", "product_roles", "sid", "events", "acr");

    private static final Set<String> RESERVED_FOLDED = Set.copyOf(RESERVED.stream().map(ClaimFold::fold).toList());

    private static final JsonFactory FACTORY = new JsonFactory();

    public enum KeyVerdict { ACCEPT, REFUSE_RESERVED, REFUSE_CHARSET }

    private ClaimFold() {}

    public static String fold(String k) {
        StringBuilder b = new StringBuilder(k.length());
        for (int i = 0; i < k.length(); i++) {
            char c = k.charAt(i);
            b.append(c >= 'A' && c <= 'Z' ? (char) (c + 32) : c);
        }
        return b.toString();
    }

    private static boolean printableAscii(String k) {
        if (k.isEmpty()) return false;
        for (int i = 0; i < k.length(); i++) {
            char c = k.charAt(i);
            if (c < 0x20 || c > 0x7E) return false;
        }
        return true;
    }

    /** Charset is checked FIRST, then the reserved fold. */
    public static KeyVerdict checkKey(String key) {
        if (key == null || !printableAscii(key)) return KeyVerdict.REFUSE_CHARSET;
        return RESERVED_FOLDED.contains(fold(key)) ? KeyVerdict.REFUSE_RESERVED : KeyVerdict.ACCEPT;
    }

    /**
     * Rule 2: true when the TOP-LEVEL keys of the raw payload JSON (taken after unescaping, read
     * with a duplicate-preserving streaming parser, never a decoded map) are all printable ASCII,
     * no two fold equal (exact duplicates included), and none that is not byte-equal to a reserved
     * name folds to one. Unparseable JSON is refused.
     */
    public static boolean payloadAcceptable(byte[] payloadJson) {
        try (JsonParser p = FACTORY.createParser(payloadJson)) {
            if (p.nextToken() != JsonToken.START_OBJECT) return false;
            Set<String> seen = new HashSet<>();
            while (p.nextToken() == JsonToken.FIELD_NAME) {
                String key = p.currentName();
                if (!printableAscii(key)) return false;
                String f = fold(key);
                if (!seen.add(f)) return false;
                if (RESERVED_FOLDED.contains(f) && !RESERVED.contains(key)) return false;
                p.nextToken();
                p.skipChildren();
            }
            return true;
        } catch (IOException | RuntimeException e) {
            return false;
        }
    }
}
