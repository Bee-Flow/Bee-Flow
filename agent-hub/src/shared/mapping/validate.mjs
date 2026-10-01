/**
 * Design-time checks on a binding: what a stored path will resolve to, said
 * before the run instead of discovered after it.
 *
 * Three kinds of issue, each with the canonical fix where there is one:
 *
 *   path_syntax             REF_RE rejects the path, so the run resolves it to
 *                           undefined ('items.0.name', 'body.content-type').
 *                           fix: the same path spelled the way the runtime
 *                           reads it ('items[0].name', 'body["content-type"]').
 *   trigger_without_output  'trigger.subject': the payload lives under
 *                           trigger.output, and trigger.<x> is either run
 *                           metadata or nothing. fix: 'trigger.output.subject'.
 *                           Also for a metadata key ('trigger.id') the
 *                           trigger's payload declares too (a spreadsheet's
 *                           id, a file's kind): that path reads the
 *                           metadata, which is rarely what was meant. Such
 *                           an issue carries `metadata: '<key>'`.
 *   unknown_field           the first field after output is not one the
 *                           source is known to produce. fix: the closest
 *                           known field, when one is close.
 *
 * All three are WARNINGS for the callers: a stored automation keeps saving and
 * running exactly as before. Which fields a source produces is not known
 * here; the caller passes `fieldsOf(source)`, which answers a list of names,
 * or null for "not known" (then nothing is reported).
 *
 * Isomorphic and dependency-free, like the rest of this directory. An `expr`
 * binding's paths come from the expression parser, which is injected as
 * `exprPaths` for the same reason resolve.mjs injects `evaluate`.
 */

import { REF_RE, tokenizePath } from './legacy.mjs';
import { formatPath, parseLegacyPath, repairLegacyPath } from './source.mjs';

/** The roots a binding can read in a run. */
export const RUNTIME_ROOTS = Object.freeze(['trigger', 'steps', 'vars', 'loop', 'secrets']);

/**
 * What a run's `trigger` holds besides nothing: the payload (`output`), the
 * request headers, and the metadata of which trigger fired and how
 * (server/core/automationRunner/triggerState.js). `trigger.<anything else>`
 * resolves to undefined.
 */
export const TRIGGER_RUN_KEYS = Object.freeze(['output', 'headers', 'id', 'kind', 'source', 'label', 'provider', 'event', 'firedAt', 'schedule']);

const TEMPLATE_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

/**
 * The paths inside the `{{ }}` placeholders of a template, trimmed, in order,
 * exactly as the runtime's interpolateTemplate reads them.
 * @param {unknown} text
 * @returns {string[]}
 */
export function templatePaths(text) {
    if (typeof text !== 'string') return [];
    const out = [];
    for (const m of text.matchAll(TEMPLATE_RE)) out.push(m[1].trim());
    return out;
}

