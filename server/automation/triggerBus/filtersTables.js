// @typecheck noImplicitAny
'use strict';

const { containsCI } = require('./matchUtil');

/** nextcloud tables.row.* filter, split out of filters.js (file size ceiling). */

/**
 * @param {{ tableId?: unknown, actor?: unknown, values?: Record<string, unknown>, previousValues?: Record<string, unknown> | null, [k: string]: unknown } | null | undefined} payload
 * @param {{ tableId?: unknown, actorEquals?: unknown, columnId?: unknown, valueEquals?: unknown, valueContains?: unknown, changedOnly?: boolean, [k: string]: unknown } | null | undefined} filter
 */
function matchNextcloudTablesRowFilter(payload, filter) {
    if (!filter) return true;
    if (filter.tableId !== undefined && filter.tableId !== null && filter.tableId !== ''
        && String(payload.tableId) !== String(filter.tableId)) return false;
    if (filter.actorEquals && payload.actor !== filter.actorEquals) return false;
    // Values are keyed by numeric column id in the event payload (the webhook
    // envelope has no column titles), so a value filter names the column id.
    // Without a columnId the value filters are not skipped (that fired on every
    // row): they hold when ANY column satisfies them. A null/'' value filter is
    // unset, like an empty columnId.
    const set = (/** @type {unknown} */ v) => v !== undefined && v !== null && v !== '';
    const hasCol = set(filter.columnId);
    const wantsEquals = set(filter.valueEquals);
    const wantsContains = set(filter.valueContains);
    if (hasCol || wantsEquals || wantsContains || filter.changedOnly) {
        const values = payload?.values && typeof payload.values === 'object' ? payload.values : {};
        const prevs = payload?.previousValues && typeof payload.previousValues === 'object' ? payload.previousValues : null;
        /**
         * @param {string} col
         */
        const colOk = (col) => {
            const value = values[col];
            if (wantsEquals && String(value ?? '') !== String(filter.valueEquals)) return false;
            if (wantsContains && !containsCI(String(value ?? ''), String(filter.valueContains))) return false;
            // "Only when this column actually changed" — the whole point of
            // watching a status column rather than every edit to the row.
            if (filter.changedOnly && prevs && String(prevs[col] ?? '') === String(value ?? '')) return false;
            return true;
        };
        if (hasCol) {
            if (!colOk(String(filter.columnId))) return false;
        } else if (wantsEquals || wantsContains || (filter.changedOnly && prevs)) {
            // changedOnly alone with no previousValues (e.g. a deleted row) passes as before.
            if (!Object.keys(values).some(colOk)) return false;
        }
    }
    return true;
}

module.exports = { matchNextcloudTablesRowFilter };
