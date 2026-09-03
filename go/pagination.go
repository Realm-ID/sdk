package realmid

import (
	"context"
	"encoding/json"
	"iter"
)

// PageOpts is the per-page input to a list endpoint's manual pager.
type PageOpts struct {
	Cursor string
	Limit  int
}

// Page is one page of results in the locked wire shape (SPEC §7).
//
// HasMore is the TRUNCATION SIGNAL and the only honest one. It is not derivable
// from Items: a page that fills exactly to the limit may or may not be the last,
// and Total is an estimate on some endpoints. Read HasMore, not len(Items).
//
// Every field carries an explicit JSON tag WITHOUT omitempty on has_more,
// because `has_more: false` is a real answer ("this is the last page") and an
// absent key is not. Re-encoding a Page must reproduce the envelope it was
// decoded from — see TestPageRoundTrip.
type Page[T any] struct {
	Items      []T    `json:"items"`
	NextCursor string `json:"next_cursor,omitempty"`
	HasMore    bool   `json:"has_more"`
	Total      *int   `json:"total,omitempty"`
}

// UnmarshalJSON decodes the wire envelope, tolerating endpoints that predate
// `has_more`. When the key is ABSENT the flag is derived from next_cursor,
// which is the correct reading for every pre-has_more endpoint (they emit a
// cursor exactly when another page exists). When it is PRESENT it wins — a
// server may answer a stale non-empty cursor alongside has_more:false, and the
// server's explicit statement is the terminator.
func (p *Page[T]) UnmarshalJSON(b []byte) error {
	var env pageEnvelope[T]
	if err := json.Unmarshal(b, &env); err != nil {
		return err
	}
	*p = env.page()
	return nil
}

// pageEnvelope is the strict wire shape every list endpoint must return.
// The SDK rejects any other shape with a server_error RealmError.
type pageEnvelope[T any] struct {
	Items      []T    `json:"items"`
	NextCursor string `json:"next_cursor,omitempty"`
	HasMore    *bool  `json:"has_more,omitempty"`
	Total      *int   `json:"total,omitempty"`
}

// page normalizes the wire envelope into a Page, resolving the tri-state
// has_more (present-true / present-false / absent) into a plain bool.
func (e pageEnvelope[T]) page() Page[T] {
	more := e.NextCursor != ""
	if e.HasMore != nil {
		more = *e.HasMore
	}
	return Page[T]{Items: e.Items, NextCursor: e.NextCursor, HasMore: more, Total: e.Total}
}

// Paginated wraps a list endpoint, exposing both an iterator and a
// manual .Page accessor so callers can choose either style.
type Paginated[T any] struct {
	fetch func(ctx context.Context, opts PageOpts) (*Page[T], error)
}

// Page fetches a single page given the supplied cursor/limit.
func (p *Paginated[T]) Page(ctx context.Context, opts *PageOpts) (*Page[T], error) {
	o := PageOpts{}
	if opts != nil {
		o = *opts
	}
	return p.fetch(ctx, o)
}

// All returns an iter.Seq2[T, error] that walks every page lazily.
//
//	for item, err := range list.All(ctx) { ... }
func (p *Paginated[T]) All(ctx context.Context) iter.Seq2[T, error] {
	return func(yield func(T, error) bool) {
		var cursor string
		for {
			page, err := p.fetch(ctx, PageOpts{Cursor: cursor})
			if err != nil {
				var zero T
				yield(zero, err)
				return
			}
			for _, item := range page.Items {
				if !yield(item, nil) {
					return
				}
			}
			// HasMore is the terminator, not NextCursor: a server that
			// answers a stale cursor with has_more:false has said stop.
			if !page.HasMore || page.NextCursor == "" {
				return
			}
			cursor = page.NextCursor
		}
	}
}

// newPaginated builds a Paginated[T] from a fetch closure.
func newPaginated[T any](fetch func(ctx context.Context, opts PageOpts) (*Page[T], error)) *Paginated[T] {
	return &Paginated[T]{fetch: fetch}
}
