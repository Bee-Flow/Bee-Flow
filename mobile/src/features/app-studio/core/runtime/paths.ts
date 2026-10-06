/**
 * Path walking and stable hashing for bindings. Part of the port of agent-hub
 * AppStudio/runtime/resolveBinding.js (resolveBinding.lockstep.test.ts).
 */

import { getRelativePath, parsePath } from '@/shared/expr';

/**
 * Does `path` read as a path RELATIVE to a value under the shared grammar?
 * The same normalisation getRelativePath applies (`$.a`, `[0].x`, `a.b`).
 */
function isRelativePath(path: string): boolean {
    let p = path.trim();
    if (p === '' || p === '$') return true;
    if (p.startsWith('$.')) p = p.slice(2);
    else if (p.startsWith('$[')) p = p.slice(1);
    return parsePath(p.startsWith('[') ? `$${p}` : `$.${p}`) !== null;
}

/**
 * Safe path walk with the ONE path grammar the automation runtime, the server
 * validator and the web app use (shared/expr/path.mjs): 'rows.0.title',
 * 'rows[0].title', 'data["a-b"]', 'rows[*].title', 'headers[name="Subject"].value',
 * JSON text read as the object it encodes. A string that is not a path at all
 * is read as ONE key (a column called "Full name"). Never throws.
 */
export function walkPath(value: unknown, path: unknown): unknown {
    if (path == null || path === '') return value;
    if (typeof path !== 'string') return undefined;
    if (isRelativePath(path)) return getRelativePath(value, path);
    return value != null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, path)
        ? (value as Record<string, unknown>)[path]
        : undefined;
}
/** Deterministic JSON with sorted keys: the hash half of a data cache key. */
export function stableStringify(value: unknown): string {
    if (value == null) return 'null';
    if (typeof value !== 'object') return JSON.stringify(value) as string;
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
