package dev.realmid.sdk.session;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.Random;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Supplier;

/**
 * SPEC §6.7.5 — the conformance suite a partner runs their shared
 * {@link SessionStateStore} (Redis, a database) through. It uses the real clock
 * and short TTLs (a few hundred milliseconds), so it needs no fake time and
 * works against any backend. Throws {@link AssertionError} naming the first
 * violated rule; {@code factory} must return a store that is EMPTY and isolated
 * per call.
 */
public final class SessionStateStoreConformance {

    private SessionStateStoreConformance() {}

    public static void run(Supplier<SessionStateStore> factory) throws Exception {
        revokeNeverShortens(factory.get());
        raiseNotBeforeIsMonotonicAndExtends(factory.get());
        concurrentRaisesEndAtTheMaximum(factory.get());
        statesComeBackInOrderWithZeroValuesForAbsentKeys(factory.get());
        evictDropsKeyAndPipedChildrenOnly(factory.get());
        lockIsSetIfAbsentWithTtlAndFencedRelease(factory.get());
        resultTtlIsExact(factory.get());
    }

    private static void check(boolean ok, String rule) {
        if (!ok) throw new AssertionError("SessionStateStore conformance: " + rule);
    }

    private static Instant in(long ms) { return Instant.now().plusMillis(ms); }

    private static void revokeNeverShortens(SessionStateStore s) throws Exception {
        s.revokeSession("r", in(2000));
        s.revokeSession("r", in(100)); // shorter write must not shorten
        Thread.sleep(300);
        check(s.sessionStates(List.of("r")).get(0).revoked(), "RevokeSession shortened an entry");
    }

    private static void raiseNotBeforeIsMonotonicAndExtends(SessionStateStore s) throws Exception {
        Instant hi = Instant.ofEpochSecond(2_000_000), lo = Instant.ofEpochSecond(1_000_000);
        s.raiseNotBefore("n", hi, in(100));
        s.raiseNotBefore("n", lo, in(2000)); // lower nb must not lower; later until must extend
        Thread.sleep(300);
        SessionState st = s.sessionStates(List.of("n")).get(0);
        check(hi.equals(st.notBefore()), "RaiseNotBefore lowered the stored not-before: " + st.notBefore());
    }

    private static void concurrentRaisesEndAtTheMaximum(SessionStateStore s) throws Exception {
        ExecutorService ex = Executors.newFixedThreadPool(16);
        Random rnd = new Random(7);
        long max = 0;
        CountDownLatch done = new CountDownLatch(100);
        for (int i = 0; i < 100; i++) {
            long nb = 1_000_000 + rnd.nextInt(1_000_000);
            max = Math.max(max, nb);
            ex.submit(() -> {
                try { s.raiseNotBefore("c", Instant.ofEpochSecond(nb), in(5000)); } finally { done.countDown(); }
            });
        }
        done.await();
        ex.shutdown();
        check(Instant.ofEpochSecond(max).equals(s.sessionStates(List.of("c")).get(0).notBefore()),
                "concurrent RaiseNotBefore writers did not end at the maximum");
    }

    private static void statesComeBackInOrderWithZeroValuesForAbsentKeys(SessionStateStore s) throws Exception {
        s.revokeSession("a", in(5000));
        s.revokeSession("exp", in(100));
        Thread.sleep(250);
        List<SessionState> st = s.sessionStates(List.of("missing", "a", "exp"));
        check(st.size() == 3, "SessionStates returned a different number of states than keys");
        check(!st.get(0).revoked() && st.get(0).notBefore() == null, "absent key was not the zero value");
        check(st.get(1).revoked(), "live key out of order or lost");
        check(!st.get(2).revoked(), "expired key still reported");
    }

    private static void evictDropsKeyAndPipedChildrenOnly(SessionStateStore s) {
        for (String k : new String[]{"k", "k|sub", "k2"}) s.raiseNotBefore(k, Instant.ofEpochSecond(5), in(5000));
        s.evict("k");
        List<SessionState> st = s.sessionStates(List.of("k", "k|sub", "k2"));
        check(st.get(0).notBefore() == null && st.get(1).notBefore() == null, "Evict kept k or k|*");
        check(st.get(2).notBefore() != null, "Evict dropped k2, which only shares a string prefix");
    }

    private static void lockIsSetIfAbsentWithTtlAndFencedRelease(SessionStateStore s) throws Exception {
        SessionStateStore.RefreshLock a = s.acquireRefreshLock("l", Duration.ofMillis(250));
        check(a.acquired(), "first AcquireRefreshLock was refused");
        check(!s.acquireRefreshLock("l", Duration.ofMillis(250)).acquired(), "lock was not set-if-absent");
        Thread.sleep(400); // TTL lapses; another holder takes it
        SessionStateStore.RefreshLock b = s.acquireRefreshLock("l", Duration.ofSeconds(5));
        check(b.acquired(), "lock was not re-acquirable after its TTL");
        a.release().run(); // the old holder's release must NOT free b's lock
        check(!s.acquireRefreshLock("l", Duration.ofSeconds(5)).acquired(), "release was not fenced");
        b.release().run();
        check(s.acquireRefreshLock("l", Duration.ofSeconds(5)).acquired(), "owner's release did not free the lock");
    }

    private static void resultTtlIsExact(SessionStateStore s) throws Exception {
        s.putRefreshResult("o", new byte[]{1, 2, 3}, Duration.ofMillis(300));
        Optional<byte[]> got = s.getRefreshResult("o");
        check(got.isPresent() && got.get().length == 3, "PutRefreshResult not readable inside its TTL");
        Thread.sleep(150);
        check(s.getRefreshResult("o").isPresent(), "result vanished before its TTL");
        Thread.sleep(300);
        check(s.getRefreshResult("o").isEmpty(), "result outlived its TTL");
    }
}
