package dev.realmid.sdk.session;

import java.time.Duration;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Runs a blocking call on a daemon thread DETACHED from the calling (request)
 * thread and bounded by a deadline: the Java shape of Go's
 * {@code context.WithoutCancel} + {@code WithTimeout} (SPEC §6.7.2, go 0.63.1).
 *
 * <p>A client that hangs up interrupts its request thread. A store call made on
 * that thread by a driver that honours interruption (JDBC, Jedis, Lettuce)
 * fails, and a revocation read that fails is read as "store down": the
 * fail-open branch would let a revoked session through. Here the caller waits
 * <i>uninterruptibly</i> for the deadline and its interrupt status is restored
 * afterwards, so the work is never abandoned half-done and the caller still
 * learns it was cancelled.
 */
public final class Detached {

    private static final ExecutorService POOL = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "realmid-detached");
        t.setDaemon(true);
        return t;
    });

    private Detached() {}

    /**
     * @throws TimeoutException the bound passed; the task is cancelled
     * @throws RuntimeException the task's own unchecked failure, unchanged
     */
    public static <T> T call(Callable<T> task, Duration bound) throws TimeoutException {
        Future<T> f = POOL.submit(task);
        boolean interrupted = Thread.interrupted(); // a set flag would abort the wait below at once
        long deadline = System.nanoTime() + bound.toNanos();
        try {
            while (true) {
                long left = deadline - System.nanoTime();
                if (left <= 0) {
                    f.cancel(true);
                    throw new TimeoutException("detached call exceeded " + bound);
                }
                try {
                    return f.get(left, TimeUnit.NANOSECONDS);
                } catch (InterruptedException e) {
                    interrupted = true;
                } catch (ExecutionException e) {
                    Throwable c = e.getCause() == null ? e : e.getCause();
                    if (c instanceof RuntimeException r) throw r;
                    if (c instanceof Error err) throw err;
                    throw new IllegalStateException(c);
                }
            }
        } finally {
            if (interrupted) Thread.currentThread().interrupt();
        }
    }

    /** {@link #call} for a task with no result. */
    public static void run(Runnable task, Duration bound) throws TimeoutException {
        call(() -> { task.run(); return null; }, bound);
    }
}
