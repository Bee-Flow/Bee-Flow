/**
 * The path walkers of the flow editor's previews: the RUNTIME's own.
 * server/automation/bind.js resolves refs and `{{ }}` templates with
 * shared/mapping's legacy walker, and @/shared/mapping is the vendored copy of
 * the same file — so a preview on the phone shows exactly what the run will
 * get: `[*]` flatten, quoted keys, no walking of the prototype chain, and
 * undefined for a path the runtime rejects (`items.0.x`, `body.content-type`).
 * The port that lived here skipped that last check and showed the real value
 * under a binding that ran empty. Pinned by shared/mapping/corpus.test.ts and,
 * against the web, by bindingHelpers.lockstep.test.ts.
 */

/**
 * walkPath(path, root): `steps.s1.output.results[0].subject`,
 * `…results[*].output.field`, `obj["quoted key"]`. Undefined when the path is
 * malformed or any segment is missing — never throws.
 *
 * walkRelativePath(path, value): a path RELATIVE to a value (the parse_json
 * dialect: `[0].x`, `[*].sku`). `''`/`'$'`/nullish returns the whole value.
 */
export { walkPath, walkRelativePath } from '@/shared/mapping';

/**
 * A sample value for inline display: strings raw (truncated), numbers and
 * booleans as text, objects/arrays as `{a, b…}` / `[N items]`.
 */
export function previewValue(value: unknown, maxLen = 40): string {
    if (value == null) return '—';
    if (typeof value === 'string') {
        return value.length > maxLen ? value.slice(0, maxLen - 1) + '…' : value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return `[${value.length} item${value.length === 1 ? '' : 's'}]`;
    if (typeof value === 'object') {
        const keys = Object.keys(value);
        if (keys.length === 0) return '{}';
        return `{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '…' : ''}}`;
    }
    return String(value);
}
