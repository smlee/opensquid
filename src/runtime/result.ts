/**
 * Result<T, E> utility type — pre-throw-free error pattern.
 *
 * The function library returns `Result<T, FunctionError>` so the evaluator
 * (Task 1.3) can short-circuit cleanly on `ok: false` without try/catch
 * sprinkled through the interpreter loop. Throws are reserved for programmer
 * errors at startup (e.g. duplicate registration); recoverable runtime
 * failures travel as `Err` values through the same return channel.
 *
 * Convention: a primitive that doesn't bind a value returns `ok(undefined)`.
 * The discriminant `ok: true | false` lets callers narrow without casts.
 *
 * Imported by: src/functions/registry.ts and every downstream primitive.
 */

export interface Ok<T> {
  ok: true;
  value: T;
}
export interface Err<E> {
  ok: false;
  error: E;
}
export type Result<T, E = Error> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });
