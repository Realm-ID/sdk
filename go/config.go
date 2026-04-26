package realmid

import (
	"context"
	"net/url"
)

// ConfigPatch is a partial patch of realm-level configuration (SPEC §6.5).
// The server enforces an allowlist of mutable keys; unknown keys are
// rejected with a 400.
type ConfigPatch map[string]any

// ConfigClient is realm.Config.
type ConfigClient struct {
	realm *Realm
}

// Update issues PATCH /realms/{id}/config.
func (c *ConfigClient) Update(ctx context.Context, patch ConfigPatch) error {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return err
	}
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "PATCH",
		Path:   "/realms/" + url.PathEscape(c.realm.realmID) + "/config",
		Bearer: tok,
		Body:   patch,
	}, nil); err != nil {
		return err
	}
	// Invalidate cached realm.Info so the next read picks up any audience change.
	c.realm.info.invalidate()
	return nil
}
