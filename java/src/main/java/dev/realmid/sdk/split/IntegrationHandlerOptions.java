package dev.realmid.sdk.split;

import java.util.function.Function;

/**
 * Options for {@link IntegrationTokenHandler} (SPEC 14.8). {@code ratePerMinute <= 0} means the default (30).
 * {@code clientKey} names the rate-limit bucket of a request from its remote address; null means the
 * address's host part.
 */
public record IntegrationHandlerOptions(int ratePerMinute, Function<String, String> clientKey) {

    public IntegrationHandlerOptions(int ratePerMinute) {
        this(ratePerMinute, null);
    }
}
