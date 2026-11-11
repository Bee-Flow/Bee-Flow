/**
 * COLUMN RIGHTS at save time (columnRights.mts has the rules and how reads and
 * writes enforce them): the shape of one field's `access`, and what a table as a
 * whole may not combine with column rights. Called by appStudio/dataModel/modelValidate.js.
 *
 * LAYER: core/, pure functions of a table descriptor.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Field = { key?: string; type?: string; unique?: boolean; access?: unknown; relation?: unknown };
type TableMeta = { key?: string; fields?: unknown; source?: unknown };

const { KEY_RE, PUBLIC_ROLE_KEY } = nodeRequire('./dataModel/vocabulary') as { KEY_RE: RegExp; PUBLIC_ROLE_KEY: string };
const { hasColumnRights, rolesOf, NEVER_WRITTEN } = nodeRequire('./columnRights.mts') as {
    hasColumnRights(tableMeta: unknown): boolean;
    rolesOf(field: Field, key: 'read' | 'write'): string[] | null;
    NEVER_WRITTEN: readonly string[];
};

/** The keys of `field.access`. */
export const FIELD_ACCESS_KEYS: readonly string[] = Object.freeze(['read', 'write']);
/** The most roles one list names (a validity limit, so a constant). */
export const MAX_FIELD_ACCESS_ROLES = 50;

const OWNER_ROLE = 'owner';

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function fieldsOf(tableMeta: unknown): Field[] {
    const fields = isObject(tableMeta) && Array.isArray(tableMeta.fields) ? tableMeta.fields as unknown[] : [];
    return fields.filter((f): f is Field => isObject(f) && typeof f.key === 'string' && f.key !== '');
}

const declares = (field: Field): boolean => rolesOf(field, 'read') !== null || rolesOf(field, 'write') !== null;

/** Does this relation field carry an onDelete rule (dataModel/linkedFields.js)? */
function hasDeleteRule(field: Field): boolean {
    return isObject(field.relation) && field.relation.onDelete !== undefined && field.relation.onDelete !== null;
}

function roleListErrors(list: unknown, at: string): string[] {
    if (!Array.isArray(list)) return [`${at} must be a list of role keys`];
    if (list.length > MAX_FIELD_ACCESS_ROLES) return [`${at} names more than ${MAX_FIELD_ACCESS_ROLES} roles`];
    const errors: string[] = [];
    const seen = new Set<string>();
    for (const role of list) {
        if (typeof role !== 'string' || !KEY_RE.test(role)) errors.push(`${at} holds ${JSON.stringify(role)}, which is not a role key`);
        else if (role === OWNER_ROLE) errors.push(`${at} names "owner": the owner always has every field, leave it out`);
        else if (seen.has(role)) errors.push(`${at} names "${role}" twice`);
        else seen.add(role);
    }
    return errors;
}

/** The shape of one field's `access`; silent for a field without it. */
export function fieldAccessErrors(field: unknown, at: string): string[] {
    if (!isObject(field) || field.access === undefined) return [];
    const access = field.access;
    if (!isObject(access)) return [`${at}.access must be an object { read?, write? }`];
    const errors: string[] = [];
    const extra = Object.keys(access).filter((k) => !FIELD_ACCESS_KEYS.includes(k));
    if (extra.length) errors.push(`${at}.access has unknown keys: ${extra.join(', ')}`);
    if (access.read === undefined && access.write === undefined) errors.push(`${at}.access needs read or write (remove access to give every role the field)`);
    for (const key of FIELD_ACCESS_KEYS) if (access[key] !== undefined) errors.push(...roleListErrors(access[key], `${at}.access.${key}`));
    if (access.write !== undefined && NEVER_WRITTEN.includes(field.type as string)) {
        errors.push(`${at}.access.write does not apply: a ${field.type} field is never written`);
    }
    return errors;
}

/**
 * What column rights need of the table as a whole:
 *   - not on a linked Studio table: its rows are read with the datatable's own
 *     descriptor, which does not carry these lists, so the rights would not hold;
 *   - not `unique` on a field some role may write and not read: the refusal of a
 *     value that exists would tell that role which values the field holds;
 *   - no `read` list on a relation with an onDelete rule: a refused delete, or the
 *     records it changes, would tell a role that may not read the relation which
 *     records point at the one deleted.
 * `warnings` name a role the model does not declare (it gives nobody the field);
 * `roles` is the model's own `roles` list, and a model without one is not asked.
 */
export function tableColumnRightsFindings(table: unknown, at: string, roles: unknown): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!hasColumnRights(table)) return { errors, warnings };
    const roleKeys = Array.isArray(roles)
        ? roles.map((r) => (isObject(r) ? r.key : undefined)).filter((k): k is string => typeof k === 'string')
        : null;
    const t = table as TableMeta;
    if (t.source !== undefined && t.source !== null) {
        errors.push(`${at} is a linked Studio table: column rights (field.access) are not available on it. Set the rights on the Studio table, or copy the rows into a table of this app`);
        return { errors, warnings };
    }
    for (const f of fieldsOf(table)) {
        if (!declares(f)) continue;
        const read = rolesOf(f, 'read');
        const write = rolesOf(f, 'write');
        if (f.unique === true && read !== null && write !== null) {
            const blind = write.filter((r) => !read.includes(r));
            if (blind.length) errors.push(`${at} field "${f.key}" is unique, and ${blind.map((r) => `"${r}"`).join(', ')} may write it without reading it: a refused duplicate would tell which values exist. Let the role read the field, take it out of write, or drop unique`);
        }
        if (read !== null && hasDeleteRule(f)) {
            errors.push(`${at} field "${f.key}" follows a delete rule (onDelete), and only some roles may read it: whether a delete is refused or changes other records would tell those roles which records point where. Let every role read the relation, or drop the delete rule`);
        }
        if (!roleKeys) continue;
        for (const role of new Set([...(read || []), ...(write || [])])) {
            if (role !== PUBLIC_ROLE_KEY && !roleKeys.includes(role)) warnings.push(`${at} field "${f.key}" names the role "${role}", which this app does not have`);
        }
    }
    return { errors, warnings };
}
