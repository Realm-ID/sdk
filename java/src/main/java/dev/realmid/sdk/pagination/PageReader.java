package dev.realmid.sdk.pagination;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.RealmException;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;

/** Validates the SPEC §7 wire envelope and projects items to typed records. */
public final class PageReader {
    private PageReader() {}

    public static <T> Page<T> read(JsonNode raw, Function<JsonNode, T> mapItem) {
        if (raw == null || !raw.isObject()) {
            throw new RealmException(ErrorCode.SERVER_ERROR, "unexpected paginated response shape");
        }
        JsonNode itemsNode = raw.get("items");
        if (itemsNode == null || !itemsNode.isArray()) {
            throw new RealmException(ErrorCode.SERVER_ERROR, "unexpected paginated response shape");
        }
        List<T> items = new ArrayList<>(itemsNode.size());
        for (JsonNode n : itemsNode) items.add(mapItem.apply(n));

        String nextCursor = null;
        JsonNode nc = raw.get("next_cursor");
        if (nc != null && !nc.isNull()) {
            if (!nc.isTextual()) {
                throw new RealmException(ErrorCode.SERVER_ERROR, "unexpected paginated response shape");
            }
            String v = nc.asText();
            if (!v.isEmpty()) nextCursor = v;
        }
        // has_more is tri-state on the wire: true / false / ABSENT. Absent is
        // not false — it means the endpoint predates the field, and for every
        // such endpoint a non-empty cursor is exactly the "more pages" signal.
        boolean hasMore = nextCursor != null;
        JsonNode hm = raw.get("has_more");
        if (hm != null && !hm.isNull()) {
            if (!hm.isBoolean()) {
                throw new RealmException(ErrorCode.SERVER_ERROR, "unexpected paginated response shape");
            }
            hasMore = hm.asBoolean();
        }

        Long total = null;
        JsonNode t = raw.get("total");
        if (t != null && t.isNumber()) total = t.asLong();
        return new Page<>(items, nextCursor, hasMore, total);
    }

    public static <T> Page<T> read(ObjectMapper mapper, JsonNode raw, Class<T> type) {
        return read(raw, n -> mapper.convertValue(n, type));
    }
}
