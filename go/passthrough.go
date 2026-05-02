package realmid

import (
	ctxpkg "context"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// PassthroughOptions configures a single Realm.Do call.
type PassthroughOptions struct {
	// OnBehalfOfUser, when non-empty, rides as `X-On-Behalf-Of-User`
	// alongside the platform-token bearer. Use this from a BFF / partner
	// backend to attribute the call to a specific end-user (per ADR-041
	// §7 + ADR-050 plan §8.2).
	OnBehalfOfUser string

	// OnBehalfOfIP, when non-empty, rides as `X-On-Behalf-Of-IP`. Lets
	// the issuer's per-IP rate limits attribute to the SPA's IP rather
	// than the BFF's egress.
	OnBehalfOfIP string

	// Header carries any additional request headers to forward
	// verbatim (e.g. `Idempotency-Key`). Authorization is always
	// overwritten; do not set it here.
	Header http.Header
}

// Do issues an authenticated request to the realm's API and returns
// the raw *http.Response. The platform token is minted (and cached)
// behind the scenes; callers must close resp.Body.
//
// This is the escape hatch for BFF / proxy consumers that need to
// forward arbitrary admin-API calls without re-implementing the
// dual-token dance. Typed methods (Tenants, Roles, Origins, …) remain
// the recommended surface for application code.
//
// `path` is joined to the realm's base URL (`/foo/bar?x=1`); a leading
// slash is added if missing. `body` may be nil. Non-2xx responses are
// returned with the status intact — the caller decides whether to map
// them through *RealmError.
func (r *Realm) Do(ctx ctxpkg.Context, method, path string, body io.Reader, opts *PassthroughOptions) (*http.Response, error) {
	tok, err := r.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}

	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	full := r.baseURL + path

	req, err := http.NewRequestWithContext(ctx, method, full, body)
	if err != nil {
		return nil, &RealmError{Code: ErrCodeBadRequest, Message: fmt.Sprintf("build request: %v", err), Cause: err}
	}

	if opts != nil {
		for k, vs := range opts.Header {
			for _, v := range vs {
				req.Header.Add(k, v)
			}
		}
		if opts.OnBehalfOfUser != "" {
			req.Header.Set("X-On-Behalf-Of-User", opts.OnBehalfOfUser)
		}
		if opts.OnBehalfOfIP != "" {
			req.Header.Set("X-On-Behalf-Of-IP", opts.OnBehalfOfIP)
		}
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	if req.Header.Get("Accept") == "" {
		req.Header.Set("Accept", "application/json")
	}

	resp, err := r.http.hc.Do(req)
	if err != nil {
		return nil, &RealmError{
			Code:    ErrCodeNetwork,
			Message: fmt.Sprintf("network error calling %s %s: %v", method, path, err),
			Cause:   err,
		}
	}
	return resp, nil
}
