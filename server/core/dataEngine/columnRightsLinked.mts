/**
 * COLUMN RIGHTS of the fields that have no column (dataModel/linkedFields.js): what
 * linkedRead.mts may serve to a role when the tables it reads through declare
 * `field.access` (columnRights.mts).
 *
 *   lookup   leaves its own table like any hidden field when the role may not read the
 *            relation it reads through (columnRights.hiddenFields follows it), and reads
 *            null when the role may not read the field it shows on the related table, as
 *            for a related row the role may not read.
 *   rollup   is not computed (null) when the role may not read, on the child table, the
 *            relation it counts through, the field it folds, or a field its own filter
 *            names. Otherwise it folds the child rows the role may read, as before.
 *   many     a hidden many relation leaves the record like any hidden field; its links
 *            are ids of rows the role may read, so no column of the target is served.
 *   own      a lookup, rollup or many field with its own `access` is hidden like any field.
 *
 * Every answer here depends on the rights and the role, never on a value: two tables that
 * differ only in what a role may not read give that role the same records.
 *
 * The hidden fields of a related table come from the verdict its access filter carries
 * (columnRights.scopeColumns), so a related table with column rights read under a filter that
 * never resolved them is refused here too, as in every other compiler.
 *
 * LAYER: core/, pure functions of table descriptors, access filters and a role.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type TableMeta = { key?: string; fields?: unknown[] | null; source?: unknown };
type Target = { tableMeta: TableMeta; accessFilter: { where: string; params: unknown[] } };

const rights = nodeRequire('./columnRights.mts') as {
    hiddenFields(tableMeta: unknown, role: unknown): Set<string>;
    scopeColumns<T extends TableMeta>(tableMeta: T, accessFilter: unknown): { tableMeta: T; hidden: ReadonlySet<string> | null };
};

/** The predicate aggregateRelated hands over for a table the role may not read at all. */
const NO_ROWS = '1=0';
const NONE: ReadonlySet<string> = new Set();

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The fields of the read's own table its role may not read (a lookup through a hidden relation among them). */
export function ownHidden(tableMeta: unknown, role: unknown): Set<string> {
    return rights.hiddenFields(tableMeta, role);
}

/** What the role behind `target.accessFilter` may not read of the related table. Nothing for a table it reads no row of. */
export function targetHidden(target: Target): ReadonlySet<string> {
    if (target.accessFilter.where === NO_ROWS) return NONE;
    return rights.scopeColumns(target.tableMeta, target.accessFilter).hidden || NONE;
}

/** The field names a rollup filter compares (`field`, `otherField`, the relation of a `relation.field` path), at any depth. */
export function filterNames(filter: unknown): Set<string> {
    const out = new Set<string>();
    const walk = (entry: unknown, depth: number): void => {
        if (depth > 8) return;
        if (Array.isArray(entry)) { for (const e of entry) walk(e, depth + 1); return; }
        if (!isObject(entry)) return;
        for (const key of ['field', 'otherField']) {
            const name = entry[key];
            if (typeof name === 'string' && name) out.add(name.split('.')[0] as string);
        }
        for (const key of ['any', 'all', 'not']) walk(entry[key], depth + 1);
    };
    walk(filter, 0);
    return out;
}

/** Does a rollup over the child table read anything `hidden` (the child's hidden fields for the role) holds? */
export function rollupReadsHidden(hidden: ReadonlySet<string>, spec: { relation?: unknown; field?: unknown; filter?: unknown }): boolean {
    if (hidden.size === 0) return false;
    if (typeof spec.relation === 'string' && hidden.has(spec.relation)) return true;
    if (typeof spec.field === 'string' && hidden.has(spec.field)) return true;
    return [...filterNames(spec.filter)].some((name) => hidden.has(name));
}
