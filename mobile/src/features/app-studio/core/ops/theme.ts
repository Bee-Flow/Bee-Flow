/**
 * Theme, meta, design, nav and AI-browsing patches. Port of the "Theme / meta"
 * block of definitionOps.js.
 *
 * design, nav and aiBrowsing are OPTIONAL keys (emit-when-present): a patch
 * materialises the key and `null` removes it, which is the way back to the
 * byte-identical "not set" definition. updateAiBrowsing is the owner's switch
 * only; the AI builder's tool surface can never reach it.
 */

import type { AppDefinition } from '../types';
import { isNoopPatch } from './ids';

type Patch = Record<string, unknown>;
type ObjectKey = 'theme' | 'meta' | 'design' | 'nav' | 'aiBrowsing';

function mergeKey<D extends AppDefinition>(def: D, key: ObjectKey, patch: unknown): D {
    const current = (def[key] || {}) as Patch;
    if (!patch || typeof patch !== 'object' || isNoopPatch(current, patch as Patch)) return def;
    return { ...def, [key]: { ...current, ...(patch as Patch) } };
}

function mergeOptionalKey<D extends AppDefinition>(def: D, key: ObjectKey, patch: unknown): D {
    if (patch === null) {
        if (!(key in def)) return def;
        const rest: Patch = { ...def };
        delete rest[key];
        return rest as D;
    }
    return mergeKey(def, key, patch);
}

export function updateTheme<D extends AppDefinition>(def: D, patch: Patch | null | undefined): D {
    return mergeKey(def, 'theme', patch);
}

export function updateMeta<D extends AppDefinition>(def: D, patch: Patch | null | undefined): D {
    return mergeKey(def, 'meta', patch);
}

export function updateDesign<D extends AppDefinition>(def: D, patch: Patch | null | undefined): D {
    return mergeOptionalKey(def, 'design', patch);
}

export function updateAiBrowsing<D extends AppDefinition>(def: D, patch: Patch | null | undefined): D {
    return mergeOptionalKey(def, 'aiBrowsing', patch);
}

export function updateNav<D extends AppDefinition>(def: D, patch: Patch | null | undefined): D {
    return mergeOptionalKey(def, 'nav', patch);
}
