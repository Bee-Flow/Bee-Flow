/**
 * App Studio validator — record reads through a relation, after schema
 * version 2 (core/dataEngine/dataModel/vocabulary.js RELATION_READ_LIMITS):
 * a binding's `expand` and `fields`, and a filter clause on
 * `<relation field>.<field of the related table>`. A binding without them is
 * never looked at here.
 *
 * The checks mirror what queryCompilerRelation.mts refuses, as far as the data
 * model tells. One of them the compiler cannot say as clearly: a LINKED Studio
 * table keeps its rows outside the app, so it cannot be expanded, cannot be
 * expanded into and cannot be filtered through. That is refused here by name.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Finding = { code: string; severity: string; path: string; message: string; hint: string };
type Obj = Record<string, unknown>;
type Ctx = {
    pushE: (f: Finding) => void;
    dataTables?: Map<string, Set<string>> | null;
    dataRelationTargets?: Map<string, Map<string, string>> | null;
    dataTableSources?: Map<string, unknown> | null;
};

const { RELATION_READ_LIMITS, EXPAND_DEFAULT_SUFFIX, SYSTEM_COLUMNS } = nodeRequire('../../core/dataEngine/dataModel/vocabulary') as {
    RELATION_READ_LIMITS: { MAX_EXPAND: number; MAX_EXPAND_PICK: number; MAX_FIELDS: number; MAX_RELATION_FILTERS: number };
    EXPAND_DEFAULT_SUFFIX: string;
    SYSTEM_COLUMNS: readonly string[];
};
const refs = (): { checkFieldRef(tableId: unknown, col: unknown, path: string, ctx: Ctx, label: string, o?: { codePrefix: string }): void } => nodeRequire('./refs');

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const present = (v: unknown): boolean => v !== undefined && v !== null;
const invalid = (path: string, message: string, hint: string): Finding => ({ code: 'binding.relation_read_invalid', severity: 'error', path, message, hint });
const linked = (ctx: Ctx, tableId: unknown): boolean => !!(ctx.dataTableSources && typeof tableId === 'string' && ctx.dataTableSources.get(tableId));

const ALIAS_MAX = 63;
/** A letter, then letters, digits or underscores (the compiler's alias grammar), without a pattern. */
function isAlias(v: unknown): v is string {
    if (typeof v !== 'string' || v.length === 0 || v.length > ALIAS_MAX) return false;
    const letter = (c: string): boolean => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
    if (!letter(v[0])) return false;
    return [...v].every((c) => letter(c) || (c >= '0' && c <= '9') || c === '_');
}

/** The key of a record an expand entry lands in. */
export function expandAlias(entry: Obj): string | null {
    if (typeof entry.as === 'string' && entry.as) return entry.as;
    return typeof entry.field === 'string' && entry.field ? `${entry.field}${EXPAND_DEFAULT_SUFFIX}` : null;
}

/**
 * The related table of a relation field, or null with the finding pushed.
 * `undefined`: no data model in hand, the server checks it when it runs.
 */
function relatedTable(tableId: unknown, field: unknown, at: string, ctx: Ctx, what: string): string | null | undefined {
    if (linked(ctx, tableId)) {
        ctx.pushE(invalid(at, `A linked Studio table cannot ${what}: its rows live outside the app.`, 'Read the linked table as it is, or copy the data into a table of the app.'));
        return null;
    }
    const targets = ctx.dataRelationTargets && typeof tableId === 'string' ? ctx.dataRelationTargets.get(tableId) : null;
    if (!targets) return undefined;
    const target = typeof field === 'string' ? targets.get(field) : undefined;
    if (!target) {
        ctx.pushE(invalid(at, `${JSON.stringify(field)} is not a relation field of this table.`, `Relation fields: ${[...targets.keys()].join(', ') || '(none)'}.`));
        return null;
    }
    if (linked(ctx, target)) {
        ctx.pushE(invalid(at, `${JSON.stringify(field)} points at a linked Studio table, which cannot be read through a relation: its rows live outside the app.`, 'Show the relation field itself, or relate to a table of the app.'));
        return null;
    }
    return target;
}

function checkPick(entry: Obj, at: string, target: string | undefined, ctx: Ctx): void {
    const max = RELATION_READ_LIMITS.MAX_EXPAND_PICK;
    if (!Array.isArray(entry.pick) || entry.pick.length === 0 || entry.pick.length > max) {
        ctx.pushE(invalid(`${at}.pick`, `pick must be a list of 1 to ${max} field keys of the related table.`, 'e.g. ["name", "email"]; leave pick out for the relation\'s display field.'));
        return;
    }
    entry.pick.forEach((key, j) => {
        if (typeof key !== 'string' || !key) ctx.pushE(invalid(`${at}.pick[${j}]`, 'Each pick entry is a field key of the related table.', 'e.g. "name".'));
        else if (target) refs().checkFieldRef(target, key, `${at}.pick[${j}]`, ctx, 'expand pick');
    });
}

