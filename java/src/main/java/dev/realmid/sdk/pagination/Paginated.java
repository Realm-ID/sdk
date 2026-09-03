package dev.realmid.sdk.pagination;

import java.util.Iterator;
import java.util.NoSuchElementException;
import java.util.Spliterator;
import java.util.Spliterators;
import java.util.function.Function;
import java.util.stream.Stream;
import java.util.stream.StreamSupport;

/** SPEC §7 — lazy iterator across pages. */
public interface Paginated<T> {
    /** Lazy stream that walks all pages. */
    Stream<T> stream();

    /** Single-page fetch with explicit cursor/limit control. */
    Page<T> page(PageOpts opts);

    /** Build a {@code Paginated<T>} from a single-page fetcher. */
    static <T> Paginated<T> of(Function<PageOpts, Page<T>> fetcher) {
        return new Paginated<>() {
            @Override
            public Page<T> page(PageOpts opts) {
                return fetcher.apply(opts == null ? PageOpts.empty() : opts);
            }

            @Override
            public Stream<T> stream() {
                Iterator<T> it = new Iterator<>() {
                    private Iterator<T> current = null;
                    private String cursor = null;
                    private boolean done = false;

                    private void ensure() {
                        while (current == null || !current.hasNext()) {
                            if (done) return;
                            Page<T> p = fetcher.apply(cursor == null ? PageOpts.empty() : PageOpts.withCursor(cursor));
                            current = p.items().iterator();
                            cursor = p.nextCursor();
                            // hasMore is the terminator, ahead of nextCursor: a
                            // server answering a stale non-empty cursor with
                            // has_more:false has said stop.
                            if (!p.hasMore() || cursor == null || cursor.isEmpty()) done = true;
                            if (!current.hasNext() && done) return;
                        }
                    }

                    @Override
                    public boolean hasNext() {
                        ensure();
                        return current != null && current.hasNext();
                    }

                    @Override
                    public T next() {
                        if (!hasNext()) throw new NoSuchElementException();
                        return current.next();
                    }
                };
                Spliterator<T> sp = Spliterators.spliteratorUnknownSize(it, Spliterator.ORDERED);
                return StreamSupport.stream(sp, false);
            }
        };
    }
}
