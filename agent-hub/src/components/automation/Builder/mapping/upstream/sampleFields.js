/**
 * The sample → field vocabulary every describer in this folder shares.
 *
 * One sample object (what a node's output looks like) in, one list of
 * bindable `{ key, path, sample }` fields out — plus the path-segment
 * escaping that keeps those paths inside the RUNTIME's ref grammar, the
 * element-shape lookup collection steps resolve their `arrayRef` with, and
 * the declared-type → placeholder table the schema-driven describers use.
 */
import { walkPath } from '../../../../../utils/bindingHelpers';

/**
 * Append ONE object key to a ref path, quoting it when it isn't a bare JS
 * identifier.
 *
 * The builder used to concatenate `${base}.${key}` unconditionally. That is
 * fine for `results`, but a JSON key like "line-items" / "content-type" /
 * "2024 rows" produced `…output.line-items`, which the CLIENT walker then
 * previewed happily (it skipped the REF_RE check; it is the runtime's own walker
 * since) while the RUNTIME rejects it outright — server/automation/bind.js
 * walkPath bails on `!REF_RE.test(path)`, and REF_RE only accepts identifier segments after a
 * dot. Net effect: a Loop/Filter bound to such a list previewed perfectly at
 * design time and then failed every run with "arrayRef did not resolve to an
 * array". The bracket form `…output["line-items"]` IS accepted by REF_RE
 * (`\[(?:[0-9]+|\*|"[^"]*"|'[^']*')\]`) and by both tokenizers, so emit that.
 *
 * Keys containing a `"`, a backslash or a `]` stay unrepresentable in the
 * server's path grammar (REF_RE's `"[^"]*"` / tokenizePath's `indexOf(']')`) —
 * that is a pre-existing runtime limit, not something the builder can encode.
 */
export const seg = (k) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`);

/**
 * Translate a sample object into a flat-ish field list. Top-level keys
 * become leaves; nested objects become groups with their own fields one
 * level deep. Arrays are summarised as `[N items]` and not expanded
 * (their element shape is exposed via Loop's loop.<itemVar> instead).
 */
export function sampleToFields(sample, basePath) {
    if (sample == null || typeof sample !== 'object') return [];
    const out = [];
    for (const [k, v] of Object.entries(sample)) {
        const path = `${basePath}${seg(k)}`;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            // One level of nesting: surface child keys too so users can
            // bind e.g. `trigger.output.organizer.email` without typing.
            const children = Object.entries(v).map(([ck, cv]) => ({
                key: ck,
                path: `${path}${seg(ck)}`,
                sample: cv,
            }));
            out.push({ key: k, path, sample: v, children });
        } else {
            out.push({ key: k, path, sample: v });
        }
    }
    return out;
}

/**
 * Resolve an arrayRef path to the sample of ONE element of that array.
 * `sampleRoot` is either the accumulated design-time root (see
 * computeUpstreamGroups) or the NDV's previewSample (which overlays real
 * last-run / pinned outputs). Returns null when the path doesn't resolve
 * to a non-empty array.
 */
export function resolveElementSample(arrayRef, sampleRoot) {
    if (typeof arrayRef !== 'string' || !arrayRef.trim() || !sampleRoot) return null;
    const v = walkPath(arrayRef.trim(), sampleRoot);
    if (!Array.isArray(v) || v.length === 0) return null;
    return v[0] ?? null;
}

/**
 * Top-level field options of an array element — the ONLY level the server's
 * collection ops can address (engine.js reads `item?.[step.field]`, so
 * dotted paths silently fail there). Feeds FieldKeyCombobox.
 */
export function elementFieldOptions(elementSample) {
    if (!elementSample || typeof elementSample !== 'object' || Array.isArray(elementSample)) return [];
    return Object.entries(elementSample).map(([key, sample]) => ({ key, sample }));
}

/**
 * Every ARRAY-valued path reachable from the upstream groups — top-level
 * fields, one nesting level (children), plus arrays that only exist in the
 * real-run/pinned overlay (previewSample) and not in the schema sample.
 * Supersedes the top-level-only scans in LoopOverPicker and the old
 * CollectionArrayRefField. Returns [{ key, path, sample }].
 */
export function collectArrayPaths(groups, previewSample = null) {
    const out = [];
    const seen = new Set();
    const push = (key, path, sample) => {
        if (!path || seen.has(path)) return;
        seen.add(path);
        out.push({ key, path, sample });
    };
    for (const g of (groups || [])) {
        for (const f of (g.fields || [])) {
            if (Array.isArray(f.sample)) push(f.key, f.path, f.sample);
            for (const c of (f.children || [])) {
                if (Array.isArray(c.sample)) push(c.key, c.path, c.sample);
            }
        }
        // Real-run overlay: arrays present in actual output but absent from
        // the design-time sample (e.g. a tool with no curated outputSample).
        if (previewSample && g.basePath) {
            const actual = walkPath(g.basePath, previewSample);
            if (actual && typeof actual === 'object' && !Array.isArray(actual)) {
                for (const [k, v] of Object.entries(actual)) {
                    if (Array.isArray(v)) push(k, `${g.basePath}${seg(k)}`, v);
                }
            }
        }
    }
    return out;
}

export function samplePlaceholderFor(type) {
    switch (type) {
        case 'number': return 0;
        case 'boolean': return false;
        case 'object': return {};
        case 'array': return [];
        // App-trigger file inputs arrive expanded (appStudio/actionExecutor);
        // the nested keys make trigger.output.<name>.url bindable in the tree.
        case 'file': return { fileId: '<file-id>', name: 'document.pdf', mime: 'application/pdf', size: 12345, url: '<signed download url>' };
        default: return '<string>';
    }
}
