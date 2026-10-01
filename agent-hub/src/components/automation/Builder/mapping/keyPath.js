/**
 * keyPath — the ONE rule for turning a raw object key into a path segment.
 *
 * Object keys in real payloads are not identifiers. A webhook body carries
 * `content-type` and `x-request-id`; a JSON:API document carries `first-name`;
 * a spreadsheet import carries `Order date`. Written as `body.content-type` a
 * path is not a path at all: the server's binder rejects it outright (its
 * REF_RE matches identifiers and bracket-quoted keys, nothing else) and the
 * expression engine reads the hyphen as a SUBTRACTION. The builder's preview
 * walker used to be laxer (it previewed saved paths verbatim), so the two
 * disagreed in the worst possible direction: a preview that showed the real
 * value under a binding the run resolved to undefined, with no warning at
 * either end. It is the runtime's own walker now (shared/mapping), so an
 * unquoted key previews as empty; quoting is what makes it a value.
 *
 * Hence one rule for every surface that builds a path out of a key it did not
 * itself write: source.mjs `formatSegment` in the shared mapping core, the
 * same writer the upstream describers, the output table and the AI builder
 * use. This file only adapts it to the call shapes the builder's components
 * have:
 *   - identifier-safe key  → `.key` (bare at the root of a relative path)
 *   - anything else        → `["key"]`, or `['key']` when the key itself
 *                            contains a double quote
 *   - a key holding `]`, or both quote styles, cannot be written at all:
 *     `keyPickable` says so, and such a key must not be offered.
 */
import { formatSegment, lastSegment, repairLegacyPath } from '@shared/mapping/index.mjs';

export const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Append `key` to `prefix` with the one quoting rule. An empty prefix yields
 * a ROOT segment, so a bare identifier stays bare (`content-type` at the root
 * becomes `["content-type"]`, which is what the relative-path dialect wants).
 * A key the grammar cannot write is returned quoted anyway (as it always
 * was); callers check keyPickable first.
 */
export function joinKeyPath(prefix, key) {
    const k = String(key);
    if (IDENT_RE.test(k)) return prefix ? `${prefix}.${k}` : k;
    // An unwritable key keeps the spelling it always had (keyPickable refuses it).
    return `${prefix}${formatSegment(k) ?? (k.includes('"') ? `['${k}']` : `["${k}"]`)}`;
}

/** Can a path be built from this key that the RUNTIME resolves back to it? */
export function keyPickable(key) {
    return formatSegment(String(key)) !== null;
}

/**
 * The column a dropped or clicked path names: its last object key, with list
 * markers and indexes dropped and quoting undone.
 *   `steps.x.output.rows[*]["first name"]` → `first name`
 *   `steps.x.output["content-type"]`        → `content-type`
 * A hand-typed path the grammar rejects is read the way its writer meant it
 * (repairLegacyPath). '' when there is no key.
 */
export function columnKeyOf(path) {
    const repaired = repairLegacyPath(String(path ?? '')).path || '';
    const key = lastSegment(repaired.replace(/(?:\[(?:\*|\d+)\])+$/, ''));
    return typeof key === 'string' ? key : '';
}
