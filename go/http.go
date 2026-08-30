package realmid

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// httpClient is the SDK's internal wrapper around net/http. It attaches
// auth + content-type headers, parses error envelopes per SPEC §3.2, and
// emits a debug log line per request/response.
type httpClient struct {
	baseURL string
	hc      *http.Client
	logger  *slog.Logger
}

func newHTTPClient(baseURL string, hc *http.Client, logger *slog.Logger) *httpClient {
	if hc == nil {
		hc = &http.Client{Timeout: 30 * time.Second}
	}
	return &httpClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		hc:      hc,
		logger:  logger,
	}
}

// requestOptions carries everything we need to issue one call.
type requestOptions struct {
	Method  string
	Path    string
	Query   map[string]string
	Body    any
	Bearer  string            // overrides any default
	Headers map[string]string // extra headers (e.g. Origin)
}

// do executes the request and JSON-decodes the response into out (if
// non-nil). On non-2xx, returns *RealmError. On network error, returns
// *RealmError{Code: network}.
func (c *httpClient) do(ctx context.Context, opts requestOptions, out any) error {
	method := opts.Method
	if method == "" {
		method = http.MethodGet
	}
	full := c.buildURL(opts.Path, opts.Query)

	var body io.Reader
	if opts.Body != nil {
		buf, err := json.Marshal(opts.Body)
		if err != nil {
			return &RealmError{Code: ErrCodeBadRequest, Message: fmt.Sprintf("marshal body: %v", err), Cause: err}
		}
		body = bytes.NewReader(buf)
	}

	req, err := http.NewRequestWithContext(ctx, method, full, body)
	if err != nil {
		return &RealmError{Code: ErrCodeBadRequest, Message: fmt.Sprintf("build request: %v", err), Cause: err}
	}
	req.Header.Set("Accept", "application/json")
	if opts.Body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if opts.Bearer != "" {
		req.Header.Set("Authorization", "Bearer "+opts.Bearer)
	}
	// ADR-056: forward the on-behalf-of user token (X-User-Token) on the typed
	// client path too, not just Realm.Do. A token stashed via WithUserToken(ctx)
	// makes user-scoped typed calls (Tenants.*, Origins.*, Auth.*) authorize on
	// the user, not the platform principal. The platform token stays the wire
	// bearer — this is additive. (Completes ADR-056; closes a partner-reported on-behalf-of gap.)
	if ut := userTokenFrom(ctx); ut != "" {
		req.Header.Set("X-User-Token", ut)
	}
	for k, v := range opts.Headers {
		req.Header.Set(k, v)
	}

	start := time.Now()
	c.logger.Debug("realmid http request",
		slog.String("method", method),
		slog.String("path", opts.Path),
		slog.String("bearer", redactCredential(opts.Bearer)),
	)

	resp, err := c.hc.Do(req)
	if err != nil {
		c.logger.Error("realmid http network error",
			slog.String("method", method),
			slog.String("path", opts.Path),
			slog.String("err", err.Error()),
		)
		return &RealmError{
			Code:    ErrCodeNetwork,
			Message: fmt.Sprintf("network error calling %s %s: %v", method, opts.Path, err),
			Cause:   err,
		}
	}
	defer func() { _ = resp.Body.Close() }()

	c.logger.Debug("realmid http response",
		slog.String("method", method),
		slog.String("path", opts.Path),
		slog.Int("status", resp.StatusCode),
		slog.Duration("latency", time.Since(start)),
	)

	if resp.StatusCode == http.StatusNoContent {
		return nil
	}

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return &RealmError{Code: ErrCodeNetwork, Message: fmt.Sprintf("read body: %v", err), Cause: err}
	}

	if resp.StatusCode >= 400 {
		return mapErrorResponse(resp.StatusCode, raw, method, opts.Path)
	}

	if out == nil || len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return &RealmError{Code: ErrCodeServerError, Message: fmt.Sprintf("decode response: %v", err), Cause: err}
	}
	return nil
}

func (c *httpClient) buildURL(path string, query map[string]string) string {
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	full := c.baseURL + path
	if len(query) == 0 {
		return full
	}
	v := url.Values{}
	for k, val := range query {
		if val == "" {
			continue
		}
		v.Set(k, val)
	}
	if enc := v.Encode(); enc != "" {
		full += "?" + enc
	}
	return full
}

func mapErrorResponse(status int, raw []byte, method, path string) *RealmError {
	return errorFromEnvelope(status, raw, fmt.Sprintf("%s %s failed with HTTP %d", method, path, status))
}

// errorFromEnvelope is the shared envelope reader behind both the typed client
// path (mapErrorResponse, which knows the method + path it called) and the
// exported ParseErrorEnvelope (which does not, and passes a status-derived
// message instead). defaultMessage is used when the body carries none.
func errorFromEnvelope(status int, raw []byte, defaultMessage string) *RealmError {
	code := statusToCode(status)
	message := defaultMessage
	var details map[string]any

	var generic map[string]any
	if len(raw) > 0 && json.Unmarshal(raw, &generic) == nil && generic != nil {
		// Envelope: { error: { code, message }, ...siblings }
		if env, ok := generic["error"].(map[string]any); ok {
			if c, ok := env["code"].(string); ok && isKnownCode(c) {
				code = ErrorCode(c)
			}
			if m, ok := env["message"].(string); ok && m != "" {
				message = m
			}
			siblings := map[string]any{}
			for k, v := range generic {
				if k == "error" {
					continue
				}
				siblings[k] = v
			}
			// Gate payloads (revocation_token, active_sessions,
			// mfa_challenge_token, …) are nested INSIDE the error object by
			// the issuer, not alongside it. Collect those too — otherwise
			// SessionLimitModal / MfaPrompt get an empty Details map.
			for k, v := range env {
				if k == "code" || k == "message" || k == "error" {
					continue
				}
				siblings[k] = v
			}
			if len(siblings) > 0 {
				details = siblings
			}
		} else {
			// Flat envelope { code, message | error: "<msg>", ...siblings }.
			// The issuer's apiErr.Response() emits { "error": "<msg>", "code":
			// "<code>" } — `error` is a STRING, not a nested object — so the
			// specific code lives at the top level alongside it. Read it here
			// (this is the shape most /auth error paths take, incl.
			// contact_admin_required, refresh_invalid, account_suspended).
			if c, ok := generic["code"].(string); ok && isKnownCode(c) {
				code = ErrorCode(c)
			}
			if m, ok := generic["message"].(string); ok && m != "" {
				message = m
			} else if s, ok := generic["error"].(string); ok && s != "" {
				message = s
			}
			siblings := map[string]any{}
			for k, v := range generic {
				if k == "code" || k == "message" || k == "error" {
					continue
				}
				siblings[k] = v
			}
			if len(siblings) > 0 {
				details = siblings
			}
		}
	}

	return &RealmError{
		Code:       code,
		Message:    message,
		HTTPStatus: status,
		Details:    details,
	}
}
