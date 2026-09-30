/**
 * The ONE rule for turning a raw object key into a path segment: an
 * identifier-safe key is `.key`, anything else `["key"]` (or `['key']` when it
 * holds a double quote) — `body.content-type` is a subtraction to the engine
 * and a rejected path to the binder. `keyPickable` PROBES the real resolver for
 * keys that cannot be expressed at all. Port of agent-hub
 * `Builder/mapping/keyPath.js`; pinned by mapping.lockstep.test.ts.
 */

import { walkRelativePath } from './walkPath';

export const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Append `key` to `prefix`; an empty prefix yields a ROOT segment. */
export function joinKeyPath(prefix: string, key: unknown): string {
    const k = String(key);
    if (IDENT_RE.test(k)) return `${prefix}${prefix ? `.${k}` : k}`;
    return `${prefix}${k.includes('"') ? `['${k}']` : `["${k}"]`}`;
}

// A sentinel no payload value can be confused with.
const PROBE = {};

/** Can a path be built from this key that the RUNTIME resolves back to it? */
export function keyPickable(key: unknown): boolean {
    const k = String(key);
    if (IDENT_RE.test(k)) return true;
    try {
        return walkRelativePath(joinKeyPath('', k), { [k]: PROBE }) === PROBE;
    } catch {
        return false;
    }
}
