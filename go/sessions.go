package realmid

import (
	ctxpkg "context"
	"net/url"
)

// SessionsClient is realm.Sessions — the owner/admin session-revocation
// surface (distinct from AuthClient.RevokeAllSessions, which revokes the
// CURRENT user's own sessions). Both operations require the sessions:revoke
// permission (owner implicit-all).
type SessionsClient struct {
	realm *Realm
}

// SessionRevokeResult is the response from SessionsClient.RevokeUser / RevokeAll:
// how many sessions the revocation touched.
type SessionRevokeResult struct {
	Status  string `json:"status"`
	Revoked int64  `json:"revoked"`
}

// RevokeUser force-logs-out a specific user: every one of the target user's
// sessions in the tenant's realm is revoked (POST
// /tenants/{id}/users/{uid}/sessions/revoke). Distinct from the self-service
// AuthClient.RevokeAllSessions (which only touches the caller's own sessions).
// Owner/admin only (sessions:revoke). A user not in the tenant yields
// RealmError(not_found) (404).
func (c *SessionsClient) RevokeUser(ctx ctxpkg.Context, tenantID, userID string) (*SessionRevokeResult, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out SessionRevokeResult
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/tenants/" + url.PathEscape(tenantID) + "/users/" + url.PathEscape(userID) + "/sessions/revoke",
		Bearer: tok,
	}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RevokeAll is a realm-wide mass logout (POST /platforms/{id}/sessions/revoke-all)
// — every session in the realm is revoked (e.g. breach response). The DB
// revocation is authoritative; the Redis active-session sets are cleared
// realm-wide so no user trips the session-limit counter on next login.
// Owner/admin only (sessions:revoke on the realm).
func (c *SessionsClient) RevokeAll(ctx ctxpkg.Context) (*SessionRevokeResult, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out SessionRevokeResult
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/platforms/" + url.PathEscape(c.realm.realmID) + "/sessions/revoke-all",
		Bearer: tok,
	}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
