/**
 * Tiny synchronous observable used for `onAuthChange` and internal state
 * fan-out. No dependencies; safe in any JS runtime.
 */
export type Listener<T> = (value: T) => void;

export class Observable<T> {
  private listeners = new Set<Listener<T>>();

  subscribe(fn: Listener<T>): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(value: T): void {
    for (const fn of this.listeners) {
      try {
        fn(value);
      } catch {
        // listener errors must not break the emitter
      }
    }
  }

  size(): number {
    return this.listeners.size;
  }
}
