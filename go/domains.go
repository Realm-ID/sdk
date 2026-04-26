package realmid

import "context"

// DomainClaim is the response from realm.Domains.Claim. The TXT record
// fields (when populated) tell the partner what to provision in DNS to
// complete the verify step.
type DomainClaim struct {
	Hostname   string     `json:"hostname"`
	ClaimToken string     `json:"claim_token,omitempty"`
	TxtRecord  *DomainTxt `json:"txt_record,omitempty"`
	Status     string     `json:"status,omitempty"`
}

// DomainTxt is the {name, value} pair the partner must publish at DNS
// for the verify step.
type DomainTxt struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// DomainVerifyResult is returned from realm.Domains.Verify after the
// server reads the published TXT record.
type DomainVerifyResult struct {
	Hostname string `json:"hostname,omitempty"`
	Verified bool   `json:"verified,omitempty"`
	Status   string `json:"status,omitempty"`
}

// DomainsClient is realm.Domains (SPEC §6.4).
type DomainsClient struct {
	realm *Realm
}

// Claim begins a domain claim and returns the TXT record to publish.
func (c *DomainsClient) Claim(ctx context.Context, hostname string) (*DomainClaim, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var resp DomainClaim
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/domains/claim",
		Bearer: tok,
		Body:   map[string]string{"hostname": hostname},
	}, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// Verify finishes a previously-started domain claim.
func (c *DomainsClient) Verify(ctx context.Context, claimToken string) (*DomainVerifyResult, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var resp DomainVerifyResult
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/domains/verify",
		Bearer: tok,
		Body:   map[string]string{"claim_token": claimToken},
	}, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}
