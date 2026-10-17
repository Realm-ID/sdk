/**
 * Phone-code channels — `realm.messaging.*` (ADR-115, issuer spec 0.60.0; SPEC §6.16).
 *
 * A realm saves its OWN Twilio (SMS) and/or Meta WhatsApp credentials and
 * RealmID sends that realm's phone sign-in codes only through them:
 *   - PUT    /platforms/{id}/messaging/{channel}
 *   - GET    /platforms/{id}/messaging/{channel}
 *   - DELETE /platforms/{id}/messaging/{channel}
 *
 * Gated on the realm permission `platform:config`, like `realm.config`. The
 * issuer answers with a BARE body (not the `{data: …}` envelope).
 *
 * Secrets are WRITE-ONLY: they exist on {@link TwilioChannel} and
 * {@link WhatsAppChannel} and on no read type, so a read can never echo one
 * back by accident.
 */

import { RealmError } from "./errors.js";
import type { HttpClient } from "./http.js";

/** Channel names, as in the route and in discovery's `phone_channels`. */
export type MessagingChannelName = "sms" | "whatsapp";

export const MESSAGING_CHANNEL_SMS: MessagingChannelName = "sms";
export const MESSAGING_CHANNEL_WHATSAPP: MessagingChannelName = "whatsapp";

/**
 * `operational`: saved, validated, and no configuration-class send failure
 * since (only these appear in discovery). `failing`: such a failure hid the
 * channel until a re-save or the issuer's 10-minute re-check passes.
 */
export type MessagingStatus = "operational" | "failing";

/**
 * The SMS save body. Give EXACTLY ONE auth form (`auth_token`, or `api_key_sid`
 * with `api_key_secret`; an API key is preferred, being revocable on its own)
 * and EXACTLY ONE sender form (`from_number` in strict E.164, or
 * `messaging_service_sid`). The issuer enforces both rules: a violation is
 * `400 invalid_channel_config` naming the field.
 */
export interface TwilioChannel {
  account_sid: string;
  /** WRITE-ONLY. */
  auth_token?: string;
  api_key_sid?: string;
  /** WRITE-ONLY. */
  api_key_secret?: string;
  from_number?: string;
  messaging_service_sid?: string;
}

/**
 * The WhatsApp save body: the partner's own Meta WhatsApp Business Account.
 * `template_name` / `template_language` name an APPROVED authentication
 * template with a copy-code button.
 */
export interface WhatsAppChannel {
  phone_number_id: string;
  waba_id: string;
  /** A System User token. WRITE-ONLY. */
  access_token: string;
  template_name: string;
  template_language: string;
}

/**
 * A saved channel as read back (PUT and GET both answer with it). It has NO
 * secret field; `secret_hint` is the last 4 characters of the primary secret.
 * The provider fields that do not apply to the channel are absent. Timestamps
 * are RFC3339 strings.
 */
export interface MessagingChannel {
  channel: MessagingChannelName;
  provider: "twilio" | "meta";
  secret_hint: string;
  status: MessagingStatus;
  /** The provider's reason for the last flip to `failing`, secret-free. `null` while operational. */
  status_reason: string | null;
  status_changed_at: string;
  /** `null` if the credentials never passed a validation call. */
  validated_at: string | null;
  updated_at: string;
  account_sid?: string;
  api_key_sid?: string;
  from_number?: string;
  messaging_service_sid?: string;
  phone_number_id?: string;
  waba_id?: string;
  template_name?: string;
  template_language?: string;
}

/** The DELETE acknowledgment. */
export interface MessagingDeleteResult {
  status: string;
}

function malformed(what: string): RealmError {
  return new RealmError({ code: "server_error", message: `realmid: malformed messaging response: ${what}` });
}

function field(o: object, k: string): unknown {
  return Reflect.get(o, k);
}

function reqString(o: object, k: string): string {
  const v = field(o, k);
  if (typeof v !== "string") throw malformed(`${k} is not a string`);
  return v;
}

