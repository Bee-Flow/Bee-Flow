// @typecheck noImplicitAny
'use strict';
const { fallback } = require('../utils/bestEffort');

/**
 * Cell values of Nextcloud Tables, both directions.
 *
 * The Tables API stores a single selection as the option ID, a multi selection
 * as a list of ids, a check as the string "true"/"false", and silently turns a
 * value it cannot parse into null. Agents and automations speak labels,
 * booleans and numbers, so a write has to be translated, and a value that
 * cannot be translated has to fail loudly: a row that quietly lost a cell looks
 * exactly like a row that was stored.
 */

/**
 * @typedef {{ id: number|string, label: string }} SelectionOption
 * @typedef {{ id?: number|string, title?: string, type?: string, subtype?: string|null,
 *   selectionOptions?: unknown, numberDecimals?: number|null }} TablesColumn
 * @typedef {{ id?: number, title?: string, emoji?: string, ownership?: string, isShared?: boolean,
 *   archived?: boolean, rowsCount?: number, columns?: unknown[], columnsCount?: number }} RawTablesTable
 * @typedef {{ id?: number, title?: string, type?: string, subtype?: string, mandatory?: boolean,
 *   description?: string, selectionOptions?: unknown, numberDecimals?: number, orderWeight?: number,
 *   selectionDefault?: unknown, numberPrefix?: string, numberSuffix?: string, datetimeDefault?: unknown,
 *   customSettings?: Record<string, unknown> }} RawTablesColumn
 * @typedef {{ id: number, title: string, type: string, subtype: string|null, mandatory: boolean,
 *   description: string, selectionOptions?: SelectionOption[], numberDecimals?: number }} MappedColumn
 */

/**
 * The options of a selection column. The API hands them over as a JSON string
 * or as a list, depending on the release.
 * @param {unknown} raw
 * @returns {SelectionOption[]}
 */

function parseSelectionOptions(raw) {
    let list = [];
    if (Array.isArray(raw)) list = raw;
    else if (typeof raw === 'string' && raw.trim()) {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) list = parsed;
        } catch (err) { fallback('integrations/nextcloudTablesValues:parseSelectionOptions', err); /* not a list: no options */ }
    }
    return list
        .filter(o => o && typeof o === 'object' && o.id !== undefined && o.id !== null)
        .map(o => ({ id: o.id, label: String(o.label ?? '') }));
}

/** @param {TablesColumn} col @returns {'single'|'multi'|'check'|'number'|'datetime'|'other'} */
function columnKind(col) {
    if (col.type === 'selection') {
        if (col.subtype === 'check') return 'check';
        return col.subtype === 'multi' ? 'multi' : 'single';
    }
    if (col.type === 'number') return 'number';
    if (col.type === 'datetime') return 'datetime';
    return 'other';
}

