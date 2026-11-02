// Package deviceclient is the device side of RFC 8628 against a partner BFF (SPEC §15.7).
// Standard library only: it adds no dependency and does not import the root realmid package.
package deviceclient

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const grantDeviceCode = "urn:ietf:params:oauth:grant-type:device_code"

// Config names the partner BFF's device routes.
type Config struct {
	StartURL, TokenURL                string
	ClientID, DeviceName, SubjectHint string
	HTTPClient                        *http.Client // nil = http.DefaultClient
}

// Authorization is the RFC 8628 § 3.2 answer.
type Authorization struct {
	DeviceCode, UserCode, VerificationURI, VerificationURIComplete string
	ExpiresIn, Interval                                            int
}

// Error is any answer other than success and the four RFC poll codes (R-CLI2: the real reason).
type Error struct {
	Code, Description string
	Status            int
}

func (e *Error) Error() string {
	if e.Description != "" {
		return e.Code + ": " + e.Description
	}
	return e.Code
}

var (
	// ErrAccessDenied: the approver refused the request (terminal).
	ErrAccessDenied = errors.New("deviceclient: access_denied")
	// ErrExpiredToken: the request expired before it was approved and collected (terminal).
	ErrExpiredToken = errors.New("deviceclient: expired_token")
)

func (c Config) client() *http.Client {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	return http.DefaultClient
}

// answer is one parsed response: status and decoded body, plus the RFC error code when there is one.
type answer struct {
	status int
	raw    []byte
	code   string
	desc   string
}

func post(ctx context.Context, c Config, endpoint string, form url.Values) (*answer, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := c.client().Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	a := &answer{status: resp.StatusCode, raw: raw}
	if resp.StatusCode >= 400 {
		a.code, a.desc = errorFields(raw)
		if a.code == "" {
			a.code = fmt.Sprintf("http_%d", resp.StatusCode)
		}
	}
	return a, nil
}

// errorFields reads the code out of an RFC 6749 body {"error": "<code>"} and, tolerantly, out of the
// canonical envelope {"error": {"code": "<code>", "message": "..."}}.
func errorFields(raw []byte) (code, desc string) {
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return "", ""
	}
	switch e := m["error"].(type) {
	case string:
		code = e
		desc, _ = m["error_description"].(string)
	case map[string]any:
		code, _ = e["code"].(string)
		desc, _ = e["message"].(string)
	}
	return code, desc
}

// Start requests a device authorization from the partner BFF.
func Start(ctx context.Context, cfg Config) (*Authorization, error) {
	form := url.Values{}
	for k, v := range map[string]string{"client_id": cfg.ClientID, "device_name": cfg.DeviceName, "subject_hint": cfg.SubjectHint} {
		if v != "" {
			form.Set(k, v)
		}
	}
	a, err := post(ctx, cfg, cfg.StartURL, form)
	if err != nil {
		return nil, err
	}
	if a.status >= 400 {
		return nil, &Error{Code: a.code, Description: a.desc, Status: a.status}
	}
	var w struct {
		DeviceCode              string `json:"device_code"`
		UserCode                string `json:"user_code"`
		VerificationURI         string `json:"verification_uri"`
		VerificationURIComplete string `json:"verification_uri_complete"`
		ExpiresIn               int    `json:"expires_in"`
		Interval                int    `json:"interval"`
	}
	if err := json.Unmarshal(a.raw, &w); err != nil {
		return nil, fmt.Errorf("deviceclient: decode start answer: %w", err)
	}
	if w.DeviceCode == "" || w.UserCode == "" {
		return nil, &Error{Code: "invalid_response", Description: "start answer carries no device_code/user_code", Status: a.status}
	}
	return &Authorization{DeviceCode: w.DeviceCode, UserCode: w.UserCode, VerificationURI: w.VerificationURI,
		VerificationURIComplete: w.VerificationURIComplete, ExpiresIn: w.ExpiresIn, Interval: w.Interval}, nil
}

// Poll waits Interval between polls, adds 5 s on slow_down (and keeps the larger interval), keeps going on
// authorization_pending, returns ErrAccessDenied or ErrExpiredToken (terminal), returns ctx.Err() on
// cancel, and returns *Error for any other code (R-CLI2). On success it returns the raw JSON body: its
// shape is the partner's OnIssued choice. Past ExpiresIn from now it returns ErrExpiredToken without
// another request.
func Poll(ctx context.Context, cfg Config, a *Authorization) (json.RawMessage, error) {
	interval := time.Duration(a.Interval) * time.Second
	if interval <= 0 {
		interval = 5 * time.Second // RFC 8628 § 3.5 default
	}
	deadline := time.Now().Add(time.Duration(a.ExpiresIn) * time.Second)
	form := url.Values{"grant_type": {grantDeviceCode}, "device_code": {a.DeviceCode}}
	if cfg.ClientID != "" {
		form.Set("client_id", cfg.ClientID)
	}
	for {
		// Wait first: the device was just told to come back in `interval` seconds.
		wait := interval
		if until := time.Until(deadline); until < wait {
			wait = until
		}
		if wait > 0 {
			t := time.NewTimer(wait)
			select {
			case <-ctx.Done():
				t.Stop()
				return nil, ctx.Err()
			case <-t.C:
			}
		}
		if !time.Now().Before(deadline) {
			return nil, ErrExpiredToken
		}
		ans, err := post(ctx, cfg, cfg.TokenURL, form)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, err
		}
		if ans.status < 400 {
			return json.RawMessage(ans.raw), nil
		}
		switch ans.code {
		case "authorization_pending":
		case "slow_down":
			interval += 5 * time.Second
		case "access_denied":
			return nil, ErrAccessDenied
		case "expired_token":
			return nil, ErrExpiredToken
		default:
			return nil, &Error{Code: ans.code, Description: ans.desc, Status: ans.status}
		}
	}
}
