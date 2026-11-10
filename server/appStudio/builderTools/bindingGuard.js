/**
 * Tool-time check of the DATA references inside an app_add_components /
 * app_update_component call: does every records/record/aggregate binding
 * name a table this app has, and every filter/sort/groupBy/aggregate field a
 * key that table has?
 *
 * The validator asks the same question at finalize — one round later, after
 * the model has built on the wrong key. And for a LINKED table it does not
 * ask at all (the copy may lag the source, validate/refs.js). Here the copy
 * is what app_link_datatable wrote moments ago, so a key that is not in it is
 * almost always the model writing the column TITLE ("Excl. btw", "exclBtw")
 * where the KEY (excl_btw) belongs — the exact mistake that costs the demo a
 * round. The did-you-mean names the key.
 *
 * Pure. Skipped entirely when the model was not loaded this turn
 * (dataModel === undefined) — "we were not told" is not "there are no tables".
 */

'use strict';

const { pickClosestId } = require('../../automation/validate/helpers');
const { SYSTEM_COLUMNS } = require('../dataModel');
const { isDatatableBacked } = require('../datatableSource');
const { getSpec } = require('../componentSpecs');
const { suggestTableId } = require('./tableHints');
const { forEachFilterClause } = require('../../shared/expr/filterGroups.mjs');
const { groupByAlias } = require('../validate/aggregateChecks.mts');
const { expandAlias } = require('../validate/relationReadChecks.mts');
const { EXPAND_LABEL_KEY } = require('../../core/dataEngine/dataModel/vocabulary');

// What the model reads when a table is not there: both ways to get one. The
// 2026-09-13 trace saw "create the table first" from a menu that had no
// creator; the sentence names the tools now, and the rule.
const NO_TABLE_ADVICE = 'Create it first with app_upsert_table {name, fields:[{key,type}]} or link an existing Studio table with app_link_datatable {name}, then use the tbl_ id the result returns — never invent one.';

const DATA_BINDING_KINDS = new Set(['record', 'records', 'aggregate']);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {object | null} model
 */
function tableIndex(model) {
    const tables = (model && Array.isArray(model.tables)) ? model.tables : [];
    const byRef = new Map();
    for (const t of tables) {
        if (!t || typeof t.id !== 'string') continue;
        byRef.set(t.id, t);
        if (typeof t.key === 'string') byRef.set(t.key, t);
    }
    return { tables, byRef };
}

/**
 * @param {Array} entries  the call's component entries (nested children walked)
 * @param {object|null|undefined} model  draftWrap.dataModel
 * @returns {{ errors: Array<{ index:number, path:string, message:string, hint:string }>, repairs: string[] }}
 *   `repairs` — a component's `props.tableId` that named a table by handle
 *   (`tbl_suppliers_01` for the table with key `suppliers`) was rewritten IN
 *   PLACE on the entry to the real id; the note goes to the tool's `_hints`.
 */
