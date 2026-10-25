// @typecheck strict
/**
 * The table store: write a table to storage, open one by handle, read a page,
 * export CSV. The writer and the reader live in their own files; this one is
 * the surface the steps and routes import.
 *
 *   writeTable({ ctx, stepId, name, columns, rows, ttlDays, provenance }) -> TableHandle
 *   openTable(handleOrTableId, scope) -> { row, columns, rows: () => AsyncIterable } | null
 *   readTablePage(row, { offset, limit }) -> { columns, rows, offset, limit, hasMore }
 *   streamTableCsv(row, writable)
 *
 * `makeTableStore(deps)` builds the same surface over injected dependencies
 * (store, storage, journeyRunIds, limits), which is how the tests run it.
 */

'use strict';

const { makeTableWriter } = require('./tableWriter');
const { makeTableReader } = require('./tableReader');

function makeTableStore(deps = {}) {
    return { ...makeTableWriter(deps), ...makeTableReader(deps) };
}

const defaults = makeTableStore();

module.exports = {
    makeTableStore,
    writeTable: defaults.writeTable,
    openTable: defaults.openTable,
    readTablePage: defaults.readTablePage,
    streamTableCsv: defaults.streamTableCsv,
    rowsOf: defaults.rowsOf,
};
