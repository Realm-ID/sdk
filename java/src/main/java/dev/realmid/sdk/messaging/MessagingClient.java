package dev.realmid.sdk.messaging;

import com.fasterxml.jackson.databind.JsonNode;
import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.RealmException;
import dev.realmid.sdk.http.HttpTransport;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/**
 * Phone-code channels (ADR-115, issuer spec 0.60.0; SPEC 6.16).
 *
 * <p>A realm saves its OWN Twilio (SMS) and/or Meta WhatsApp credentials and RealmID sends that
 * realm's phone sign-in codes only through them:
 * <ul>
 *   <li>{@code PUT /platforms/{id}/messaging/{channel}}</li>
 *   <li>{@code GET /platforms/{id}/messaging/{channel}}</li>
 *   <li>{@code DELETE /platforms/{id}/messaging/{channel}}</li>
 * </ul>
 * Gated on the realm permission {@code platform:config}, like {@code ConfigClient}. The issuer
 * answers with a BARE body (no {@code {"data":...}} envelope). Secrets are WRITE-ONLY: they exist on
 * {@link TwilioChannel} and {@link WhatsAppChannel} and on no read type.
 */
public final class MessagingClient {

    private final HttpTransport http;
    private final String realmId;

    public MessagingClient(HttpTransport http, String realmId) {
        this.http = http;
        this.realmId = realmId;
    }

    /**
     * Saves (replaces) the realm's Twilio credentials. The issuer asks Twilio whether they work,
     * WITHOUT sending a message, before storing anything: {@code 422 channel_validation_failed}
     * carries Twilio's reason, {@code 400 invalid_channel_config} names a malformed field.
     */
    public MessagingChannel putSms(TwilioChannel body) {
        return put(MessagingChannel.SMS, body);
    }

    /** Saves (replaces) the realm's Meta WhatsApp credentials, validated the same way as {@link #putSms}. */
    public MessagingChannel putWhatsApp(WhatsAppChannel body) {
        return put(MessagingChannel.WHATSAPP, body);
    }

    /**
     * Reads a channel's non-secret config and status. A channel nobody saved is
     * {@code 404 channel_not_configured} ({@link RealmException#isChannelNotConfigured}).
     */
    public MessagingChannel get(String channel) {
        return decode(http.request(HttpTransport.Request.of("GET", path(channel))), MessagingChannel.class);
    }

    /** Removes a channel's credentials. Idempotent: deleting a channel that was never saved succeeds the same way. */
    public MessagingDeleteResult delete(String channel) {
        return decode(http.request(HttpTransport.Request.of("DELETE", path(channel))), MessagingDeleteResult.class);
    }

    private MessagingChannel put(String channel, Object body) {
        return decode(http.request(HttpTransport.Request.of("PUT", path(channel)).body(body)), MessagingChannel.class);
    }

    private <T> T decode(JsonNode raw, Class<T> type) {
        if (raw == null || raw.isNull()) {
            throw new RealmException(ErrorCode.SERVER_ERROR, "empty response from the messaging endpoint", 0, null);
        }
        return http.mapper().convertValue(raw, type);
    }

    /**
     * Validates the channel name client-side so a typo never reaches the network and a
     * path-shaped value can never rewrite the route.
     */
    private String path(String channel) {
        if (!MessagingChannel.SMS.equals(channel) && !MessagingChannel.WHATSAPP.equals(channel)) {
            throw new RealmException(ErrorCode.BAD_REQUEST, "realmid: unknown messaging channel \"" + channel
                    + "\" (want \"" + MessagingChannel.SMS + "\" or \"" + MessagingChannel.WHATSAPP + "\")", 0, null);
        }
        return "/platforms/" + URLEncoder.encode(realmId, StandardCharsets.UTF_8) + "/messaging/" + channel;
    }
}
