package dev.realmid.sdk.auth;

import dev.realmid.sdk.verifier.ClaimFold;

import java.util.Map;

/** SPEC §10.2: runs the handler with the shared 3-attempt policy and checks its keys (rule 5). */
final class CustomClaims {

    private CustomClaims() {}

    /** Null when no handler is configured or it returned nothing; never an empty map. */
    static Map<String, Object> resolve(CustomClaimsHandler handler, String tenantId, String userId) {
        if (handler == null) return null;
        Throwable last = null;
        Map<String, Object> out = null;
        boolean ok = false;
        for (int attempt = 0; attempt < ProductRoles.ATTEMPTS && !ok; attempt++) {
            if (attempt > 0) {
                try {
                    Thread.sleep(ProductRoles.BACKOFF_MS[attempt - 1]);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    throw new CustomClaimsException(tenantId, userId, attempt, ie);
                }
            }
            try {
                out = handler.resolve(tenantId, userId);
                ok = true;
            } catch (Exception e) {
                last = e;
            }
        }
        if (!ok) throw new CustomClaimsException(tenantId, userId, ProductRoles.ATTEMPTS, last);
        if (out == null || out.isEmpty()) return null;
        for (String key : out.keySet()) {
            switch (ClaimFold.checkKey(key)) {
                case REFUSE_CHARSET -> throw new CustomClaimKeyException(key, "not printable ASCII");
                case REFUSE_RESERVED -> throw new CustomClaimKeyException(key, "reserved claim name");
                default -> { }
            }
        }
        return out;
    }
}
