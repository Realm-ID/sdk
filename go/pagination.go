package realmid

import (
	"context"
	"iter"
)

// PageOpts is the per-page input to a list endpoint's manual pager.
type PageOpts struct {
	Cursor string
	Limit  int
}

// Page is one page of results in the locked wire shape (SPEC §7).
type Page[T any] struct {
	Items      []T    `json:"items"`
	NextCursor string `json:"next_cursor,omitempty"`
	Total      *int   `json:"total,omitempty"`
}

// pageEnvelope is the strict wire shape every list endpoint must return.
// The SDK rejects any other shape with a server_error RealmError.
type pageEnvelope[T any] struct {
	Items      []T    `json:"items"`
	NextCursor string `json:"next_cursor,omitempty"`
	Total      *int   `json:"total,omitempty"`
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
			if page.NextCursor == "" {
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
