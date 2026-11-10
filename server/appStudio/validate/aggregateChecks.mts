/**
 * App Studio validator — the aggregate vocabulary after schema version 2
 * (core/dataEngine/dataModel/vocabulary.js AGGREGATE_LIMITS): groupBy entries
 * with `binWidth` or `relatedField`, and the binding's `groupFilter`. A binding
 * without them is never looked at here.
 *
 * The checks mirror what queryCompilerAggregateExt.mts refuses, as far as the
 * data model tells: a number column for a bin (a computed column's type is the
 * compiler's to judge), a relation field whose target is a table of this app
 * with its own storage, a real column on that target, and a groupFilter that
 * names a number aggregate of the binding.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Finding = { code: string; severity: string; path: string; message: string; hint: string };
type Obj = Record<string, unknown>;
type Ctx = {
    pushE: (f: Finding) => void;
    dataFieldTypes?: Map<string, Map<string, string>> | null;
    dataRelationTargets?: Map<string, Map<string, string>> | null;
    dataTableSources?: Map<string, unknown> | null;
};

const { GROUP_FILTER_OPS, AGGREGATE_LIMITS } = nodeRequire('../../core/dataEngine/dataModel/vocabulary') as {
    GROUP_FILTER_OPS: readonly string[];
    AGGREGATE_LIMITS: { MAX_GROUP_FILTERS: number; MAX_RELATED_GROUP_BY: number; MAX_BIN_WIDTH: number };
};
const refs = (): { checkFieldRef(tableId: unknown, col: unknown, path: string, ctx: Ctx, label: string, o: { codePrefix: string }): void } => nodeRequire('./refs');

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const present = (v: unknown): boolean => v !== undefined && v !== null;
const invalid = (path: string, message: string, hint: string): Finding => ({ code: 'binding.aggregate_invalid', severity: 'error', path, message, hint });
const NUMERIC_FNS = new Set(['count', 'countDistinct', 'sum', 'avg']);

/** opts.dataModel → Map(tableId → Map(relation field key → target table id)). null without a model. */
export function buildRelationTargets(dataModel: unknown): Map<string, Map<string, string>> | null {
    if (dataModel === undefined) return null;
    const map = new Map<string, Map<string, string>>();
    const tables = isObject(dataModel) && Array.isArray(dataModel.tables) ? dataModel.tables : [];
    for (const t of tables) {
        if (!isObject(t) || typeof t.id !== 'string') continue;
        const targets = new Map<string, string>();
        for (const f of Array.isArray(t.fields) ? t.fields : []) {
            if (isObject(f) && f.type === 'relation' && typeof f.key === 'string' && isObject(f.relation) && typeof f.relation.table === 'string') targets.set(f.key, f.relation.table);
        }
        map.set(t.id, targets);
    }
    return map;
}

/** The output column a groupBy entry produces (queryCompilerAggregate*.mts derive it the same way). */
export function groupByAlias(g: Obj): string | null {
    if (typeof g.as === 'string' && g.as) return g.as;
    if (typeof g.field !== 'string' || !g.field) return null;
    const name = present(g.relatedField) ? `${g.field}_${g.relatedField}` : g.field;
    const suffix = g.bucket ? `_${g.bucket}` : present(g.binWidth) ? '_bin' : '';
    return `${name}${suffix}`;
}

function fieldType(ctx: Ctx, tableId: unknown, key: unknown): string | undefined {
    const types = ctx.dataFieldTypes && typeof tableId === 'string' ? ctx.dataFieldTypes.get(tableId) : null;
    return types && typeof key === 'string' ? types.get(key) : undefined;
}

/** relatedField: the field is a relation to a table of this app with its own storage, and the column exists there. */
function checkRelated(g: Obj, at: string, tableId: unknown, ctx: Ctx): string | null {
    if (typeof g.relatedField !== 'string' || !g.relatedField) {
        ctx.pushE(invalid(`${at}.relatedField`, 'relatedField must be the key of a field on the related table.', 'e.g. { "field": "customer", "relatedField": "region" }.'));
        return null;
    }
    if (ctx.dataTableSources && typeof tableId === 'string' && ctx.dataTableSources.get(tableId)) {
        ctx.pushE(invalid(`${at}.relatedField`, 'A linked Studio table cannot be grouped through a relation.', 'Group by the relation field itself.'));
        return null;
    }
    const targets = ctx.dataRelationTargets && typeof tableId === 'string' ? ctx.dataRelationTargets.get(tableId) : null;
    if (!targets) return null; // no data model in hand: the server checks it when it runs
    const target = typeof g.field === 'string' ? targets.get(g.field) : undefined;
    if (!target) {
        ctx.pushE(invalid(`${at}.field`, `relatedField needs a relation field; ${JSON.stringify(g.field)} is not one.`, 'Pick a field of type relation.'));
        return null;
    }
    if (ctx.dataTableSources && ctx.dataTableSources.get(target)) {
        ctx.pushE(invalid(`${at}.relatedField`, `${JSON.stringify(g.field)} points at a linked Studio table, which cannot be grouped through.`, 'Group by the relation field itself.'));
        return null;
    }
    refs().checkFieldRef(target, g.relatedField, `${at}.relatedField`, ctx, 'aggregate binding relatedField', { codePrefix: 'binding' });
    return target;
}

