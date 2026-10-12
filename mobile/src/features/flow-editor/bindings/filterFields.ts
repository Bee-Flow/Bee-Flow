/**
 * Variable-tree search, shared by the picker sheet and the node editor's input
 * pane so "search" means the same in both. A node survives when it or any
 * descendant matches; the surviving subtree is a copy. Port of agent-hub
 * `Builder/mapping/filterFields.js`; pinned by mapping.lockstep.test.ts.
 */

import type { VariableField, VariableGroup } from './types';

/** Filter a `[{key, path, sample, children?}]` tree against a query. */
export function filterFields(fields: VariableField[] | null | undefined, q: unknown): VariableField[] {
    const needle = String(q || '').toLowerCase();
    if (!needle) return fields || [];
    const out: VariableField[] = [];
    for (const f of fields || []) {
        // `label` is the name a person reads for an internal key (a Condition
        // output "Otherwise" for `matchesByCase.default`), so it is searchable.
        const matchesSelf = f.key?.toLowerCase().includes(needle) || f.path?.toLowerCase().includes(needle)
            || (typeof f.label === 'string' && f.label.toLowerCase().includes(needle));
        const subs = Array.isArray(f.children) ? filterFields(f.children, needle) : [];
        if (matchesSelf) out.push(subs.length > 0 ? { ...f, children: subs } : f);
        else if (subs.length > 0) out.push({ ...f, children: subs });
    }
    return out;
}

/** A group whose LABEL matches is kept whole; otherwise only its matching fields. */
export function filterGroups(groups: VariableGroup[] | null | undefined, q: unknown): VariableGroup[] {
    const needle = String(q || '').trim().toLowerCase();
    if (!needle) return groups || [];
    const out: VariableGroup[] = [];
    for (const g of groups || []) {
        if (g?.label?.toLowerCase().includes(needle)) {
            out.push(g);
            continue;
        }
        const fields = filterFields(g?.fields || [], needle);
        if (fields.length > 0) out.push({ ...g, fields });
    }
    return out;
}
