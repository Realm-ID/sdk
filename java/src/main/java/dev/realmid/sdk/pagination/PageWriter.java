package dev.realmid.sdk.pagination;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.util.function.Function;

/**
 * Re-encodes a {@link Page} back to its SPEC §7 wire envelope.
 *
 * <p>Exists so the round trip is TESTABLE, and so any consumer that decodes a
 * page and re-emits it (a BFF, a proxy, a cache) has one correct way to do it
 * rather than a hand-rolled object that quietly omits a key. That is not a
 * hypothetical failure: {@code go/v0.53.0} deleted {@code credential_methods}
 * from discovery exactly that way, and every layer's own suite stayed green
 * because nothing tested the round trip.
 *
 * <p>{@code next_cursor} and {@code has_more} are ALWAYS emitted —
 * {@code has_more: false} is a real answer ("this is the last page") and an
 * absent key is not. {@code total} is emitted only when the server sent one.
 */
public final class PageWriter {
    private PageWriter() {}

    public static <T> JsonNode write(ObjectMapper mapper, Page<T> page, Function<T, JsonNode> toNode) {
        ObjectNode out = mapper.createObjectNode();
        ArrayNode items = out.putArray("items");
        for (T item : page.items()) items.add(toNode.apply(item));
        if (page.nextCursor() == null || page.nextCursor().isEmpty()) {
            out.putNull("next_cursor");
        } else {
            out.put("next_cursor", page.nextCursor());
        }
        out.put("has_more", page.hasMore());
        if (page.total() != null) out.put("total", page.total());
        return out;
    }

    /** Convenience overload for records Jackson can serialize directly. */
    public static <T> JsonNode write(ObjectMapper mapper, Page<T> page) {
        return write(mapper, page, item -> mapper.valueToTree(item));
    }
}
