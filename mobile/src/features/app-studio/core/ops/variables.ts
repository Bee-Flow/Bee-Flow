/**
 * Variables (definition.variables). EMIT-WHEN-PRESENT: an app that declares
 * none round-trips to exactly the bytes it had before the key existed.
 * Port of the "Variables" block of definitionOps.js.
 */

import { sameValue } from '../sameValue';
import type { AppDefinition, AppVariable } from '../types';

/** The definition's declared variables, or []. */
export function listVariables(def: AppDefinition | null | undefined): AppVariable[] {
    return Array.isArray(def?.variables) ? def.variables : [];
}

/**
 * Add or patch one variable, matched by `name`. A new name is appended; an
 * existing one is shallow-merged in place. Same def when nothing changes.
 */
export function setVariable<D extends AppDefinition>(def: D, variable: Partial<AppVariable> | null | undefined): D {
    if (!variable || typeof variable.name !== 'string' || !variable.name) return def;
    const current = listVariables(def);
    const at = current.findIndex((v) => v?.name === variable.name);
    const existing = current[at];
    if (existing && Object.keys(variable).every((k) => sameValue(existing[k], variable[k]))) return def;
    const next =
        at === -1
            ? [...current, variable as AppVariable]
            : current.map((v, i) => (i === at ? { ...v, ...variable } : v));
    return { ...def, variables: next };
}

/**
 * Rename a variable in place, keeping its position. Formulas that read it are
 * NOT rewritten; the manager only offers a rename while a variable is unused.
 */
export function renameVariable<D extends AppDefinition>(def: D, from: string, to: unknown): D {
    if (typeof to !== 'string' || !to || from === to) return def;
    const current = listVariables(def);
    if (!current.some((v) => v?.name === from)) return def;
    if (current.some((v) => v?.name === to)) return def;
    return { ...def, variables: current.map((v) => (v?.name === from ? { ...v, name: to } : v)) };
}

/** Remove a variable. Removing the LAST one deletes the key entirely. */
export function removeVariable<D extends AppDefinition>(def: D, name: string): D {
    const current = listVariables(def);
    const next = current.filter((v) => v?.name !== name);
    if (next.length === current.length) return def;
    if (next.length === 0) {
        const { variables: _dropped, ...rest } = def;
        return rest as D;
    }
    return { ...def, variables: next };
}
