// Typed readers for a caught value (`catch (e)` is `unknown` in TypeScript).
//
// These replace the property reads the JavaScript code did on `e` directly
// (`e.message`, `e?.status`, `e?.body`, `e?.name === 'AbortError'`). Each helper
// does the same property read as the original for every value the original
// handled without throwing, and narrows the result to a type the caller can use.
//
// Shared differences, on purpose:
//   - The original `e.message` / `e.status` / `e.body` THROWS a TypeError when `e`
//     is null or undefined (for example `throw undefined`). `e?.x` does not. The
//     helpers never throw: null and undefined give `undefined`, like `e?.x`.
//   - A value of the wrong type is dropped to `undefined`: a truthy non-string
//     message (`{ message: 42 }`) gives `undefined` from `errorMessage` and the
//     fallback from `messageOf`; the original gave `42`. Callers passed
//     that on as text or compared it to a literal, where a non-string never won.

/** The value of property `key` on `e`, read the way `e?.[key]` would, or undefined. */
function readProp(e: unknown, key: string): unknown {
    if ((typeof e === 'object' && e !== null) || typeof e === 'function') {
        const value: unknown = Reflect.get(e, key);
        return value;
    }
    return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/**
 * Replaces `e.message` and `e?.message` when the result is used as text.
 * Same result for Error, ApiError and any object with a string `message`; an
 * empty string stays an empty string, so `errorMessage(e) || fallback` behaves
 * like `e?.message || fallback`. Difference: null/undefined give undefined
 * instead of a throw (`e.message`), and a non-string message gives undefined.
 */
export function errorMessage(e: unknown): string | undefined {
    const message = readProp(e, 'message');
    return typeof message === 'string' ? message : undefined;
}

/**
 * Replaces `e?.message || fallback` and `e.message || fallback`: the error's
 * message, or the fallback when there is none or it is empty.
 * Difference: null/undefined give the fallback instead of a throw (`e.message`).
 * The fallback is evaluated eagerly (a function argument), unlike `||`: never
 * pass one with side effects or a cost; use `errorMessage(e) || fallback`.
 */
export function messageOf(e: unknown, fallback: string): string {
    return errorMessage(e) || fallback;
}

/**
 * Replaces `String(e?.message || e)`: the message when it is non-empty, else
 * the value itself as text. Difference: a non-string truthy message (an object)
 * is not stringified; the value itself is used instead.
 */
export function describeError(e: unknown): string {
    return errorMessage(e) || String(e);
}

/**
 * Replaces `e.status` / `e?.status` in comparisons such as `e?.status === 404`.
 * Only a number comes back. Difference: a numeric string like '404' gives
 * undefined, where `e.status >= 500` would have coerced it; `=== 404` never
 * matched a string anyway. null/undefined give undefined instead of a throw.
 */
export function errorStatus(e: unknown): number | undefined {
    const status = readProp(e, 'status');
    return typeof status === 'number' ? status : undefined;
}

/**
 * Replaces `e.code` / `e?.code` in comparisons such as `e?.code === 'x'`
 * (the API error code the server sent, or a Node-style code). Only a string
 * comes back. Difference: a non-string code gives undefined, on purpose: a
 * DOMException has a NUMERIC `code` (20 for AbortError) that is not an API code;
 * null/undefined give undefined instead of a throw.
 */
export function errorCode(e: unknown): string | undefined {
    const code = readProp(e, 'code');
    return typeof code === 'string' ? code : undefined;
}

/**
 * Replaces `e.body` / `e?.body` (the parsed response body of an ApiError).
 * The value is untyped on purpose: narrow it at the use site (`Array.isArray`,
 * `typeof x === 'string'`, a type guard) before reading fields.
 * Difference: null/undefined give undefined instead of a throw.
 */
export function errorBody(e: unknown): unknown {
    return readProp(e, 'body');
}

/**
 * Replaces `e?.name || 'Error'` and other reads of `e.name` as text (logging).
 * Only a string comes back. Difference: null/undefined give undefined instead
 * of a throw (`e.name`); a non-string name gives undefined.
 */
export function errorName(e: unknown): string | undefined {
    const name = readProp(e, 'name');
    return typeof name === 'string' ? name : undefined;
}

/**
 * Replaces `e?.body` when fields of it are read: `e.body?.x` becomes
 * `errorBodyRecord(e)?.x` and `...(e.body || {})` becomes
 * `...(errorBodyRecord(e) ?? {})`. Returns the body when it is a non-null
 * object (arrays included), else undefined. Fields are `unknown`: narrow
 * them at the use site. Use `errorBody` when the body may be a string.
 * Difference: a string/number body gives undefined (`'abc'.x` was undefined
 * too, but `...('abc' || {})` spread the characters); null/undefined `e` give
 * undefined instead of a throw.
 */
export function errorBodyRecord(e: unknown): Record<string, unknown> | undefined {
    const body = readProp(e, 'body');
    return isObject(body) ? body : undefined;
}

/**
 * Replaces `e?.name === 'AbortError'` and `e.name === 'AbortError'`: true for
 * a DOMException from an aborted fetch or an Error whose name is AbortError.
 * Difference: null/undefined give false instead of a throw (`e.name`).
 * Does not look at `signal.aborted`; keep that check next to the call.
 */
export function isAbortError(e: unknown): boolean {
    return readProp(e, 'name') === 'AbortError';
}
