package realmid

import (
	ctxpkg "context"
	"net/url"
	"time"
)

// Phone-code channels (ADR-115, issuer spec 0.60.0; SPEC §6.16).
//
// A realm saves its OWN Twilio (SMS) and/or Meta WhatsApp credentials and
// RealmID sends that realm's phone sign-in codes only through them:
//   - PUT    /platforms/{id}/messaging/{channel}
//   - GET    /platforms/{id}/messaging/{channel}
//   - DELETE /platforms/{id}/messaging/{channel}
//
// Gated on the realm permission `platform:config`, like Config. The issuer
// answers these routes with a BARE body (not the {"data":...} envelope).
//
// Secrets are WRITE-ONLY: they exist on TwilioChannel and WhatsAppChannel and
// on no read type, so a read can never echo one back by accident.

// Messaging channel names, as in the route and in discovery's phone_channels.
const (
	MessagingChannelSMS      = "sms"
	MessagingChannelWhatsApp = "whatsapp"
)

// MessagingStatus values on MessagingChannel.Status.
const (
	// MessagingStatusOperational: saved, validated, and no configuration-class
	// send failure since. Only operational channels appear in discovery.
	MessagingStatusOperational = "operational"
	// MessagingStatusFailing: a configuration-class send failure hid the channel
	// until a re-save or the issuer's 10-minute re-check passes.
	MessagingStatusFailing = "failing"
)

// TwilioChannel is the SMS save body. Give EXACTLY ONE auth form (AuthToken, or
// APIKeySID with APIKeySecret; an API key is preferred, being revocable on its
// own) and EXACTLY ONE sender form (FromNumber in strict E.164, or
// MessagingServiceSID). The issuer enforces both rules: a violation is
// 400 invalid_channel_config naming the field. Unset fields are not sent.
type TwilioChannel struct {
	AccountSID string `json:"account_sid"`
	// AuthToken is WRITE-ONLY.
	AuthToken string `json:"auth_token,omitempty"`
	APIKeySID string `json:"api_key_sid,omitempty"`
	// APIKeySecret is WRITE-ONLY.
	APIKeySecret        string `json:"api_key_secret,omitempty"`
	FromNumber          string `json:"from_number,omitempty"`
	MessagingServiceSID string `json:"messaging_service_sid,omitempty"`
}

// WhatsAppChannel is the WhatsApp save body: the partner's own Meta WhatsApp
// Business Account. TemplateName/TemplateLanguage name an APPROVED
// authentication template with a copy-code button.
type WhatsAppChannel struct {
	PhoneNumberID string `json:"phone_number_id"`
	WABAID        string `json:"waba_id"`
	// AccessToken is a System User token. WRITE-ONLY.
	AccessToken      string `json:"access_token"`
	TemplateName     string `json:"template_name"`
	TemplateLanguage string `json:"template_language"`
}

// MessagingChannel is a saved channel as read back (PUT and GET both answer
// with it). It has NO secret field; SecretHint is the last 4 characters of the
// primary secret. The provider fields that do not apply to the channel are "".
type MessagingChannel struct {
	Channel    string `json:"channel"`  // "sms" | "whatsapp"
	Provider   string `json:"provider"` // "twilio" | "meta"
	SecretHint string `json:"secret_hint"`
	Status     string `json:"status"` // MessagingStatus*
	// StatusReason is the provider's reason for the last flip to failing,
	// secret-free. nil while operational.
	StatusReason    *string    `json:"status_reason"`
	StatusChangedAt time.Time  `json:"status_changed_at"`
	ValidatedAt     *time.Time `json:"validated_at"`
	UpdatedAt       time.Time  `json:"updated_at"`

	AccountSID          string `json:"account_sid,omitempty"`
	APIKeySID           string `json:"api_key_sid,omitempty"`
	FromNumber          string `json:"from_number,omitempty"`
	MessagingServiceSID string `json:"messaging_service_sid,omitempty"`
	PhoneNumberID       string `json:"phone_number_id,omitempty"`
	WABAID              string `json:"waba_id,omitempty"`
	TemplateName        string `json:"template_name,omitempty"`
	TemplateLanguage    string `json:"template_language,omitempty"`
}

// MessagingDeleteResult is the DELETE acknowledgment (Status "deleted").
type MessagingDeleteResult struct {
	Status string `json:"status"`
}

// MessagingClient is realm.Messaging.
type MessagingClient struct {
	realm *Realm
}

// PutSMS saves (replaces) the realm's Twilio credentials. The issuer asks Twilio
// whether they work, WITHOUT sending a message, before storing anything:
// 422 channel_validation_failed carries Twilio's reason, 400
// invalid_channel_config names a malformed field.
func (c *MessagingClient) PutSMS(ctx ctxpkg.Context, body TwilioChannel) (*MessagingChannel, error) {
	return c.put(ctx, MessagingChannelSMS, body)
}

// PutWhatsApp saves (replaces) the realm's Meta WhatsApp credentials, validated
// the same way as PutSMS.
func (c *MessagingClient) PutWhatsApp(ctx ctxpkg.Context, body WhatsAppChannel) (*MessagingChannel, error) {
	return c.put(ctx, MessagingChannelWhatsApp, body)
}

// Get reads a channel's non-secret config and status. A channel nobody saved is
// 404 channel_not_configured (IsChannelNotConfigured).
func (c *MessagingClient) Get(ctx ctxpkg.Context, channel string) (*MessagingChannel, error) {
	path, err := c.path(channel)
	if err != nil {
		return nil, err
	}
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out MessagingChannel
	if err := c.realm.http.do(ctx, requestOptions{Method: "GET", Path: path, Bearer: tok}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Delete removes a channel's credentials. Idempotent: deleting a channel that
// was never saved succeeds the same way.
func (c *MessagingClient) Delete(ctx ctxpkg.Context, channel string) (*MessagingDeleteResult, error) {
	path, err := c.path(channel)
	if err != nil {
		return nil, err
	}
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out MessagingDeleteResult
	if err := c.realm.http.do(ctx, requestOptions{Method: "DELETE", Path: path, Bearer: tok}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *MessagingClient) put(ctx ctxpkg.Context, channel string, body any) (*MessagingChannel, error) {
	path, err := c.path(channel)
	if err != nil {
		return nil, err
	}
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out MessagingChannel
	if err := c.realm.http.do(ctx, requestOptions{Method: "PUT", Path: path, Bearer: tok, Body: body}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// path validates the channel name client-side so a typo never reaches the
// network and a path-shaped value can never rewrite the route.
func (c *MessagingClient) path(channel string) (string, error) {
	if channel != MessagingChannelSMS && channel != MessagingChannelWhatsApp {
		return "", newErr(ErrCodeBadRequest, "realmid: unknown messaging channel %q (want %q or %q)",
			channel, MessagingChannelSMS, MessagingChannelWhatsApp)
	}
	return "/platforms/" + url.PathEscape(c.realm.realmID) + "/messaging/" + channel, nil
}
