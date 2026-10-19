package realmid

import (
	ctxpkg "context"
	"net/url"
)

// ContactProofSendRequest is the input to MeClient.SendContactProof.
type ContactProofSendRequest struct {
	MeAuth
	// ContactID is the caller's own phone contact.
	ContactID string
	// DeliveryMode is "sms" or "whatsapp". There is no fallback between channels.
	DeliveryMode string
}

// ContactProofSent is the answer to MeClient.SendContactProof. The send is
// inline, so a 200 proves the provider accepted it; Delivered names the channel.
type ContactProofSent struct {
	Delivered string `json:"delivered"`
}

// ContactProofConfirmRequest is the input to MeClient.ConfirmContactProof.
type ContactProofConfirmRequest struct {
	MeAuth
	ContactID string
	Code      string
}

// ContactProof is the proven contact returned by MeClient.ConfirmContactProof.
type ContactProof struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"`
	Value string `json:"value"`
	// Verified is true once the code was redeemed.
	Verified bool `json:"verified"`
	// VerifiedAt is an RFC 3339 timestamp; empty when the issuer sent null.
	VerifiedAt string `json:"verified_at"`
}

// SendContactProof sends a code to one of the caller's OWN phones to prove it,
// via POST /me/contacts/{contact_id}/proof (ADR-116 third amendment).
//
// Only the holder may prove: the caller is the user token's subject (direct
// mode UserBearer, or BFF mode UserToken). An admin acting for the person gets
// `404 contact_not_found`; any API-key session or a platform bearer with no user
// token is `403 permission_cap_exceeded`. Errors: `409 contact_already_verified`
// (nothing sent), `400 no_delivery_address` / `unsupported_delivery_mode`,
// `429 phone_otp_rate_limited` (see RealmError.RetryAfter), `503
// delivery_unavailable`.
func (c *MeClient) SendContactProof(ctx ctxpkg.Context, req ContactProofSendRequest) (*ContactProofSent, error) {
	bearer, headers, err := c.bearer(ctx, req.MeAuth)
	if err != nil {
		return nil, err
	}
	var out ContactProofSent
	if err := c.realm.http.do(ctx, requestOptions{
		Method:  "POST",
		Path:    "/me/contacts/" + url.PathEscape(req.ContactID) + "/proof",
		Bearer:  bearer,
		Headers: headers,
		Body:    map[string]any{"delivery_mode": req.DeliveryMode},
	}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ConfirmContactProof redeems the code via
// POST /me/contacts/{contact_id}/proof/confirm and returns the proven contact.
//
// Errors: `401 invalid_otp` (also a code minted for another contact), `410
// otp_expired`, `429 otp_locked`, `404 contact_not_found`, `409
// contact_changed` (the contact was released or replaced after the send; the
// code is spent).
func (c *MeClient) ConfirmContactProof(ctx ctxpkg.Context, req ContactProofConfirmRequest) (*ContactProof, error) {
	bearer, headers, err := c.bearer(ctx, req.MeAuth)
	if err != nil {
		return nil, err
	}
	var out ContactProof
	if err := c.realm.http.do(ctx, requestOptions{
		Method:  "POST",
		Path:    "/me/contacts/" + url.PathEscape(req.ContactID) + "/proof/confirm",
		Bearer:  bearer,
		Headers: headers,
		Body:    map[string]any{"code": req.Code},
	}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
