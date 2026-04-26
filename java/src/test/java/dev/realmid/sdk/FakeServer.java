package dev.realmid.sdk;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.BiFunction;

/** Tiny test HTTP server used across the SDK suite. */
public final class FakeServer implements AutoCloseable {

    public static final ObjectMapper M = new ObjectMapper();

    public final HttpServer server;
    public final String baseUrl;
    public final List<Recorded> recorded = new ArrayList<>();
    public final Map<String, BiFunction<HttpExchange, byte[], Reply>> handlers = new ConcurrentHashMap<>();

    public FakeServer() throws IOException {
        this.server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        this.server.createContext("/", new Dispatcher());
        // Disable keep-alive: each request gets a fresh socket so the JDK
        // HttpClient connection pool can't hand out a half-closed socket on
        // the next call.
        this.server.setExecutor(java.util.concurrent.Executors.newCachedThreadPool());
        this.server.start();
        this.baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
    }

    public FakeServer on(String methodAndPath, BiFunction<HttpExchange, byte[], Reply> fn) {
        handlers.put(methodAndPath, fn);
        return this;
    }

    public FakeServer onJson(String methodAndPath, BiFunction<Map<String, Object>, Recorded, Reply> fn) {
        handlers.put(methodAndPath, (ex, raw) -> {
            Map<String, Object> body = new LinkedHashMap<>();
            if (raw != null && raw.length > 0) {
                try {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> parsed = M.readValue(raw, Map.class);
                    if (parsed != null) body = parsed;
                } catch (Exception ignored) {}
            }
            Recorded r = recorded.get(recorded.size() - 1);
            return fn.apply(body, r);
        });
        return this;
    }

    @Override
    public void close() {
        server.stop(0);
    }

    public Recorded last() {
        return recorded.isEmpty() ? null : recorded.get(recorded.size() - 1);
    }

    public static final class Recorded {
        public final String method;
        public final String path;
        public final Map<String, List<String>> headers;
        public final byte[] body;

        public Recorded(String method, String path, Map<String, List<String>> headers, byte[] body) {
            this.method = method;
            this.path = path;
            this.headers = headers;
            this.body = body;
        }

        public String header(String name) {
            for (Map.Entry<String, List<String>> e : headers.entrySet()) {
                if (e.getKey().equalsIgnoreCase(name) && !e.getValue().isEmpty()) {
                    return e.getValue().get(0);
                }
            }
            return null;
        }

        public Map<String, Object> bodyAsMap() {
            if (body == null || body.length == 0) return Map.of();
            try {
                @SuppressWarnings("unchecked")
                Map<String, Object> m = M.readValue(body, Map.class);
                return m;
            } catch (Exception e) {
                return Map.of();
            }
        }
    }

    public static final class Reply {
        public final int status;
        public final byte[] body;
        public final String contentType;

        public Reply(int status, byte[] body, String contentType) {
            this.status = status;
            this.body = body == null ? new byte[0] : body;
            this.contentType = contentType == null ? "application/json" : contentType;
        }

        public static Reply json(int status, Object body) {
            try {
                return new Reply(status, M.writeValueAsBytes(body), "application/json");
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        }

        public static Reply empty(int status) {
            return new Reply(status, new byte[0], "application/json");
        }
    }

    private final class Dispatcher implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            try {
                handleInner(ex);
            } finally {
                ex.close();
            }
        }

        private void handleInner(HttpExchange ex) throws IOException {
            byte[] body;
            try (var is = ex.getRequestBody()) {
                body = is.readAllBytes();
            }
            Recorded rec = new Recorded(ex.getRequestMethod(), ex.getRequestURI().getPath(),
                    ex.getRequestHeaders(), body);
            recorded.add(rec);

            String key = ex.getRequestMethod() + " " + ex.getRequestURI().getPath();
            BiFunction<HttpExchange, byte[], Reply> h = handlers.get(key);
            // path-prefix match too
            if (h == null) {
                for (Map.Entry<String, BiFunction<HttpExchange, byte[], Reply>> e : handlers.entrySet()) {
                    String[] parts = e.getKey().split(" ", 2);
                    if (parts.length == 2 && parts[0].equals(ex.getRequestMethod())
                            && parts[1].endsWith("*")
                            && ex.getRequestURI().getPath().startsWith(parts[1].substring(0, parts[1].length() - 1))) {
                        h = e.getValue();
                        break;
                    }
                }
            }
            if (h == null) {
                ex.sendResponseHeaders(404, 0);
                ex.close();
                return;
            }
            Reply r;
            try {
                r = h.apply(ex, body);
            } catch (RuntimeException re) {
                Reply err = Reply.json(500, Map.of("error", Map.of("code", "server_error", "message", re.getMessage())));
                ex.getResponseHeaders().add("content-type", err.contentType);
                ex.sendResponseHeaders(err.status, err.body.length);
                try (OutputStream os = ex.getResponseBody()) {
                    os.write(err.body);
                }
                return;
            }
            ex.getResponseHeaders().add("content-type", r.contentType);
            ex.getResponseHeaders().add("Connection", "close");
            if (r.body.length == 0 && r.status == 204) {
                ex.sendResponseHeaders(204, -1);
                ex.close();
                return;
            }
            ex.sendResponseHeaders(r.status, r.body.length);
            try (OutputStream os = ex.getResponseBody()) {
                os.write(r.body);
                os.flush();
            }
        }
    }
}
