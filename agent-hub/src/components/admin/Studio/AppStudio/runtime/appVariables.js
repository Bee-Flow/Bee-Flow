/**
 * The variable vocabulary for the editor runtime.
 *
 * The vocabulary, ceilings and default coercion live in
 * server/shared/appDefinition/variables.mjs (one implementation for both
 * runtimes); @shared/appDefinition is the generated copy (npm run gen:shared).
 * A local module, not a fetch: the runtime seeds `vars` at mount, long before
 * any catalog request could land. This file adds the editor-only helpers.
 */

import { seedVariableDefaults } from '@shared/appDefinition/variables.mjs';

export {
    VARIABLE_TYPES,
    VARIABLE_TYPE_DEFAULTS,
    VARIABLE_NAME_RE,
    RESERVED_VARIABLE_NAMES,
    MAX_VARIABLES,
    MAX_VARIABLE_DEFAULT_BYTES,
    MAX_VARIABLE_NAME_LEN,
    MAX_VARIABLE_LABEL_LEN,
    MAX_VARIABLE_DESCRIPTION_LEN,
    coerceVariableDefault,
    seedVariableDefaults,
} from '@shared/appDefinition/variables.mjs';

/** Declared names, in declaration order. */
export function listVariableNames(variables) {
    return (Array.isArray(variables) ? variables : [])
        .map((v) => (v && typeof v.name === 'string' ? v.name : null))
        .filter(Boolean);
}

function sameValue(a, b) {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

/**
 * Fold a change in the DECLARATIONS into the live `vars` bag — merging, never
 * resetting.
 *
 * The editor re-renders this on every inspector keystroke, so a reset would
 * wipe a filter the author is looking at while they type. The rules:
 *
 *   added        → seed it with its default.
 *   default changed → adopt the new one ONLY if the live value is still the old
 *                  default, i.e. nothing has written it yet. A value an action
 *                  or a filter bar produced is real state and outranks an
 *                  editor-side edit to the declaration.
 *   removed      → drop it only if it still holds its old default. Undeclared
 *                  names stay perfectly legal (set_variable can write anything),
 *                  so discarding a live value would be a behaviour change rather
 *                  than a cleanup.
 *
 * Returns `prev` BY REFERENCE when nothing changed, so setVars bails out of the
 * re-render instead of scheduling one per keystroke.
 */
export function reconcileVariableDefaults(prev, prevDecls, nextDecls) {
    const before = seedVariableDefaults(prevDecls);
    const after = seedVariableDefaults(nextDecls);
    const current = prev && typeof prev === 'object' ? prev : {};

    let changed = false;
    const out = { ...current };

    for (const [name, value] of Object.entries(after)) {
        if (!(name in current)) { out[name] = value; changed = true; continue; }
        const wasUntouched = name in before && sameValue(current[name], before[name]);
        if (wasUntouched && !sameValue(current[name], value)) { out[name] = value; changed = true; }
    }

    for (const name of Object.keys(before)) {
        if (name in after) continue;
        if (!(name in current)) continue;
        if (!sameValue(current[name], before[name])) continue;   // written since — keep it
        delete out[name];
        changed = true;
    }

    return changed ? out : prev;
}
