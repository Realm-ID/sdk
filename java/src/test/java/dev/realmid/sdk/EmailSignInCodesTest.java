package dev.realmid.sdk;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

/** RED tests: the five codes of issuer ADR-123 and ADR-124 are registered in java (SPEC 3.1). */
class EmailSignInCodesTest {

    private static final String[] CODES = {
        "acknowledgement_required", "email_otp_requires_identifying_email", "email_otp_rate_limited",
        "last_browser_sign_in", "last_machine_credential",
    };

    @Test void everyCodeResolvesAndRoundTrips() {
        for (String c : CODES) {
            ErrorCode e = ErrorCode.fromWire(c);
            assertNotNull(e, c + " is not registered: it collapses into the HTTP-status mapping");
            assertEquals(c, e.wire());
        }
    }
}
