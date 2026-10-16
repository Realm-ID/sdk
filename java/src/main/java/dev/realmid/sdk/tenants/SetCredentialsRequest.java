package dev.realmid.sdk.tenants;

/**
 * Body of {@link UsersClient#setCredentials}. An empty field is not sent; at least one is
 * required (the issuer answers {@code 400 bad_request} otherwise). {@code password} is a secret:
 * {@link #toString} does not print it.
 */
public record SetCredentialsRequest(String username, String password) {
    public static SetCredentialsRequest username(String username) {
        return new SetCredentialsRequest(username, null);
    }

    public static SetCredentialsRequest password(String password) {
        return new SetCredentialsRequest(null, password);
    }

    public static SetCredentialsRequest of(String username, String password) {
        return new SetCredentialsRequest(username, password);
    }

    @Override
    public String toString() {
        return "SetCredentialsRequest[username=" + username + "]";
    }
}