const isBlank = (/** @type {unknown} */ v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/** @param {TablesColumn} col @param {unknown} item @returns {{ id: number|string }|{ error: string }} */
function optionId(col, item) {
    const options = parseSelectionOptions(col.selectionOptions);
    if (!options.length) {
        // Without a known option list a label cannot be translated; an id can go through.
        if (typeof item === 'number' || /^\d+$/.test(String(item).trim())) return { id: /** @type {number|string} */ (item) };
        return { error: `Column "${col.title}" has no known options, so "${String(item)}" cannot be translated to an option id. Pass the numeric option id.` };
    }
    const text = String(item).trim().toLowerCase();
    const byLabel = options.find(o => o.label.trim().toLowerCase() === text);
    if (byLabel) return { id: byLabel.id };
    if (typeof item === 'number' || /^\d+$/.test(text)) {
        const byId = options.find(o => String(o.id) === text);
        if (byId) return { id: byId.id };
    }
    const names = options.map(o => `"${o.label}"`).join(', ') || '(no options defined)';
    return { error: `"${String(item)}" is not an option of column "${col.title}". Options: ${names}.` };
}

/**
 * Translate one caller value to the wire value of its column.
 * @param {TablesColumn} col
 * @param {unknown} value
 * @returns {{ value: unknown } | { error: string }}
 */
function toWireValue(col, value) {
    const kind = columnKind(col);
    if (kind === 'other') return { value };
    if (kind === 'check') {
        if (isBlank(value)) return { value: 'false' };
        if (typeof value === 'boolean') return { value: String(value) };
        const t = String(value).trim().toLowerCase();
        if (['true', 'yes', '1'].includes(t)) return { value: 'true' };
        if (['false', 'no', '0'].includes(t)) return { value: 'false' };
        return { error: `"${String(value)}" is not a yes/no value for checkbox column "${col.title}" (use true or false).` };
    }
    if (isBlank(value)) return { value: null };
    if (kind === 'single') {
        const hit = optionId(col, value);
        return 'error' in hit ? hit : { value: hit.id };
    }
    if (kind === 'multi') {
        const items = Array.isArray(value) ? value : String(value).split(',');
        /** @type {(string | number)[]} */
        const ids = [];
        for (const item of items) {
            const hit = optionId(col, item);
            if ('error' in hit) return hit;
            ids.push(hit.id);
        }
        return { value: ids };
    }
    if (kind === 'number') {
        const n = typeof value === 'number' ? value : Number(String(value).trim());
        if (!Number.isFinite(n)) return { error: `"${String(value)}" is not a number, so it cannot go in number column "${col.title}".` };
        return { value: n };
    }
    // datetime: the API nulls what it cannot parse, so refuse it here.
    if (col.subtype === 'time') {
        if (typeof value === 'string' && /^\d{1,2}:\d{2}(:\d{2})?$/.test(value.trim())) return { value: value.trim() };
        return { error: `"${String(value)}" is not a time for column "${col.title}" (use e.g. 14:30).` };
    }
    // Date.parse alone accepts things like "Sept 5" or "1"; require the ISO date start.
    if (typeof value !== 'string' || !/^\d{4}-/.test(value.trim()) || Number.isNaN(Date.parse(value))) {
        return { error: `"${String(value)}" is not a date for column "${col.title}" (use e.g. 2026-09-19 or 2026-09-19 14:30).` };
    }
    return { value };
}

/**
 * Translate a stored value to what a caller reads: labels instead of option
 * ids, a boolean instead of "true"/"false".
 * @param {TablesColumn} col
 * @param {unknown} value
 */
function fromWireValue(col, value) {
    const kind = columnKind(col);
    if (kind === 'check') {
        if (value === true || value === 'true') return true;
        if (value === false || value === 'false') return false;
        return value;
    }
    if (kind !== 'single' && kind !== 'multi') return value;
    if (isBlank(value)) return value;
    const options = parseSelectionOptions(col.selectionOptions);
    const labelOf = (/** @type {unknown} */ id) => options.find(o => String(o.id) === String(id))?.label ?? id;
    if (kind === 'single') return labelOf(value);
    let ids = value;
    if (typeof value === 'string') {
        try { ids = JSON.parse(value); } catch { ids = [value]; }
    }
    return Array.isArray(ids) ? ids.map(labelOf) : labelOf(ids);
}

/** @param {RawTablesTable} t */
function mapTable(t) {
    return {
        id: t.id,
        title: t.title,
        emoji: t.emoji || null,
        ownership: t.ownership,
        isShared: !!t.isShared,
        archived: !!t.archived,
        rowsCount: t.rowsCount ?? null,
        columnsCount: Array.isArray(t.columns) ? t.columns.length : (t.columnsCount ?? null),
    };
}

/** @param {RawTablesColumn} c @returns {MappedColumn} */
function mapColumn(c) {
    /** @type {MappedColumn} */
    const out = {
        id: c.id,
        title: c.title,
        type: c.type,
        subtype: c.subtype || null,
        mandatory: !!c.mandatory,
        description: c.description || '',
    };
    // What a row write needs to translate labels and keep decimals.
    if (c.type === 'selection' && c.subtype !== 'check') out.selectionOptions = parseSelectionOptions(c.selectionOptions);
    if (c.type === 'number') out.numberDecimals = Number.isFinite(c.numberDecimals) ? c.numberDecimals : 0;
    return out;
}

/**
 * The FULL column object, for a caller that has to reproduce the column
 * rather than describe it to a model: the mirror engine
 * (core/dataEngine/sources/nextcloudTable) needs the selection options to
 * translate ids to labels, the mandatory flag, and — on a Tables release that
 * has them — the relation settings. `mapColumn` above stays the slim agent
 * view; this one parses what the API hands over as JSON-in-a-string.
 */
/** @param {RawTablesColumn} c */
function describeColumn(c) {
    return {
        ...mapColumn(c),
        orderWeight: Number.isFinite(c.orderWeight) ? c.orderWeight : 0,
        selectionOptions: parseSelectionOptions(c.selectionOptions),
        selectionDefault: c.selectionDefault ?? null,
        numberDecimals: Number.isFinite(c.numberDecimals) ? c.numberDecimals : null,
        numberPrefix: c.numberPrefix || '',
        numberSuffix: c.numberSuffix || '',
        datetimeDefault: c.datetimeDefault ?? null,
        customSettings: (c.customSettings && typeof c.customSettings === 'object') ? c.customSettings : {},
    };
}

module.exports = { mapTable, mapColumn, describeColumn, parseSelectionOptions, columnKind, toWireValue, fromWireValue };