function checkAlias(entry: Obj, at: string, tableId: unknown, taken: Set<string>, ctx: Ctx): void {
    const alias = expandAlias(entry);
    if (alias === null) return;
    const where = present(entry.as) ? `${at}.as` : at;
    if (!isAlias(alias)) {
        ctx.pushE(invalid(where, `${JSON.stringify(entry.as)} is not a valid name for an expansion.`, 'Use letters, digits and underscores, starting with a letter.'));
        return;
    }
    const fields = ctx.dataTables && typeof tableId === 'string' ? ctx.dataTables.get(tableId) : null;
    if ((fields && fields.has(alias)) || SYSTEM_COLUMNS.includes(alias)) {
        ctx.pushE(invalid(where, `The expansion would land in ${JSON.stringify(alias)}, which is already a field of the table.`, 'Give it another name with `as`.'));
    }
    if (taken.has(alias)) ctx.pushE(invalid(where, `Two expansions land in ${JSON.stringify(alias)}.`, 'Give one of them another name with `as`.'));
    taken.add(alias);
}

/** `expand`: 1..MAX { field: <relation>, pick?, as? } entries, one relation deep. */
export function validateExpand(binding: Obj, path: string, ctx: Ctx): void {
    const at = `${path}.expand`;
    const max = RELATION_READ_LIMITS.MAX_EXPAND;
    const raw = binding.expand;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > max) {
        ctx.pushE(invalid(at, `expand must be a list of 1 to ${max} { field, pick?, as? } entries.`, 'e.g. [{ "field": "customer", "pick": ["name", "city"] }].'));
        return;
    }
    const taken = new Set<string>();
    raw.forEach((entry, i) => {
        const p = `${at}[${i}]`;
        if (!isObject(entry)) { ctx.pushE(invalid(p, 'An expand entry is { field, pick?, as? }.', 'e.g. { "field": "customer" }.')); return; }
        if (present(entry.expand)) ctx.pushE(invalid(`${p}.expand`, 'expand goes one relation deep.', 'Remove the nested expand.'));
        if (typeof entry.field !== 'string' || !entry.field) {
            ctx.pushE(invalid(`${p}.field`, 'An expand entry needs the key of a relation field.', 'e.g. { "field": "customer" }.'));
            return;
        }
        const target = relatedTable(binding.tableId, entry.field, `${p}.field`, ctx, 'expand a relation');
        if (target === null) return;
        if (present(entry.pick)) checkPick(entry, p, target, ctx);
        checkAlias(entry, p, binding.tableId, taken, ctx);
    });
}

/** `fields`: 1..MAX field keys of the bound table. */
export function validateFields(binding: Obj, path: string, ctx: Ctx, label: string): void {
    const at = `${path}.fields`;
    const max = RELATION_READ_LIMITS.MAX_FIELDS;
    const raw = binding.fields;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > max) {
        ctx.pushE(invalid(at, `fields must be a list of 1 to ${max} field keys.`, 'e.g. ["title", "status"]; leave fields out to read every column.'));
        return;
    }
    raw.forEach((key, i) => {
        if (typeof key !== 'string' || !key) ctx.pushE(invalid(`${at}[${i}]`, 'Each entry of fields is a field key.', 'e.g. "title".'));
        else refs().checkFieldRef(binding.tableId, key, `${at}[${i}]`, ctx, `${label} fields`);
    });
}

/**
 * A filter clause's `field` when it reads through a relation (`customer.city`).
 * Returns false for a plain field name (the caller checks that one).
 */
export function checkRelationFilterField(entry: Obj, p: string, ctx: Ctx, tableId: unknown, label: string): boolean {
    const field = entry.field;
    if (typeof field !== 'string' || !field.includes('.')) return false;
    const at = `${p}.field`;
    const parts = field.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        ctx.pushE(invalid(at, `${JSON.stringify(field)} is not <relation field>.<field of the related table>.`, 'A filter goes one relation deep, e.g. "customer.city".'));
        return true;
    }
    if (present(entry.otherField)) ctx.pushE(invalid(`${p}.otherField`, 'A filter through a relation compares with a value, not with another column.', 'Remove otherField and give a value.'));
    const target = relatedTable(tableId, parts[0], at, ctx, 'be filtered through a relation');
    if (target) refs().checkFieldRef(target, parts[1], at, ctx, `${label} filter`);
    return true;
}

/** How many clauses of a filter list read through a relation. */
function countRelationClauses(entry: unknown, depth = 0): number {
    if (!entry || typeof entry !== 'object' || depth > 8) return 0;
    if (Array.isArray(entry)) return entry.reduce((n: number, e) => n + countRelationClauses(e, depth + 1), 0);
    const e = entry as Obj;
    if (typeof e.field === 'string') return e.field.includes('.') ? 1 : 0;
    return countRelationClauses(e.any, depth + 1) + countRelationClauses(e.all, depth + 1) + countRelationClauses(e.not, depth + 1);
}

/** At most MAX_RELATION_FILTERS clauses of one filter read through a relation. */
export function checkRelationFilterCount(filter: unknown, path: string, ctx: Ctx): void {
    const max = RELATION_READ_LIMITS.MAX_RELATION_FILTERS;
    const n = countRelationClauses(filter);
    if (n > max) ctx.pushE(invalid(path, `${n} clauses of this filter read through a relation; the limit is ${max}.`, 'Combine values with op "in", or filter on the relation field itself.'));
}
