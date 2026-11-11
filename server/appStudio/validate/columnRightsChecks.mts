/**
 * App Studio validator — advice about column rights (`field.access` in the data model,
 * core/dataEngine/columnRights.mts). Never an error: the server enforces the rights whatever the
 * definition says. What the author cannot see from the definition is what a role-restricted
 * field does to a read or a step for the OTHER roles, so it is said here, once per reference:
 *
 *   binding.field_restricted   a filter, sort, search, group or aggregate names a field some role
 *                              may not read: for that role the whole read is refused. A `fields`
 *                              entry or an expansion's `pick` is only left out for that role.
 *   step.field_restricted      a step writes a field some role may not write: the step runs as
 *                              the viewer, so it is refused for that role.
 *
 * A data model without column rights builds no map, and nothing is looked at.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Finding = { code: string; severity: string; path: string; message: string; hint: string };
type Obj = Record<string, unknown>;
/** Per table (by id and by key): field key → the declared roles that may not read it, and those that may not write it. */
export type RestrictedFields = Map<string, Map<string, { read: string[]; write: string[] }>>;
type Ctx = { pushW: (f: Finding) => void; dataRestrictedFields?: RestrictedFields | null };

const rights = nodeRequire('../../core/dataEngine/columnRights.mts') as {
    hasColumnRights(table: unknown): boolean;
    hiddenFields(table: unknown, role: unknown): Set<string>;
    canWriteField(table: unknown, role: unknown, fieldKey: unknown): boolean;
};
const { PUBLIC_ROLE_KEY } = nodeRequire('../../core/dataEngine/dataModel/vocabulary') as { PUBLIC_ROLE_KEY: string };

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The roles a model declares, and the anonymous one. */
function rolesOf(model: Obj): string[] {
    const declared = (Array.isArray(model.roles) ? model.roles : [])
        .map((r) => (isObject(r) ? r['key'] : undefined))
        .filter((k): k is string => typeof k === 'string' && k !== '');
    return [...new Set([...declared, PUBLIC_ROLE_KEY])];
}

/** Null when the model has no table with column rights (the usual case). */
export function buildRestrictedFields(dataModel: unknown): RestrictedFields | null {
    if (!isObject(dataModel) || !Array.isArray(dataModel.tables)) return null;
    const roles = rolesOf(dataModel);
    const out: RestrictedFields = new Map();
    for (const table of dataModel.tables) {
        if (!isObject(table) || !rights.hasColumnRights(table)) continue;
        const fields = new Map<string, { read: string[]; write: string[] }>();
        const hiddenByRole = roles.map((role) => [role, rights.hiddenFields(table, role)] as const);
        for (const f of Array.isArray(table.fields) ? table.fields : []) {
            const fieldKey = isObject(f) ? f['key'] : undefined;
            if (typeof fieldKey !== 'string') continue;
            const read = hiddenByRole.filter(([, hidden]) => hidden.has(fieldKey)).map(([role]) => role);
            const write = roles.filter((role) => !rights.canWriteField(table, role, fieldKey));
            if (read.length || write.length) fields.set(fieldKey, { read, write });
        }
        for (const ref of [table.id, table['key']]) if (typeof ref === 'string' && ref) out.set(ref, fields);
    }
    return out.size ? out : null;
}

const named = (roles: string[]): string => roles.map((r) => `"${r}"`).join(', ');

/**
 * Called for every field reference that resolved (validate/refs.checkFieldRef).
 * `output`: the reference only says what to return (`fields`, an expansion's `pick`).
 */
export function warnRestrictedField(ctx: Ctx, tableId: string, fieldKey: string, path: string, label: string, o: { codePrefix: string; output?: boolean }): void {
    const entry = ctx.dataRestrictedFields ? ctx.dataRestrictedFields.get(tableId)?.get(fieldKey) : undefined;
    if (!entry) return;
    if (o.codePrefix === 'step') {
        if (!entry.write.length) return;
        ctx.pushW({
            code: 'step.field_restricted', severity: 'warning', path,
            message: `${label} writes field ${JSON.stringify(fieldKey)}, which ${named(entry.write)} may not write: the step runs as the viewer, so it is refused for them.`,
            hint: 'Fine when only the other roles reach this step. Otherwise give the role the field in its access.write, or leave the field out of the step.',
        });
        return;
    }
    if (!entry.read.length) return;
    ctx.pushW({
        code: 'binding.field_restricted', severity: 'warning', path,
        message: o.output
            ? `${label} names field ${JSON.stringify(fieldKey)}, which ${named(entry.read)} may not read: it is left out for them.`
            : `${label} uses field ${JSON.stringify(fieldKey)}, which ${named(entry.read)} may not read: for them this whole read is refused and the component stays empty.`,
        hint: o.output
            ? 'Fine when the column may be empty for those roles.'
            : 'Show this component only to the roles that read the field (visibleToRoles), or use a field every role reads.',
    });
}
