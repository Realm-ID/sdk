package dev.realmid.sdk.session;

import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.RealmException;

import java.time.Duration;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;

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
 *
 * <p>Only I/O (the issuer HTTP call, session-store calls) is ever detached. A partner's hook
 * ({@code ProductRolesHandler}, {@code ScopesHandler}, {@code IdentityResolvedHandler}) always
 * runs on the CALLING thread, so a thread-local, MDC or request-scoped bean it reads is intact
 * (Go parity: {@code WithoutCancel} keeps context values). {@link #bounded} gives such a block
 * one shared deadline and shields it from the caller's interrupt.
 *
 * <p>The pool is bounded ({@link #DEFAULT_MAX_THREADS}, {@link #setMaxThreads}): a store hung with
 * no socket timeout strands one thread per call, so once the pool is full a call is REFUSED at
 * once and behaves exactly as a timeout does ({@link TimeoutException}).
 *
 * <p>Internal to the SDK; no stability promise.
 */
public final class Detached {

    public static final int DEFAULT_MAX_THREADS = 256;

    private static final AtomicInteger SEQ = new AtomicInteger();

    private static final ThreadPoolExecutor POOL = new ThreadPoolExecutor(
            0, DEFAULT_MAX_THREADS, 30, TimeUnit.SECONDS, new SynchronousQueue<>(), r -> {
                Thread t = new Thread(r, "realmid-detached-" + SEQ.incrementAndGet());
                t.setDaemon(true);
                return t;
            });

    private Detached() {}

    /** The pool's current ceiling. */
    public static int maxThreads() {
        return POOL.getMaximumPoolSize();
    }

    /** Sets the pool ceiling (process-wide; the last {@code Realm} built wins). Must be at least 1. */
    public static void setMaxThreads(int n) {
        if (n < 1) throw new IllegalArgumentException("realmid: maxDetachedThreads must be >= 1");
        POOL.setMaximumPoolSize(n);
    }

    /**
     * @throws TimeoutException the bound passed (the task is cancelled), or the pool is full
     * @throws RuntimeException the task's own unchecked failure, unchanged
     */
    public static <T> T call(Callable<T> task, Duration bound) throws TimeoutException {
        Future<T> f;
        try {
            f = POOL.submit(task);
        } catch (RejectedExecutionException e) {
            throw new TimeoutException("detached pool saturated (" + POOL.getMaximumPoolSize() + " threads)");
        }
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

    // ---- a bounded block of caller-thread work whose I/O is detached ----

    private static final ThreadLocal<long[]> DEADLINE = new ThreadLocal<>();

    /**
     * Runs {@code body} ON THE CALLING THREAD (so partner hooks see their thread-locals) with one
     * shared deadline for every {@link #io} call inside it. The caller's interrupt status is
     * cleared for the duration, so neither a hook nor the detached I/O is aborted by a hang-up,
     * and restored afterwards. A hook itself cannot be cancelled: the deadline is checked before
     * each I/O call.
     */
    public static <T> T bounded(Duration bound, Supplier<T> body) {
        long[] prev = DEADLINE.get();
        boolean interrupted = Thread.interrupted();
        DEADLINE.set(new long[]{System.nanoTime() + bound.toNanos()});
        try {
            return body.get();
        } finally {
            if (prev == null) DEADLINE.remove(); else DEADLINE.set(prev);
            if (interrupted) Thread.currentThread().interrupt();
        }
    }

    /**
     * An issuer HTTP call: direct outside {@link #bounded}, otherwise detached from the caller
     * and bounded by what is left of the block's deadline.
     *
     * @throws RealmException {@code server_error} 504 "timed out" when the deadline passed or the pool is full
     */
    public static <T> T io(Callable<T> call) {
        long[] d = DEADLINE.get();
        if (d == null) {
            try {
                return call.call();
            } catch (RuntimeException e) {
                throw e;
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        }
        long left = d[0] - System.nanoTime();
        if (left <= 0) throw new RealmException(ErrorCode.SERVER_ERROR, "timed out", 504, null);
        try {
            return call(call, Duration.ofNanos(left));
        } catch (TimeoutException e) {
            throw new RealmException(ErrorCode.SERVER_ERROR, "timed out", 504, null);
        }
    }
}
