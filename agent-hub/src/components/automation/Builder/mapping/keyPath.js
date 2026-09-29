/**
 * keyPath — the ONE rule for turning a raw object key into a path segment.
 *
 * Object keys in real payloads are not identifiers. A webhook body carries
 * `content-type` and `x-request-id`; a JSON:API document carries `first-name`;
 * a spreadsheet import carries `Order date`. Written as `body.content-type` a
 * path is not a path at all: the server's binder rejects it outright (its
 * REF_RE matches identifiers and bracket-quoted keys, nothing else) and the
 * expression engine reads the hyphen as a SUBTRACTION. The builder's own
 * walkPath is deliberately laxer — it previews saved paths verbatim — so the
 * two disagree in the worst possible direction: a preview that shows the real
 * value under a binding the run resolves to undefined, with no warning at
 * either end.
 *
 * Hence one shared rule, in one file, for every surface that builds a path out
 * of a key it did not itself write (the JSON tree picker, the mismatch box's
 * "pick a field inside it"):
 *   - identifier-safe key  → `.key`
 *   - anything else        → `["key"]`, or `['key']` when the key itself
 *                            contains a double quote (the tokenizer accepts
 *                            both quote styles but supports no escapes)
 *
 * And one shared refusal: some keys — containing `]`, or both quote styles at
 * once — cannot be expressed at all. `keyPickable` answers that by PROBING the
 * real resolver rather than restating its parsing rules, so it can never drift
 * from them. A key it rejects must not be offered: an unusable button that
 * writes a binding is worse than a key that is simply absent.
 */
import { walkRelativePath } from '../../../../utils/bindingHelpers';

export const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Append `key` to `prefix` using the server tokenizer's quoting rules.
 * An empty prefix yields a ROOT segment, so a bare identifier stays bare
 * (`content-type` at the root becomes `["content-type"]`, which is what the
 * relative-path dialect wants).
 */
export function joinKeyPath(prefix, key) {
    const k = String(key);
    const seg = IDENT_RE.test(k)
        ? (prefix ? `.${k}` : k)
        : (k.includes('"') ? `['${k}']` : `["${k}"]`);
    return `${prefix}${seg}`;
}

// A sentinel that cannot be confused with any real payload value: the probe
// passes only when the built path resolves to this exact object.
const PROBE = {};

/** Can a path be built from this key that the RUNTIME resolves back to it? */
export function keyPickable(key) {
    const k = String(key);
    if (IDENT_RE.test(k)) return true;
    try { return walkRelativePath(joinKeyPath('', k), { [k]: PROBE }) === PROBE; }
    catch { return false; }
}
