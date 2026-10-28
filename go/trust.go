package realmid

// Trust for a split realm (SPEC §14.4, R39): a verifier with Config.Split trusts ONLY the public
// keys in the partner's share bundle (plus a previous key until its trust_until) and never
// fetches RealmID's JWKS. A kid the bundle does not pin is refused with ErrCodeUnpinnedKID, and
// the log line names the kid so an operator can see which key was offered.

import (
	"context"
	"crypto/rsa"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"
)

// splitReloadMin rate-limits the re-read a kid the cache does not know triggers (SPEC §14.5:
// "one rate-limited re-read on an unknown kid"), so a stream of forged kids cannot hammer the
// custody store. splitRefreshEvery is the poll that picks up a rotation made by another pod.
const (
	splitReloadMin    = 5 * time.Second
	splitRefreshEvery = 30 * time.Second
)

// splitState is a Realm's view of its share bundle.
type splitState struct {
	src    ShareSource
	realm  *Realm
	mu     sync.Mutex
	bundle *ShareBundle
	ver    string
	loaded time.Time
	keys   map[string]*splitKeyInfo
}

type splitKeyInfo struct {
	pub        *rsa.PublicKey
	trustUntil int64 // 0 = current key, never expires on its own
}

func newSplitState(r *Realm, src ShareSource) *splitState {
	return &splitState{src: src, realm: r}
}

// reloadLocked re-reads the source and rebuilds the pinned-key map. Caller holds mu.
func (s *splitState) reloadLocked(ctx context.Context) error {
	b, ver, err := s.src.Load(ctx)
	if err != nil {
		return fmt.Errorf("realmid: split share source: %w", err)
	}
	if b == nil {
		return errors.New("realmid: split share source returned no bundle")
	}
	keys := make(map[string]*splitKeyInfo, len(b.Shares)+len(b.Previous))
	for kid, e := range b.Shares {
		p, err := e.decode()
		if err != nil {
			return fmt.Errorf("realmid: share %q: %w", kid, err)
		}
		keys[kid] = &splitKeyInfo{pub: &rsa.PublicKey{N: p.n, E: int(p.e.Int64())}}
	}
	for _, pk := range b.Previous {
		if _, taken := keys[pk.KID]; taken {
			continue
		}
		p, err := ShareEntry{N: pk.N, E: pk.E, DPartner: ""}.decode()
		if err != nil {
			return fmt.Errorf("realmid: previous key %q: %w", pk.KID, err)
		}
		keys[pk.KID] = &splitKeyInfo{pub: &rsa.PublicKey{N: p.n, E: int(p.e.Int64())}, trustUntil: pk.TrustUntil}
	}
	s.bundle, s.ver, s.keys, s.loaded = b, ver, keys, s.realm.clock()
	return nil
}

// current returns the loaded bundle, loading it on first use and re-reading when the poll
// interval has passed.
func (s *splitState) current(ctx context.Context) (*ShareBundle, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.bundle == nil || s.realm.clock().Sub(s.loaded) >= splitRefreshEvery {
		if err := s.reloadLocked(ctx); err != nil {
			if s.bundle == nil {
				return nil, err
			}
			s.realm.logger.Warn("realmid split share reload failed; keeping the loaded bundle", slog.String("error", err.Error()))
		}
	}
	return s.bundle, nil
}

// entry returns the partner share for kid, with one rate-limited re-read when it is unknown.
func (s *splitState) entry(ctx context.Context, kid string) (ShareEntry, error) {
	b, err := s.current(ctx)
	if err != nil {
		return ShareEntry{}, err
	}
	if e, ok := b.Shares[kid]; ok {
		return e, nil
	}
	s.mu.Lock()
	if s.realm.clock().Sub(s.loaded) >= splitReloadMin {
		_ = s.reloadLocked(ctx)
	}
	b = s.bundle
	s.mu.Unlock()
	if e, ok := b.Shares[kid]; ok {
		return e, nil
	}
	return ShareEntry{}, &RealmError{Code: ErrCodeUnpinnedKID,
		Message: fmt.Sprintf("signing kid %q is not in the share bundle", kid)}
}

// publicKey resolves kid for the verifier from the bundle only.
func (s *splitState) publicKey(ctx context.Context, kid string) (*rsa.PublicKey, *RealmError) {
	if _, err := s.current(ctx); err != nil {
		return nil, &RealmError{Code: ErrCodeJWKSFetchFailed, Message: err.Error(), Cause: err}
	}
	lookup := func() (*splitKeyInfo, bool) {
		s.mu.Lock()
		defer s.mu.Unlock()
		k, ok := s.keys[kid]
		return k, ok
	}
	k, ok := lookup()
	if !ok {
		s.mu.Lock()
		if s.realm.clock().Sub(s.loaded) >= splitReloadMin {
			_ = s.reloadLocked(ctx)
		}
		s.mu.Unlock()
		k, ok = lookup()
	}
	if ok && k.trustUntil != 0 && s.realm.clock().Unix() >= k.trustUntil {
		ok = false
	}
	if !ok {
		s.realm.logger.Error("realmid verify refused an unpinned kid", slog.String("kid", kid))
		return nil, &RealmError{Code: ErrCodeUnpinnedKID,
			Message: fmt.Sprintf("signing kid %q is not pinned by the share bundle", kid), HTTPStatus: 401}
	}
	return k.pub, nil
}

// expectedIssuer is the iss a co-signed token must carry: the realm's own issuer URL.
func (r *Realm) expectedIssuer() string {
	return strings.TrimRight(r.baseURL, "/") + "/" + r.realmID
}
