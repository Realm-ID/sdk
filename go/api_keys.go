package realmid

import (
	"context"
	"net/url"
)

// APIKey is one entry returned from realm.APIKeys.* (SPEC §6.5).
type APIKey struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name,omitempty"`
	Prefix      string `json:"prefix,omitempty"`
	// Secret is only present on creation.
	Secret    string   `json:"secret,omitempty"`
	Scopes    []string `json:"scopes,omitempty"`
	CreatedAt string   `json:"created_at,omitempty"`
	RevokedAt string   `json:"revoked_at,omitempty"`
}

// APIKeyCreate is the create payload.
type APIKeyCreate struct {
	DisplayName string   `json:"display_name"`
	Scopes      []string `json:"scopes,omitempty"`
}

// APIKeysClient is realm.APIKeys.
type APIKeysClient struct {
	realm *Realm
}

func (c *APIKeysClient) Create(ctx context.Context, body APIKeyCreate) (*APIKey, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var k APIKey
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/platforms/" + url.PathEscape(c.realm.realmID) + "/api-keys",
		Bearer: tok,
		Body:   body,
	}, &k); err != nil {
		return nil, err
	}
	return &k, nil
}

// List returns every API key associated with this realm. List endpoints
// for api-keys are usually small and unpaginated; we accept either the
// {items, next_cursor} shape or a flat array.
func (c *APIKeysClient) List(ctx context.Context) ([]APIKey, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var raw any
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "GET",
		Path:   "/platforms/" + url.PathEscape(c.realm.realmID) + "/api-keys",
		Bearer: tok,
	}, &raw); err != nil {
		return nil, err
	}
	return decodeAPIKeyList(raw)
}

func (c *APIKeysClient) Revoke(ctx context.Context, id string) error {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return err
	}
	return c.realm.http.do(ctx, requestOptions{
		Method: "DELETE",
		Path:   "/platforms/" + url.PathEscape(c.realm.realmID) + "/api-keys/" + url.PathEscape(id),
		Bearer: tok,
	}, nil)
}

func decodeAPIKeyList(raw any) ([]APIKey, error) {
	var arr []any
	switch v := raw.(type) {
	case []any:
		arr = v
	case map[string]any:
		if items, ok := v["items"].([]any); ok {
			arr = items
		} else if items, ok := v["api_keys"].([]any); ok {
			arr = items
		} else {
			return nil, &RealmError{Code: ErrCodeServerError, Message: "api-keys list missing items"}
		}
	default:
		return nil, &RealmError{Code: ErrCodeServerError, Message: "api-keys list unexpected shape"}
	}
	out := make([]APIKey, 0, len(arr))
	for _, x := range arr {
		obj, ok := x.(map[string]any)
		if !ok {
			continue
		}
		k := APIKey{
			ID:          strField(obj, "id"),
			DisplayName: strField(obj, "display_name"),
			Prefix:      strField(obj, "prefix"),
			Secret:      strField(obj, "secret"),
			CreatedAt:   strField(obj, "created_at"),
			RevokedAt:   strField(obj, "revoked_at"),
		}
		if scopes, ok := obj["scopes"].([]any); ok {
			for _, s := range scopes {
				if str, ok := s.(string); ok {
					k.Scopes = append(k.Scopes, str)
				}
			}
		}
		out = append(out, k)
	}
	return out, nil
}
