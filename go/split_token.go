package realmid

// The split-realm token path (SPEC §14.2): a people call goes to /auth/token/partial, RealmID
// answers `token_type: "partial"` with signing{kid, header, payload, partial_ri}, and the SDK
// finishes the signature with the partner's share and releases a normal access token.

import (
	ctxpkg "context"
	"encoding/json"
	"errors"
)

// partialWire is the /auth/token/partial answer: the usual mint fields plus `signing`.
type partialWire struct {
	MintResult
	TokenType string `json:"token_type"`
	Signing   *struct {
		KID       string `json:"kid"`
		Header    string `json:"header"`
		Payload   string `json:"payload"`
		PartialRI string `json:"partial_ri"`
	} `json:"signing"`
}

// splitToken sends body to /auth/token/partial with the platform token, co-signs the answer and
// returns it as a MintResult. A corrupt partial, a kid the bundle does not hold or a signature
// that does not verify returns an error and NO access token. body may carry a refresh_token or
// another user-token grant (an integration pass rides in X-User-Token on ctx).
func (r *Realm) splitToken(ctx ctxpkg.Context, platformTok string, body map[string]any) (*MintResult, error) {
	var raw json.RawMessage
	if err := r.http.do(ctx, requestOptions{
		Method: "POST", Path: "/auth/token/partial", Bearer: platformTok, Body: body,
	}, &raw); err != nil {
		return nil, err
	}
	return r.finishPartial(ctx, raw)
}

// finishPartial turns a /auth/token/partial body into a finished MintResult.
func (r *Realm) finishPartial(ctx ctxpkg.Context, raw []byte) (*MintResult, error) {
	var w partialWire
	if err := json.Unmarshal(raw, &w); err != nil {
		return nil, &RealmError{Code: ErrCodeServerError, Message: "decode partial token answer", Cause: err}
	}
	if w.Signing == nil || w.TokenType != "partial" {
		return nil, &RealmError{Code: ErrCodeServerError, Message: "a split realm's token endpoint answered without a partial signature"}
	}
	entry, err := r.split.entry(ctx, w.Signing.KID)
	if err != nil {
		return nil, err
	}
	jwt, err := CoSign(entry, r.expectedIssuer(), PartialSigning{
		KID: w.Signing.KID, Header: w.Signing.Header, Payload: w.Signing.Payload, PartialRI: w.Signing.PartialRI})
	if err != nil {
		var re *RealmError
		if errors.As(err, &re) {
			return nil, err
		}
		return nil, &RealmError{Code: ErrCodeBadSignature, Message: err.Error(), Cause: err}
	}
	out := w.MintResult
	out.AccessToken = jwt
	for old := r.splitTTL.Load(); int64(out.ExpiresIn) > old; old = r.splitTTL.Load() {
		if r.splitTTL.CompareAndSwap(old, int64(out.ExpiresIn)) {
			break
		}
	}
	return &out, nil
}