function checkBin(g: Obj, at: string, tableId: unknown, relatedTarget: string | null, ctx: Ctx): void {
    const w = g.binWidth;
    if (typeof w !== 'number' || !Number.isInteger(w) || w < 1 || w > AGGREGATE_LIMITS.MAX_BIN_WIDTH) {
        ctx.pushE(invalid(`${at}.binWidth`, `binWidth must be a whole number from 1 to ${AGGREGATE_LIMITS.MAX_BIN_WIDTH}.`, 'e.g. 10 groups 0–9, 10–19, …'));
    }
    if (g.bucket) ctx.pushE(invalid(`${at}.binWidth`, 'A groupBy entry takes bucket or binWidth, not both.', 'Use bucket for dates and binWidth for numbers.'));
    const type = relatedTarget ? fieldType(ctx, relatedTarget, g.relatedField) : fieldType(ctx, tableId, g.field);
    if (type !== undefined && type !== 'number' && type !== 'computed') {
        ctx.pushE(invalid(`${at}.binWidth`, `binWidth needs a number field; this one is ${type}.`, 'Remove binWidth, or group a number field.'));
    }
}

/** The groupBy entries that use binWidth or relatedField. */
export function validateExtendedGroupBy(groupBy: unknown[], path: string, tableId: unknown, ctx: Ctx): void {
    let related = 0;
    groupBy.forEach((g, i) => {
        if (!isObject(g)) return;
        const at = `${path}.groupBy[${i}]`;
        let target: string | null = null;
        if (present(g.relatedField)) {
            related += 1;
            if (related === AGGREGATE_LIMITS.MAX_RELATED_GROUP_BY + 1) {
                ctx.pushE(invalid(at, `At most ${AGGREGATE_LIMITS.MAX_RELATED_GROUP_BY} groupBy entries may go through a relation.`, 'Drop one.'));
            }
            target = checkRelated(g, at, tableId, ctx);
        }
        if (present(g.binWidth)) checkBin(g, at, tableId, target, ctx);
    });
}

/** groupFilter: 1..MAX entries { field: <number aggregate alias>, op, value: number }. */
export function validateGroupFilter(binding: Obj, path: string, ctx: Ctx): void {
    const raw = binding.groupFilter;
    const at = `${path}.groupFilter`;
    const max = AGGREGATE_LIMITS.MAX_GROUP_FILTERS;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > max) {
        ctx.pushE(invalid(at, `groupFilter must be a list of 1 to ${max} { field, op, value } entries.`, 'e.g. [{ "field": "n", "op": "gte", "value": 3 }] keeps the groups with at least 3 rows.'));
        return;
    }
    const dynamic = isObject(binding.aggregates) && binding.aggregates.kind === 'formula';
    const aggregates = new Map<string, Obj>();
    for (const a of Array.isArray(binding.aggregates) ? binding.aggregates : []) {
        if (!isObject(a) || typeof a.fn !== 'string') continue;
        aggregates.set(typeof a.as === 'string' && a.as ? a.as : `${a.fn}_${a.field && a.field !== '*' ? a.field : 'all'}`, a);
    }
    raw.forEach((e, i) => {
        const p = `${at}[${i}]`;
        if (!isObject(e)) { ctx.pushE(invalid(p, 'A groupFilter entry is { field, op, value }.', 'e.g. { "field": "n", "op": "gt", "value": 1 }.')); return; }
        if (!GROUP_FILTER_OPS.includes(e.op as string)) ctx.pushE(invalid(`${p}.op`, `Unknown groupFilter op ${JSON.stringify(e.op)}.`, `Use one of: ${GROUP_FILTER_OPS.join(', ')}.`));
        if (typeof e.value !== 'number' || !Number.isFinite(e.value)) ctx.pushE(invalid(`${p}.value`, 'A groupFilter value is a number.', 'e.g. 3.'));
        if (dynamic) return; // the aggregates are named when the formula runs; the server checks them then
        const a = typeof e.field === 'string' ? aggregates.get(e.field) : undefined;
        if (!a) {
            ctx.pushE(invalid(`${p}.field`, `groupFilter names ${JSON.stringify(e.field)}, which is not one of the binding's aggregates.`, `Use one of: ${[...aggregates.keys()].join(', ') || '(none)'}.`));
            return;
        }
        const type = fieldType(ctx, binding.tableId, a.field);
        if (!NUMERIC_FNS.has(a.fn as string) && type !== undefined && type !== 'number' && type !== 'computed') {
            ctx.pushE(invalid(`${p}.field`, `groupFilter compares numbers; "${e.field}" is the ${a.fn} of a ${type} field.`, 'Filter on a count, sum or average instead.'));
        }
    });
}
