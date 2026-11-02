package dev.realmid.sdk;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * RED tests (W2-sdk): the twelve device-authorization codes of SPEC §3.1 are registered in java (Q8), and
 * {@code device_approval_not_allowed} has the R86 typed exception. Reflection is used for the typed class
 * so this file compiles before it exists (a compile error would fail every java test, not just these).
 */
class DeviceCodesTest {

    private static final String[] CODES = {
        "authorization_pending", "slow_down", "access_denied", "expired_token",
        "device_code_attempts_exceeded", "subject_suspended", "device_authorization_not_pending",
        "device_authorization_collected", "revoke_existing_sessions_required", "invalid_client_id",
        "tenant_not_member", "device_approval_not_allowed",
    };

    @Test void everyDeviceCodeResolvesAndRoundTrips() {
        for (String c : CODES) {
            ErrorCode e = ErrorCode.fromWire(c);
            assertNotNull(e, c + " is not registered: it collapses into the HTTP-status mapping");
            assertEquals(c, e.wire());
        }
    }

    @Test void deviceApprovalNotAllowedHasATypedException() throws Exception {
        Class<?> k = Class.forName("dev.realmid.sdk.DeviceApprovalNotAllowedException");
        assertTrue(RealmException.class.isAssignableFrom(k), "must extend RealmException (R86)");
        var m = RealmException.class.getMethod("isDeviceApprovalNotAllowed", Throwable.class);
        assertEquals(false, m.invoke(null, new RuntimeException("x")));
        assertEquals(false, m.invoke(null, (Throwable) null));
    }
}