function optString(o: object, k: string): string | undefined {
  const v = field(o, k);
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw malformed(`${k} is not a string`);
  return v;
}

function nullableString(o: object, k: string): string | null {
  const v = field(o, k);
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw malformed(`${k} is not a string`);
  return v;
}

function decodeChannel(raw: unknown): MessagingChannel {
  if (typeof raw !== "object" || raw === null) throw malformed("body is not an object");
  const channel = reqString(raw, "channel");
  if (channel !== "sms" && channel !== "whatsapp") throw malformed(`unknown channel ${JSON.stringify(channel)}`);
  const provider = reqString(raw, "provider");
  if (provider !== "twilio" && provider !== "meta") throw malformed(`unknown provider ${JSON.stringify(provider)}`);
  const status = reqString(raw, "status");
  if (status !== "operational" && status !== "failing") throw malformed(`unknown status ${JSON.stringify(status)}`);
  const out: MessagingChannel = {
    channel,
    provider,
    secret_hint: reqString(raw, "secret_hint"),
    status,
    status_reason: nullableString(raw, "status_reason"),
    status_changed_at: reqString(raw, "status_changed_at"),
    validated_at: nullableString(raw, "validated_at"),
    updated_at: reqString(raw, "updated_at"),
  };
  const opt: Array<keyof Pick<MessagingChannel,
    "account_sid" | "api_key_sid" | "from_number" | "messaging_service_sid" |
    "phone_number_id" | "waba_id" | "template_name" | "template_language">> = [
    "account_sid", "api_key_sid", "from_number", "messaging_service_sid",
    "phone_number_id", "waba_id", "template_name", "template_language",
  ];
  for (const k of opt) {
    const v = optString(raw, k);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export class MessagingClient {
  constructor(
    private readonly http: HttpClient,
    private readonly realmId: string,
  ) {}

  /**
   * PUT /platforms/{id}/messaging/sms — save (replace) the realm's Twilio
   * credentials. The issuer asks Twilio whether they work, WITHOUT sending a
   * message, before storing anything: `422 channel_validation_failed` carries
   * Twilio's reason, `400 invalid_channel_config` names a malformed field.
   */
  putSms(body: TwilioChannel): Promise<MessagingChannel> {
    return this.put("sms", body);
  }

  /** PUT /platforms/{id}/messaging/whatsapp — save (replace) the realm's Meta credentials, validated the same way. */
  putWhatsApp(body: WhatsAppChannel): Promise<MessagingChannel> {
    return this.put("whatsapp", body);
  }

  /**
   * GET — a channel's non-secret config and status. A channel nobody saved is
   * `404 channel_not_configured` (`isChannelNotConfigured`).
   */
  async get(channel: MessagingChannelName): Promise<MessagingChannel> {
    const raw = await this.http.request<unknown>({ method: "GET", path: this.path(channel) });
    return decodeChannel(raw);
  }

  /** DELETE — remove a channel's credentials. Idempotent: deleting a channel that was never saved succeeds the same way. */
  async delete(channel: MessagingChannelName): Promise<MessagingDeleteResult> {
    const raw = await this.http.request<unknown>({ method: "DELETE", path: this.path(channel) });
    if (typeof raw !== "object" || raw === null) throw malformed("body is not an object");
    return { status: reqString(raw, "status") };
  }

  private async put(channel: MessagingChannelName, body: TwilioChannel | WhatsAppChannel): Promise<MessagingChannel> {
    const raw = await this.http.request<unknown>({ method: "PUT", path: this.path(channel), body });
    return decodeChannel(raw);
  }

  /**
   * Validates the channel name client-side so a typo never reaches the network
   * and a path-shaped value can never rewrite the route.
   */
  private path(channel: string): string {
    if (channel !== "sms" && channel !== "whatsapp") {
      throw new RealmError({
        code: "bad_request",
        message: `realmid: unknown messaging channel ${JSON.stringify(channel)} (want "sms" or "whatsapp")`,
      });
    }
    return `/platforms/${encodeURIComponent(this.realmId)}/messaging/${channel}`;
  }
}
