/**
 * Fixed-capacity O(1) ring buffer with a monotonic add-cursor — the bus's replay
 * window. Ported from gstack `browse/src/buffers.ts` CircularBuffer (head/size +
 * a never-resetting `totalAdded`; push at `(head+size)%cap`; evict-oldest on
 * overflow) into opensquid's namespace. `since(cursor)` returns the entries after
 * a 1-based add-ordinal and a `gap` flag when the cursor fell out of the window.
 *
 * Spec: loop/docs/tasks/T-fsm-actor-runtime.md §BUS.1. Source: gstack buffers.ts.
 */
export class CircularBuffer<T> {
  private readonly cap: number;
  private readonly buf: (T | undefined)[];
  private head = 0;
  private _size = 0;
  private _totalAdded = 0; // monotonic; never resets — the replay cursor base

  constructor(capacity: number) {
    this.cap = Math.max(1, capacity);
    this.buf = new Array<T | undefined>(this.cap);
  }

  get totalAdded(): number {
    return this._totalAdded;
  }
  get size(): number {
    return this._size;
  }

  push(entry: T): void {
    const index = (this.head + this._size) % this.cap;
    this.buf[index] = entry;
    if (this._size < this.cap) this._size += 1;
    else this.head = (this.head + 1) % this.cap; // full → evict the oldest
    this._totalAdded += 1;
  }

  /** Entries whose 1-based add-ordinal is `> cursor`. `gap` ⇒ the cursor fell out of the window. */
  since(cursor: number): { events: T[]; gap: boolean } {
    if (this._size === 0) return { events: [], gap: false };
    const oldest = this._totalAdded - this._size + 1; // ordinal of the oldest retained entry
    const gap = cursor < oldest - 1; // missed entries below the window
    const start = Math.max(cursor + 1, oldest);
    const events: T[] = [];
    for (let k = start; k <= this._totalAdded; k++) {
      events.push(this.buf[(this.head + (k - oldest)) % this.cap] as T);
    }
    return { events, gap };
  }
}
