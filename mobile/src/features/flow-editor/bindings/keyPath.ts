/**
 * Turning a raw object key into a path segment, for the surfaces that build a
 * path out of a key they did not write: the runtime grammar's own writer
 * (`@/shared/expr` appendKey) — `.key` for an identifier, `[3]` for an index,
 * `["…"]` with JSON escapes for anything else. The grammar reads escapes, so
 * every key has a path; `keyPickable` PROBES the real resolver to keep that
 * true. Port of agent-hub `Builder/mapping/keyPath.js`; pinned by
 * mapping.lockstep.test.ts.
 */

import { appendKey, getRelativePath } from '@/shared/expr';

export const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Append `key` to `prefix`; an empty prefix yields a ROOT segment. */
export function joinKeyPath(prefix: string, key: unknown): string {
    return appendKey(prefix, String(key));
}

// A sentinel no payload value can be confused with.
const PROBE = {};

/** Can a path be built from this key that the RUNTIME resolves back to it? */
export function keyPickable(key: unknown): boolean {
    const k = String(key);
    if (IDENT_RE.test(k)) return true;
    try {
        return getRelativePath({ [k]: PROBE }, joinKeyPath('', k)) === PROBE;
    } catch {
        return false;
    }
}
