package realmid

// SIGNATURE-ONLY STUBS for SPEC §15 (device login). The red tests in device_handlers_test.go compile
// against these; W4 replaces every body. No logic lives here: each handler answers 501.

import (
	"errors"
	"net/http"
	"time"
)

// ErrDeviceApprovalNotAllowed is the R86 sentinel for `403 device_approval_not_allowed` (SPEC §3.1, §15.3).
var ErrDeviceApprovalNotAllowed = errors.New("realmid: this person may not approve devices here")

// DeviceHandlerSet is the six handlers of the device flow (SPEC §15.1).
type DeviceHandlerSet struct {
	Start, Token                    http.Handler
	Inspect, Approve, Deny, SignOut http.Handler
}

// DeviceApprover is the person approving, from the verified access token (SPEC §15.3).
type DeviceApprover struct {
	UserID, TenantID, SessionID string
	Claims                      *Claims
}

// DeviceRequest is the issuer's inspect answer as the hooks see it (SPEC §15.3).
type DeviceRequest struct {
	ID, Status, ClientID, DeviceName, SubjectHint, ReportedIP, ObservedIP string
	CreatedAt, ExpiresAt                                                  time.Time
}

// DeviceSubject names the account an approval binds (SPEC §15.3).
type DeviceSubject struct {
	Ref, Kind, TenantID, Label string
}

// DeviceLoginResult is the issuer's self-case DeviceLoginResponse (SPEC §15.2).
type DeviceLoginResult struct {
	RefreshToken string `json:"refresh_token"`
	TenantID     string `json:"tenant_id,omitempty"`
	SessionID    string `json:"session_id,omitempty"`
}

// DeviceTokens is what the issuer minted at collection, passed to OnIssued (SPEC §15.2).
type DeviceTokens struct {
	SubjectType           string
	DeviceAuthorizationID string
	Bot                   *MintResult
	ServiceAccountID      string
	Self                  *DeviceLoginResult
}

// DeviceOptions configures DeviceHandlers (SPEC §15.3).
type DeviceOptions struct {
	VerificationURI             string
	OmitVerificationURIComplete bool
	CanApprove                  func(r *http.Request, approver DeviceApprover, req *DeviceRequest) bool
	OnBeforeApprove             func(r *http.Request, approver DeviceApprover, req DeviceRequest) error
	ResolveSubject              func(r *http.Request, approver DeviceApprover, req DeviceRequest, preview bool) (DeviceSubject, error)
	OnIssued                    func(r *http.Request, tokens DeviceTokens) (status int, body any, err error)
	ReplaceExistingSessions     bool
	DisableApproveStepUp        bool
	ApproveStepUp               *MFARule
	DeviceIP                    func(r *http.Request) string
}

func deviceNotImplemented() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "device login not implemented", http.StatusNotImplemented)
	})
}

// DeviceHandlers builds the device handler set (SPEC §15.1). STUB.
func DeviceHandlers(client *Realm, opts DeviceOptions) (*DeviceHandlerSet, error) {
	n := deviceNotImplemented()
	return &DeviceHandlerSet{Start: n, Token: n, Inspect: n, Approve: n, Deny: n, SignOut: n}, nil
}

// Mount registers the six handlers under prefix at the default paths (SPEC §15.1). STUB.
func (s *DeviceHandlerSet) Mount(mux *http.ServeMux, prefix string) {}
