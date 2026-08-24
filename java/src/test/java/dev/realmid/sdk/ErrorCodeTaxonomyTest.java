package dev.realmid.sdk;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * SPEC §3.1 taxonomy.
 *
 * <p>These assert the CONSEQUENCE of registering a code rather than its
 * presence in the enum — a membership assertion is satisfied by a list nothing
 * reads. What registration buys is that {@link ErrorCode#fromWire} resolves the
 * server's specific string, so {@code mapErrorResponse} keeps it instead of
 * falling back to {@link ErrorCode#fromHttpStatus}, and the caller can branch
 * on the specific remedy.
 *
 * <p>Added 2026-08-24 with {@code platform_not_found} and
 * {@code mfa_registration_required}. The taxonomy had been recorded as
 * "consistent across the three SDKs" and was eight codes out of sync;
 * {@code scripts/taxonomy-parity.py} now measures that claim on every CI run.
 */
class ErrorCodeTaxonomyTest {

    @Test void platformNotFoundResolves() {
        // Before registration this returned null and the code collapsed to the
        // generic 404 mapping, so a caller could not tell "no such platform"
        // from any other 404 on the request.
        assertEquals(ErrorCode.PLATFORM_NOT_FOUND, ErrorCode.fromWire("platform_not_found"));
    }

    @Test void mfaRegistrationRequiredResolves() {
        // The ENROLLMENT variant of the MFA gate — a different screen from a
        // code prompt. Go has carried it since ADR-061; Java had not.
        assertEquals(ErrorCode.MFA_REGISTRATION_REQUIRED,
                ErrorCode.fromWire("mfa_registration_required"));
    }

    @Test void everyEnumConstantRoundTrips() {
        // A constant whose wire string does not resolve back to itself is
        // unreachable from the network — the only place these are ever built.
        for (ErrorCode c : ErrorCode.values()) {
            assertNotNull(c.wire(), c.name() + " has no wire string");
            assertEquals(c, ErrorCode.fromWire(c.wire()),
                    c.name() + " does not round-trip through fromWire");
        }
    }

    @Test void anUnregisteredCodeStillResolvesToNull() {
        // The control. Without it every assertion above is satisfied by a
        // fromWire that returns something for any input, which would make the
        // registration they exist to check irrelevant.
        assertNull(ErrorCode.fromWire("definitely_not_a_registered_code"));
    }
}
