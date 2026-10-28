package realmid

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
)

// userMintHandler serves the user-session mint at POST /auth/token (R49/R62: login returns a refresh
// token only, the access token is minted here). Pass it as the "/auth/token" entry of authTestServer.
func userMintHandler(access string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": access, "refresh_token": "rtok", "expires_in": 900,
			"tenant_id": "t1", "role": "member",
		})
	}
}

// platformMintThen serves the platform mint (grant_type=platform_api_key, R49/R71: /auth/token only)
// and hands every other /auth/token call to user (501 when nil). The body is re-primed for user.
func platformMintThen(user http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = r.Body.Close()
		var probe struct {
			GrantType string `json:"grant_type"`
		}
		_ = json.Unmarshal(body, &probe)
		if probe.GrantType == "platform_api_key" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"status": "ok", "subject_type": "platform", "access_token": "ptok", "expires_in": 300,
			})
			return
		}
		if user == nil {
			http.Error(w, "no token handler", http.StatusNotImplemented)
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		user(w, r)
	}
}