function editDistance(a, b) {
    if (a === b) return 0;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 0; i < a.length; i++) {
        const cur = [i + 1];
        for (let j = 0; j < b.length; j++) {
            cur[j + 1] = Math.min(cur[j] + 1, prev[j + 1] + 1, prev[j] + (a[i] === b[j] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[b.length];
}

/**
 * The candidate a mistyped name most likely meant: the same name in another
 * case, else the one nearest by edit distance within a third of its length
 * (rounded down, so a name under three characters only matches by case).
 * Null when nothing is close, or when two candidates are equally close.
 * @param {string} name
 * @param {string[]} candidates
 */
export function closestName(name, candidates) {
    if (typeof name !== 'string' || !Array.isArray(candidates)) return null;
    const lower = name.toLowerCase();
    const sameCase = candidates.filter(c => typeof c === 'string' && c.toLowerCase() === lower);
    if (sameCase.length === 1) return sameCase[0];
    // A third of the name: 'subjet' may mean 'subject', 'y' does not mean 'x'.
    const limit = Math.floor(name.length / 3);
    let best = null;
    let bestDistance = Infinity;
    let tie = false;
    for (const c of candidates) {
        if (typeof c !== 'string') continue;
        const d = editDistance(lower, c.toLowerCase());
        if (d < bestDistance) { best = c; bestDistance = d; tie = false; }
        else if (d === bestDistance) tie = true;
    }
    return best !== null && bestDistance <= limit && !tie ? best : null;
}

/**
 * Does the trigger's payload declare `key`? Only asked for a run metadata key
 * (TRIGGER_RUN_KEYS): 'id' on a spreadsheet trigger, 'kind' on a Nextcloud
 * file trigger, 'source' on an approval. `output` is never the payload's.
 */
function triggerDeclares(key, fieldsOf) {
    if (key === 'output' || typeof fieldsOf !== 'function') return false;
    const known = fieldsOf({ root: 'trigger', path: [] });
    return Array.isArray(known) && known.includes(key);
}

/**
 * The issues of one ref path. Each fix is the whole path with every issue
 * before it fixed too, so applying the last one fixes them all.
 * @param {unknown} path
 * @param {{ fieldsOf?: (source: object) => string[] | null, syntax?: boolean }} [ctx]
 *   `syntax: false` skips path_syntax, for paths that come out of a parser.
 * @returns {Array<{ code: string, path: string, fix: string|null, field?: string, known?: string[] }>}
 */
export function checkRefPath(path, { fieldsOf, syntax = true } = {}) {
    const issues = [];
    if (typeof path !== 'string' || !path.trim()) return issues;
    let p = path;
    if (!REF_RE.test(p)) {
        if (!syntax) return issues;
        const { path: repaired, rest } = repairLegacyPath(p);
        const fix = repaired && !rest && repaired !== p && REF_RE.test(repaired) ? repaired : null;
        issues.push({ code: 'path_syntax', path, fix });
        if (!fix) return issues;
        p = fix;
    }
    const tokens = tokenizePath(p);
    if (!tokens || !tokens.length) return issues;
    const second = tokens[1];
    if (tokens[0].key === 'trigger' && second && second.type === 'prop' && typeof second.key === 'string') {
        const metadata = TRIGGER_RUN_KEYS.includes(second.key);
        if (!metadata || triggerDeclares(second.key, fieldsOf)) {
            p = `trigger.output${p.slice('trigger'.length)}`;
            issues.push({ code: 'trigger_without_output', path, fix: p, ...(metadata ? { metadata: second.key } : {}) });
        }
    }
    if (typeof fieldsOf === 'function') {
        const source = parseLegacyPath(p);
        const first = source ? source.path[0] : undefined;
        if (typeof first === 'string') {
            const known = fieldsOf(source);
            if (Array.isArray(known) && known.length && !known.includes(first)) {
                const near = closestName(first, known);
                issues.push({
                    code: 'unknown_field', path, field: first, known: [...known],
                    fix: near ? formatPath({ ...source, path: [near, ...source.path.slice(1)] }) : null,
                });
            }
        }
    }
    return issues;
}

/**
 * The issues of one legacy binding: a ref's path, every placeholder of a
 * template, and every path an expr reads (through the injected
 * `exprPaths(src) → string[]`; an expr's own syntax is the parser's to
 * report, so it gets no path_syntax here). Literals have none. Each issue
 * carries the binding `kind` it came from.
 * @param {unknown} binding
 * @param {{ fieldsOf?: (source: object) => string[] | null, exprPaths?: (src: string) => string[] }} [ctx]
 */
export function validateBinding(binding, { fieldsOf, exprPaths } = {}) {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return [];
    const tag = (kind, issues) => issues.map(i => ({ ...i, kind }));
    if (binding.kind === 'ref') return tag('ref', checkRefPath(binding.path, { fieldsOf }));
    if (binding.kind === 'template') {
        return tag('template', templatePaths(binding.value).flatMap(p => checkRefPath(p, { fieldsOf })));
    }
    if (binding.kind === 'expr' && typeof binding.value === 'string' && typeof exprPaths === 'function') {
        let paths = [];
        try { paths = exprPaths(binding.value) || []; } catch { paths = []; }
        return tag('expr', paths.flatMap(p => checkRefPath(p, { fieldsOf, syntax: false })));
    }
    return [];
}
