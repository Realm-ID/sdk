package dev.realmid.sdk;

import org.junit.jupiter.api.Test;

import java.io.File;
import java.lang.reflect.Constructor;
import java.lang.reflect.RecordComponent;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * No record in the SDK may print a secret from its default {@code toString()}. Discovers every
 * record under {@code dev.realmid.sdk} whose components are named like a credential, builds one
 * with a sentinel in each such component, and requires the sentinel to be absent from toString.
 */
class SecretToStringTest {
    private static final String SENTINEL = "SENTINEL-SECRET-VALUE";
    private static final Pattern SECRETISH = Pattern.compile(
            "(?i)token|password|secret|presented|bearer|apikey|otp|refresh|recovery|qrurl|^code$|^value$|minted");
    /** Components that match the pattern but are not credentials (an error code, not a secret). */
    private static final Set<String> NOT_SECRET = Set.of(
            "RefreshOutcome.code",       // an error code
            "OtpVerifyResponse.otpId",   // a row id
            "DomainClaim.claimToken",    // published by design: the caller puts it in a DNS TXT record
            "TxtRecord.value",           // ditto
            "TwilioChannel.apiKeySid",   // a public identifier (SK...); the secret half is apiKeySecret
            "MessagingChannel.apiKeySid", // ditto, on the read type
            "MessagingChannel.secretHint"); // the last 4 chars of the primary secret, by design (SPEC 6.16)

    @Test
    void noRecordToStringCarriesASecret() throws Exception {
        Path root = Path.of(Realm.class.getProtectionDomain().getCodeSource().getLocation().toURI());
        List<Class<?>> records = new ArrayList<>();
        try (Stream<Path> s = Files.walk(root)) {
            for (Path p : (Iterable<Path>) s.filter(x -> x.toString().endsWith(".class"))::iterator) {
                String name = root.relativize(p).toString().replace(File.separatorChar, '.')
                        .replaceAll("\\.class$", "");
                Class<?> c = Class.forName(name, false, Realm.class.getClassLoader());
                if (c.isRecord()) records.add(c);
            }
        }
        List<String> leaks = new ArrayList<>();
        List<String> skipped = new ArrayList<>();
        int examined = 0;
        for (Class<?> c : records) {
            RecordComponent[] comps = c.getRecordComponents();
            boolean any = false;
            Object[] args = new Object[comps.length];
            Class<?>[] types = new Class<?>[comps.length];
            for (int i = 0; i < comps.length; i++) {
                types[i] = comps[i].getType();
                boolean secret = SECRETISH.matcher(comps[i].getName()).find()
                        && !NOT_SECRET.contains(c.getSimpleName() + "." + comps[i].getName());
                args[i] = value(comps[i], secret);
                any |= secret && args[i] != null;
            }
            if (!any) continue;
            examined++;
            Constructor<?> k = c.getDeclaredConstructor(types);
            k.setAccessible(true);
            try {
                String str = k.newInstance(args).toString();
                if (str.contains(SENTINEL)) leaks.add(c.getName());
            } catch (ReflectiveOperationException e) {
                skipped.add(c.getName());
            }
        }
        assertTrue(examined >= 15, "examined only " + examined + " secret-bearing records");
        assertEquals(List.of(), skipped, "could not build");
        assertEquals(List.of(), leaks, "records whose toString prints a secret");
    }

    private static Object value(RecordComponent rc, boolean secret) {
        Class<?> t = rc.getType();
        if (t == String.class) return secret ? SENTINEL : "x";
        if (t == List.class) return secret ? List.of(SENTINEL) : List.of();
        if (t == Map.class) return secret ? Map.of("k", SENTINEL) : Map.of();
        if (t == boolean.class) return false;
        if (t == long.class) return 0L;
        if (t == int.class) return 0;
        if (t == Object.class) return secret ? SENTINEL : 0;
        return null;
    }
}