function checkComponentDataRefs(entries, model) {
    const errors = [];
    /** @type {string[]} */
    const repairs = [];
    if (model === undefined || !Array.isArray(entries)) return { errors, repairs };
    const { tables, byRef } = tableIndex(model);
    const tableList = tables.length ? tables.map((t) => `${t.id} (${t.key})`).join(', ') : '(none — the app has no tables)';

    /**
     * @param {string} path
     * @param {string} key
     * @param {string} what
     * @param {number} index
     */
    const fieldCheck = (index, path, table, key, what) => {
        if (typeof key !== 'string' || !key) return;
        const keys = (table.fields || []).map((f) => f && f.key).filter(Boolean);
        if (keys.includes(key) || SYSTEM_COLUMNS.includes(key)) return;
        const near = pickClosestId(key, keys);
        const linked = isDatatableBacked(table);
        errors.push({
            index,
            path,
            suggestion: near || null,
            message: `${what} names field ${JSON.stringify(key)}, which table ${table.id} (${table.key}) does not have.`,
            hint: `${near ? `Did you mean "${near}"? ` : ''}Field keys on ${table.key}: ${keys.join(', ') || '(none)'}.${linked ? ' It is a linked table — keys are the source column titles in lowercase_snake_case ("Excl. btw" → excl_btw); if the column was added just now, call app_link_datatable again to refresh the copy.' : ''}`,
        });
    };

    /** The table a relation field of `table` points at, or null. */
    const relationTarget = (table, key) => {
        const relation = (table.fields || []).find((f) => f && f.key === key && f.type === 'relation');
        return (relation && relation.relation && byRef.get(relation.relation.table)) || null;
    };

    /**
     * `<relation field>.<field of the related table>` (a filter through a relation): the head must
     * be a relation field of `table` and the tail a field of the table it points at. False for a
     * plain name, which the caller checks.
     * @param {number} index
     * @param {string} path
     * @param {string} what
     */
    const throughRelation = (index, path, table, key, what) => {
        if (typeof key !== 'string' || !key.includes('.')) return false;
        const [head, tail, more] = key.split('.');
        const target = relationTarget(table, head);
        if (!target || !tail || more !== undefined) {
            const relations = (table.fields || []).filter((f) => f && f.type === 'relation').map((f) => f.key);
            errors.push({
                index, path, suggestion: null,
                message: `${what} names ${JSON.stringify(key)}, which is not <relation field>.<field of the related table> on table ${table.id} (${table.key}).`,
                hint: `Relation fields on ${table.key}: ${relations.join(', ') || '(none)'}. A read goes one relation deep.`,
            });
            return true;
        }
        fieldCheck(index, path, target, tail, what);
        return true;
    };

    /**
     * One `expand` entry: a relation field of `table`, and picked fields of the table it points at.
     * @param {number} index
     * @param {string} path
     */
    const checkExpandEntry = (index, path, table, e) => {
        const target = relationTarget(table, e.field);
        if (!target) {
            const relations = (table.fields || []).filter((f) => f && f.type === 'relation').map((f) => f.key);
            errors.push({
                index, path: `${path}.field`, suggestion: pickClosestId(e.field, relations) || null,
                message: `expand names ${JSON.stringify(e.field)}, which is not a relation field of table ${table.id} (${table.key}) to another table of this app.`,
                hint: `Relation fields on ${table.key}: ${relations.join(', ') || '(none)'}.`,
            });
            return;
        }
        (Array.isArray(e.pick) ? e.pick : []).forEach((k, j) => fieldCheck(index, `${path}.pick[${j}]`, target, k, 'expand pick'));
    };

    /**
     * A grid column on an expanded relation (`<expand name>.<field of the related table>`): the
     * head must be an expansion of the grid's binding. False for a plain column key.
     * @param {number} index
     * @param {string} path
     */
    const expandedColumn = (index, path, table, data, key) => {
        if (!key.includes('.')) return false;
        const [head, tail] = key.split('.');
        const entry = (Array.isArray(data.expand) ? data.expand : []).find((e) => isObject(e) && expandAlias(e) === head);
        const target = entry ? relationTarget(table, entry.field) : null;
        if (!target) {
            errors.push({
                index, path, suggestion: null,
                message: `grid column ${JSON.stringify(key)} reads a related row, but the grid's binding has no expand named ${JSON.stringify(head)}.`,
                hint: 'Add expand: [{ field: <relation field>, pick: [<fields>] }] to the binding; the related row then sits under <relation field>_record (or the entry\'s `as`), e.g. column key "customer_record.name".',
            });
            return true;
        }
        if (tail !== EXPAND_LABEL_KEY) fieldCheck(index, path, target, tail, 'grid column');
        return true;
    };

    /**
     * @param {string} path
     * @param {number} index
     */
    const checkBinding = (index, path, b) => {
        const table = byRef.get(b.tableId);
        if (!table) {
            // `tbl_a144aa}},style:{span:12},type:` — an id that carries JSON
            // punctuation is a call that broke at that point, not a wrong table
            // (measured 2026-09-14). Say so; the legal-table list does not help.
            if (typeof b.tableId === 'string' && /[{}\[\]:,"]/.test(b.tableId)) {
                const prefix = (/^(tbl_[A-Za-z0-9]+)/.exec(b.tableId) || [])[1] || null;
                const meant = prefix ? tables.find((t) => t.id === prefix) : null;
                errors.push({
                    index,
                    path: `${path}.tableId`,
                    suggestion: meant ? meant.id : null,
                    message: `${b.kind} binding's tableId ${JSON.stringify(b.tableId.slice(0, 40))} carries JSON punctuation — the call's JSON is broken at that entry, nothing was added.`,
                    hint: `${meant ? `The id starts as ${meant.id} — ` : ''}Resend in two smaller calls, one card per call, with complete well-formed JSON.`,
                });
                return;
            }
            const handle = suggestTableId(b.tableId, tables);
            const near = handle ? handle.table.id : (typeof b.tableId === 'string' ? pickClosestId(b.tableId, tables.map((t) => t.id)) : null);
            errors.push({
                index,
                path: `${path}.tableId`,
                suggestion: near || null,
                message: `${b.kind} binding names table ${JSON.stringify(b.tableId)}, which this app does not have.`,
                hint: `${near ? `Did you mean "${near}"? ` : ''}Tables: ${tableList}. ${NO_TABLE_ADVICE}`,
            });
            return;
        }
        const filters = Array.isArray(b.filter) ? b.filter : (Array.isArray(b.filters) ? b.filters : []);
        // Every clause, the ones inside { any: [...] } groups too.
        forEachFilterClause(filters, (f, at) => {
            if (!isObject(f)) return;
            if (throughRelation(index, `${path}.filter${at}.field`, table, f.field, `${b.kind} filter`)) return;
            fieldCheck(index, `${path}.filter${at}.field`, table, f.field, `${b.kind} filter`);
            if (typeof f.otherField === 'string') fieldCheck(index, `${path}.filter${at}.otherField`, table, f.otherField, `${b.kind} filter`);
        });
        (Array.isArray(b.fields) ? b.fields : []).forEach((k, i) => fieldCheck(index, `${path}.fields[${i}]`, table, k, `${b.kind} fields`));
        (Array.isArray(b.expand) ? b.expand : []).forEach((e, i) => { if (isObject(e)) checkExpandEntry(index, `${path}.expand[${i}]`, table, e); });
        const sorts = Array.isArray(b.sort) ? b.sort : (isObject(b.sort) ? [b.sort] : []);
        const aliases = new Set();
        if (b.kind === 'aggregate') {
            (Array.isArray(b.groupBy) ? b.groupBy : []).forEach((g, i) => {
                if (!isObject(g)) return;
                fieldCheck(index, `${path}.groupBy[${i}].field`, table, g.field, 'aggregate groupBy');
                const alias = typeof g.as === 'string' ? g.as : groupByAlias(g);
                if (alias !== null) aliases.add(alias);
            });
            (Array.isArray(b.aggregates) ? b.aggregates : []).forEach((a, i) => {
                if (!isObject(a)) return;
                if (a.field && a.field !== '*') fieldCheck(index, `${path}.aggregates[${i}].field`, table, a.field, `aggregate ${a.fn || ''}`.trim());
                if (typeof a.as === 'string') aliases.add(a.as);
            });
        }
        sorts.forEach((s, i) => { if (isObject(s) && !aliases.has(s.field)) fieldCheck(index, `${path}.sort[${i}].field`, table, s.field, `${b.kind} sort`); });
        (Array.isArray(b.orderBy) ? b.orderBy : []).forEach((s, i) => { if (isObject(s) && !aliases.has(s.field)) fieldCheck(index, `${path}.orderBy[${i}].field`, table, s.field, `${b.kind} orderBy`); });
    };

    /**
     * @param {string} path
     * @param {number} index
     */
    const visit = (index, path, value, tableForColumns) => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) { value.forEach((v, i) => visit(index, `${path}[${i}]`, v, tableForColumns)); return; }
        if (typeof value.kind === 'string' && DATA_BINDING_KINDS.has(value.kind)) { checkBinding(index, path, value); return; }
        if (value.kind === 'dataset' && typeof value.datasetId !== 'string') return;
        for (const [k, v] of Object.entries(value)) visit(index, `${path}.${k}`, v, tableForColumns);
    };

    /**
     * @param {number} index
     * @param {string} path
     */
    const walk = (entry, index, path) => {
        if (!isObject(entry)) return;
        const props = isObject(entry.props) ? entry.props : {};
        for (const [k, v] of Object.entries(props)) visit(index, `${path}.props.${k}`, v);
        // A component whose spec declares a plain-string `tableId` prop
        // (input_relation) names a table like a binding does — and was the
        // one reference the 2026-09-13 trace got past this guard four times,
        // to fail at finalize. A handle that names exactly one table is
        // repaired in place; anything else is refused like a binding.
        const spec = typeof entry.type === 'string' ? getSpec(entry.type) : null;
        if (spec && spec.props && spec.props.tableId && typeof props.tableId === 'string' && props.tableId) {
            let table = byRef.get(props.tableId);
            if (!table) {
                const handle = suggestTableId(props.tableId, tables);
                if (handle) {
                    repairs.push(`${path}.props.tableId "${props.tableId}" is not a table — read as ${handle.table.id} (key ${handle.table.key}). Use ids from tool results.`);
                    entry.props = { ...props, tableId: handle.table.id };
                    table = handle.table;
                } else {
                    const near = pickClosestId(props.tableId, tables.map((t) => t.id));
                    errors.push({
                        index,
                        path: `${path}.props.tableId`,
                        suggestion: near || null,
                        message: `${entry.type} names table ${JSON.stringify(props.tableId)}, which this app does not have.`,
                        hint: `${near ? `Did you mean "${near}"? ` : ''}Tables: ${tableList}. ${NO_TABLE_ADVICE}`,
                    });
                }
            }
            if (table && typeof props.displayField === 'string') fieldCheck(index, `${path}.props.displayField`, table, props.displayField, `${entry.type} displayField`);
        }
        // A grid's columns must be keys of the table its data binding names.
        const data = props.data || props.source || props.records;
        const table = isObject(data) && DATA_BINDING_KINDS.has(data.kind) ? byRef.get(data.tableId) : null;
        if (table && Array.isArray(props.columns)) {
            props.columns.forEach((c, i) => {
                const key = isObject(c) ? (c.key || c.field) : c;
                if (typeof key !== 'string') return;
                // The related row itself (shown by its display field) or one of its fields.
                if ((Array.isArray(data.expand) ? data.expand : []).some((e) => isObject(e) && expandAlias(e) === key)) return;
                if (expandedColumn(index, `${path}.props.columns[${i}].key`, table, data, key)) return;
                fieldCheck(index, `${path}.props.columns[${i}].key`, table, key, 'grid column');
            });
        }
        (Array.isArray(entry.children) ? entry.children : []).forEach((ch, i) => walk(ch, index, `${path}.children[${i}]`));
    };
    entries.forEach((entry, i) => walk(entry, i, `components[${i}]`));
    return { errors, repairs };
}

