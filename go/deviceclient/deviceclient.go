// Package deviceclient is the device side of RFC 8628 against a partner BFF (SPEC §15.7).
// SIGNATURE-ONLY STUBS for the red tests; W4 replaces every body. Standard library only.
package deviceclient

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
)

// Config names the partner BFF's device routes.
type Config struct {
	StartURL, TokenURL                string
	ClientID, DeviceName, SubjectHint string
	HTTPClient                        *http.Client
}

// Authorization is the RFC 8628 § 3.2 answer.
type Authorization struct {
	DeviceCode, UserCode, VerificationURI, VerificationURIComplete string
	ExpiresIn, Interval                                            int
}

// Error is any poll answer other than the four RFC codes (R-CLI2).
type Error struct {
	Code, Description string
	Status            int
}

func (e *Error) Error() string { return e.Code }

var (
	ErrAccessDenied = errors.New("deviceclient: access_denied")
	ErrExpiredToken = errors.New("deviceclient: expired_token")
	errNotBuilt     = errors.New("deviceclient: not implemented")
)

// Start requests a device authorization. STUB.
func Start(ctx context.Context, cfg Config) (*Authorization, error) { return nil, errNotBuilt }

// Poll waits for the approval and returns the raw token body. STUB.
func Poll(ctx context.Context, cfg Config, a *Authorization) (json.RawMessage, error) {
	return nil, errNotBuilt
}
