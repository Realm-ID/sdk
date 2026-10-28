package realmid

// The ready-made target-side integration token handler (SPEC §14.8; R47, R50, R67.2). A source
// platform's caller POSTs {"pass": "ip_..."} [inferred inbound shape]; the handler rate-limits,
// then calls the TARGET realm's token endpoint with grant_type=integration_installation, the
// target's platform token in Authorization and the pass in X-User-Token (never in a body). On a
// split target it finishes the half-signed answer and returns a normal token; otherwise it relays
// the issuer's answer verbatim. It does no authorization of its own. There is no registration
// canary in v1 (R94).

import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// IntegrationHandlerOptions configures NewIntegrationTokenHandler. RatePerMinute <= 0 means the
// SDK default [inferred].
type IntegrationHandlerOptions struct {
	RatePerMinute int
	// ClientKey names the rate-limit bucket of a request. Nil = the host of RemoteAddr.
	ClientKey func(*http.Request) string
}

// defaultIntegrationRate is requests per minute per client address when no rate is set.
const defaultIntegrationRate = 30

const integrationBodyMax = 8 << 10

type fixedWindowLimiter struct {
	mu     sync.Mutex
	limit  int
	window time.Duration
	now    func() time.Time
	hits   map[string]*windowCount
}

type windowCount struct {
	start time.Time
	n     int
}

func (l *fixedWindowLimiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	for k, w := range l.hits { // bound memory: drop expired windows
		if now.Sub(w.start) >= l.window {
			delete(l.hits, k)
		}
	}
	w := l.hits[key]
	if w == nil {
		w = &windowCount{start: now}
		l.hits[key] = w
	}
	w.n++
	return w.n <= l.limit
}

// NewIntegrationTokenHandler is the ready-made target-side handler (R47/R50/R67.2): mount it on
// the target platform's BFF. Limiting is per client address (RemoteAddr; put a reverse-proxy
// real-IP middleware in front if you sit behind one).
func NewIntegrationTokenHandler(target *Realm, opts IntegrationHandlerOptions) http.Handler {
	rate := opts.RatePerMinute
	if rate <= 0 {
		rate = defaultIntegrationRate
	}
	lim := &fixedWindowLimiter{limit: rate, window: time.Minute, now: target.clock, hits: map[string]*windowCount{}}
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeHandlerError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST only")
			return
		}
		var key string
		if opts.ClientKey != nil {
			key = opts.ClientKey(req)
		} else if host, _, err := net.SplitHostPort(req.RemoteAddr); err == nil {
			key = host
		} else {
			key = req.RemoteAddr
		}
		if !lim.allow(key) {
			w.Header().Set("Retry-After", "60")
			writeHandlerError(w, http.StatusTooManyRequests, "rate_limited", "too many requests")
			return
		}
		var in struct {
			Pass string `json:"pass"`
		}
		if err := json.NewDecoder(io.LimitReader(req.Body, integrationBodyMax)).Decode(&in); err != nil || in.Pass == "" {
			writeHandlerError(w, http.StatusBadRequest, "bad_request", `body must be {"pass": "<install pass>"}`)
			return
		}
		body := map[string]any{"realm_id": target.realmID, "grant_type": grantIntegrationInstallation}
		path := "/auth/token"
		if target.split != nil {
			path = "/auth/token/partial"
		}
		buf, _ := json.Marshal(body)
		resp, err := target.Do(req.Context(), http.MethodPost, path, bytes.NewReader(buf), &PassthroughOptions{
			OnBehalfOfUserToken: in.Pass,
			Header:              http.Header{"Content-Type": {"application/json"}},
		})
		if err != nil {
			writeHandlerError(w, http.StatusBadGateway, "upstream_unavailable", "the token endpoint could not be reached")
			return
		}
		defer func() { _ = resp.Body.Close() }()
		raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		if err != nil {
			writeHandlerError(w, http.StatusBadGateway, "upstream_unavailable", "the token endpoint answer could not be read")
			return
		}
		if target.split == nil || resp.StatusCode/100 != 2 {
			relay(w, resp, raw)
			return
		}
		mint, err := target.finishPartial(req.Context(), raw)
		if err != nil {
			writeHandlerError(w, http.StatusBadGateway, "cosign_failed", "the half-signed token could not be completed")
			return
		}
		var answer map[string]any
		_ = json.Unmarshal(raw, &answer)
		delete(answer, "signing")
		answer["access_token"] = mint.AccessToken
		answer["token_type"] = "Bearer"
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(answer)
	})
}

// grantIntegrationInstallation is the grant of an install-pass mint (R47).
const grantIntegrationInstallation = "integration_installation"

func relay(w http.ResponseWriter, resp *http.Response, raw []byte) {
	if ct := resp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	if ra := resp.Header.Get("Retry-After"); ra != "" {
		w.Header().Set("Retry-After", ra)
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(raw)
}

func writeHandlerError(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"code": code, "message": strings.TrimSpace(msg)}})
}