/**
 * One error line + one hint for a tool result, from the guard's findings —
 * and, when EVERY finding has a did-you-mean, the fix as a machine-readable
 * `_suggestedPatch` (the automation builder's shape: set ops on arg paths). The
 * small local model cannot edit one field of a call it already sent; it
 * resends it byte-identical, and the ladder in builderTools.js then applies
 * this patch itself.
 * @param {{ errors: Array<{ index: number; path: string; message: string; hint: string; }>; repairs: string[]; }} check
 * @param {string} [at]
 */
function guardResult(check, at = 'components') {
    if (!check || !check.errors.length) return null;
    const first = check.errors[0];
    const lines = check.errors.slice(0, 6).map((e) => `${e.path}: ${e.message} ${e.hint}`);
    const out = {
        error: `${check.errors.length} data reference${check.errors.length === 1 ? '' : 's'} in ${at} would fail at run time — nothing was added. ${lines.join(' | ')}`,
        failedIndex: first.index,
        _fixHint: `Reject reason: ${first.message} ${first.hint} Field keys and table ids are listed under each table in the draft state's data block — use them exactly as written, then resend the whole call.`,
    };
    if (check.errors.every((e) => typeof e.suggestion === 'string' && e.suggestion && typeof e.path === 'string')) {
        out._suggestedPatch = {
            ops: check.errors.map((e) => ({ op: 'set', path: e.path, value: e.suggestion })),
            why: 'the did-you-mean keys, applied in place',
        };
        out._fixHint += ` A ready-made patch is attached as _suggestedPatch (${check.errors.map((e) => `${e.path} → ${JSON.stringify(e.suggestion)}`).join(', ')}); resend the identical call and it is applied for you.`;
    }
    return out;
}

module.exports = { checkComponentDataRefs, guardResult, DATA_BINDING_KINDS };

/**
 * One model-authored object — a component entry, a binding, a filter — read defensively.
 * @typedef {{ [k: string]: unknown, kind?: string, type?: string, tableId?: string, props?: Record<string, unknown>, children?: unknown[] }} GuardObject
 * @typedef {{ index: number, path: string, suggestion?: string|null, message: string, hint: string }} GuardError
 * @typedef {import('./dataTools').DataTable} DataTable
 */
