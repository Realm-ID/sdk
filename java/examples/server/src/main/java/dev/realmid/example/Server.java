package dev.realmid.example;

import com.sun.net.httpserver.HttpServer;
import dev.realmid.sdk.Claims;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.RealmException;
import dev.realmid.sdk.auth.LoginRequest;
import dev.realmid.sdk.auth.Session;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;

/**
 * Minimal example of integrating the Realm ID SDK without a servlet container.
 * Uses {@link com.sun.net.httpserver.HttpServer} so the example pulls no extra
 * dependencies. The same logic, lifted into a Servlet container, would be a
 * one-line {@code RealmFilter} mount.
 */
public final class Server {
    public static void main(String[] args) throws IOException {
        String realmId = System.getenv().getOrDefault("REALM_ID", "01HXYZ");
        String apiKey = System.getenv().getOrDefault("REALM_API_KEY", "rk_live_demo");
        String baseUrl = System.getenv().getOrDefault("REALM_BASE_URL", "https://auth.realmid.dev");

        Realm realm = Realm.builder()
                .realmId(realmId)
                .apiKey(apiKey)
                .baseUrl(baseUrl)
                .logger(System.getLogger("realmid"))
                .build();

        HttpServer http = HttpServer.create(new InetSocketAddress(8080), 0);
        http.createContext("/login", ex -> {
            if (!"POST".equals(ex.getRequestMethod())) {
                ex.sendResponseHeaders(405, -1);
                return;
            }
            byte[] reqBody = ex.getRequestBody().readAllBytes();
            // Naive body parsing — production code uses Jackson here.
            String method = "firebase";
            String providerToken = new String(reqBody);
            try {
                Session s = realm.auth().login(LoginRequest.of(method, providerToken));
                String json = "{\"access_token\":\"" + s.accessToken() + "\"}";
                send(ex, 200, json);
            } catch (RealmException e) {
                send(ex, 401, "{\"error\":{\"code\":\"" + e.getCode().wire() + "\"}}");
            }
        });
        http.createContext("/", ex -> {
            String auth = ex.getRequestHeaders().getFirst("Authorization");
            if (auth == null || !auth.toLowerCase().startsWith("bearer ")) {
                send(ex, 401, "{\"error\":{\"code\":\"unauthorized\"}}");
                return;
            }
            try {
                Claims c = realm.verify(auth.substring(7).trim());
                send(ex, 200, "{\"sub\":\"" + c.subject() + "\",\"tenant_id\":\"" + c.tenantId() + "\"}");
            } catch (RealmException e) {
                send(ex, 401, "{\"error\":{\"code\":\"" + e.getCode().wire() + "\"}}");
            }
        });
        http.start();
        System.out.println("realmid example listening on :8080");
    }

    private static void send(com.sun.net.httpserver.HttpExchange ex, int status, String body) throws IOException {
        byte[] b = body.getBytes();
        ex.getResponseHeaders().add("content-type", "application/json");
        ex.sendResponseHeaders(status, b.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(b);
        }
    }
}
