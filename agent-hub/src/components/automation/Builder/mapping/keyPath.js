/**
 * keyPath — turning a raw object key into a path segment, for the surfaces
 * that build a path out of a key they did not write themselves (the JSON tree
 * picker, the mismatch box's "pick a field inside it", the template remedies).
 *
 * Object keys in real payloads are not identifiers. A webhook body carries
 * `content-type` and `x-request-id`; a JSON:API document carries `first-name`;
 * a spreadsheet import carries `Order date` or `Amount [EUR]`. The rule lives
 * in ONE place, the runtime's own grammar (shared/expr/path.mjs): `.key` for
 * an identifier, `[3]` for an index, `["…"]` with JSON escapes for anything
 * else. Since that grammar reads escapes, every key has a path, `x]y` and a
 * key with both quote kinds included; this file only gives it the name its
 * callers already use.
 */
import { appendKey, getRelativePath } from '@shared/expr/path.mjs';

export const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Append `key` to `prefix` the way the runtime reads it back. An empty prefix
 * yields a ROOT segment, so a bare identifier stays bare (`content-type` at
 * the root becomes `["content-type"]`, which is what the relative-path
 * dialect wants).
 */
export function joinKeyPath(prefix, key) {
    return appendKey(prefix, String(key));
}

// A sentinel that cannot be confused with any real payload value: the probe
// passes only when the built path resolves to this exact object.
const PROBE = {};

/**
 * Can a path be built from this key that the RUNTIME resolves back to it?
 * Probes the real resolver rather than restating its rules, so it can never
 * drift from them. With the current grammar the answer is yes for every key;
 * the probe stays as the guard should that ever change.
 */
export function keyPickable(key) {
    const k = String(key);
    if (IDENT_RE.test(k)) return true;
    try { return getRelativePath({ [k]: PROBE }, joinKeyPath('', k)) === PROBE; }
    catch { return false; }
}
