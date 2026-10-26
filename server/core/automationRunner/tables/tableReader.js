// @typecheck strict
/**
 * Reading a stored table: authorisation (`openTable`), one page of rows and the
 * CSV export. Rows stream; nothing here loads a whole table.
 *
 * A table id alone is never a capability. `openTable` allows a read only when
 * the producing run is part of the caller's own journey, or when it belongs to
 * the same automation and the caller may read that run's data (a caller-private
 * run keeps its tables from everybody else).
 */

'use strict';

const zlib = require('zlib');
const { StringDecoder } = require('string_decoder');
const { once } = require('events');
const log = require('../../../telemetry/log');
const { tableLimits, exceeds } = require('./limits');
const { TABLE_ID_RE } = require('./handle');
const { parseRowLine } = require('./tableCodec');
const { canReadRunData } = require('../../automationModel/callerRunVisibility');
const { formulaShaped } = require('../../dataEngine/sources/spreadsheetFile/cells');
const { quoteField } = require('../../dataEngine/sources/spreadsheetFile/formats/csv');
const { bestEffort, fallback } = require('../../../utils/bestEffort');

const CSV_BOM = '\uFEFF';
const CSV_FLUSH_CHARS = 64 * 1024;

/**
 * @param {string} message
 * @param {string} errorClass
 */
function tableError(message, errorClass) {
    return Object.assign(new Error(message), { errorClass });
}

/**
 * The decompressed lines of a stored table, as strings. Aborts past `maxBytes`
 * of decompressed text (a gzip bomb cannot outgrow the cap) and releases the
 * storage stream when the consumer stops early.
 * @param {{ stream: import('stream').Readable }} streamed
 * @param {number} maxBytes
 */
async function* storedLines(streamed, maxBytes) {
    const source = streamed.stream;
    const gunzip = zlib.createGunzip();
    source.on('error', (e) => gunzip.destroy(e));
    source.pipe(gunzip);
    const decoder = new StringDecoder('utf8');
    let total = 0;
    let carry = '';
    try {
        for await (const chunk of gunzip) {
            total += chunk.length;
            if (exceeds(total, maxBytes)) {
                throw tableError(`The stored table is larger than ${Math.round(maxBytes / 1048576)} MB.`, 'table_too_large');
            }
            carry += decoder.write(chunk);
            let nl = carry.indexOf('\n');
            while (nl !== -1) {
                const line = carry.slice(0, nl);
                carry = carry.slice(nl + 1);
                if (line) yield line;
                nl = carry.indexOf('\n');
            }
        }
        carry += decoder.end();
        if (carry) yield carry;
    } finally {
        gunzip.destroy();
        source.destroy?.();
    }
}

/**
 * Write one chunk, waiting for the drain; false when the other side is gone.
 * @param {import('stream').Writable} writable
 * @param {string} chunk
 */
async function writeChunk(writable, chunk) {
    if (writable.destroyed || writable.writableEnded) return false;
    if (writable.write(chunk)) return true;
    const closed = once(writable, 'close').then(() => false);
    const drained = once(writable, 'drain').then(() => true);
    // A listener left behind by the loser must not hold the promise chain open.
    closed.catch((e) => bestEffort('core/automationRunner/tables/tableReader:writeChunk', e));
    drained.catch((e) => bestEffort('core/automationRunner/tables/tableReader:writeChunk#2', e));
    return Promise.race([drained, closed]);
}

/**
 * One CSV cell: text, with a formula-shaped string made harmless.
 * @param {unknown} value
 */
function csvCell(value) {
    if (value == null) return '';
    if (typeof value === 'string') {
        const text = formulaShaped(value, 'text') ? `'${value}` : value;
        return quoteField(text, ',');
    }
    return quoteField(String(value), ',');
}

/**
 * @param {{ store?: any, storage?: any, journeyRunIds?: Function, limits?: () => ReturnType<typeof tableLimits> }} [deps]
 */
function makeTableReader(deps = {}) {
    const store = () => deps.store || require('../../../stores/automationStore');
    const storage = () => deps.storage || require('../../../stores/storageStore');
    /**
     * @param {{ runId: string; rootRunId: string | undefined; }} scope
     */
    const journeyIds = (scope) => (deps.journeyRunIds || require('../generatedFileHandle').journeyRunIds)(scope);
    const limitsNow = () => (deps.limits ? deps.limits() : tableLimits());

    /** @typedef {{ id: string, runId: string, storageKey: string, columns: Array<{ key: string, label?: string }> }} RunTableRow */

    /** The rows of a ledger row, as a re-iterable factory: each call opens a fresh stream. @param {RunTableRow} row */
    function rowsOf(row) {
        const keys = row.columns.map(c => c.key);
        return async function* rows() {
            const streamed = await storage().streamFile(row.storageKey);
            let first = true;
            for await (const line of storedLines(streamed, limitsNow().maxBytes)) {
                if (first) { first = false; continue; }
                yield parseRowLine(line, keys);
            }
        };
    }

    /**
     * May this caller read a table written by `producingRunId`?
     * @param {RunTableRow} row
     * @param {{ runId: string; rootRunId?: string; automationId: string; userId?: string; }} scope
     */
    async function mayRead(row, scope) {
        const ids = await journeyIds({ runId: scope.runId, rootRunId: scope.rootRunId });
        if (ids.includes(row.runId)) return true;
        const [producing, current] = await Promise.all([
            store().getRun(row.runId).catch((/** @type {unknown} */ e) => fallback('core/automationRunner/tables/tableReader:mayRead', e, null)),
            store().getRun(scope.runId).catch((/** @type {unknown} */ e) => fallback('core/automationRunner/tables/tableReader:mayRead#2', e, null)),
        ]);
        if (!producing) return false;
        const viewer = (current && current.startedByUserId) || scope.userId;
        return canReadRunData(producing, viewer);
    }

    /**
     * @param {string|{tableId?: string}} handleOrTableId
     * @param {{runId: string, rootRunId?: string, automationId: string, userId?: string}} scope
     */
    async function openTable(handleOrTableId, scope) {
        if (!scope || !scope.runId) {
            throw tableError('A table handle can only be used inside an automation run: the table belongs to that run.', 'handle_scope_missing');
        }
        const id = typeof handleOrTableId === 'string' ? handleOrTableId : handleOrTableId && handleOrTableId.tableId;
        if (typeof id !== 'string' || !TABLE_ID_RE.test(id)) return null;
        const row = await store().getRunTableForAutomation(id, scope.automationId);
        if (!row) return null;
        if (!await mayRead(row, scope)) return null;
        return { row, columns: row.columns, rows: rowsOf(row) };
    }

    /**
     * One page of an already authorised table. Streams and stops at
     * offset + limit + 1, so a page near the top of a big table reads little.
     * @param {RunTableRow} row
     * @param {{ offset?: number, limit?: number }} [page]
     */
    async function readTablePage(row, { offset = 0, limit = 50 } = {}) {
        /** @type {Record<string, unknown>[]} */
        const out = [];
        let seen = 0;
        let hasMore = false;
        const iterator = rowsOf(row)();
        try {
            for await (const r of iterator) {
                if (seen >= offset + limit) { hasMore = true; break; }
                if (seen >= offset) out.push(r);
                seen += 1;
            }
        } finally {
            await iterator.return?.();
        }
        return { columns: row.columns, rows: out, offset, limit, hasMore };
    }

    /**
     * Stream an already authorised table as CSV: BOM, header of labels, rows.
     * @param {RunTableRow} row
     * @param {import('stream').Writable} writable
     */
    async function streamTableCsv(row, writable) {
        const iterator = rowsOf(row)();
        let wrote = false;
        try {
            let buf = CSV_BOM + row.columns.map(c => csvCell(c.label)).join(',') + '\r\n';
            for await (const r of iterator) {
                buf += row.columns.map(c => csvCell(r[c.key])).join(',') + '\r\n';
                if (buf.length >= CSV_FLUSH_CHARS) {
                    wrote = true;
                    if (!await writeChunk(writable, buf)) return false;
                    buf = '';
                }
            }
            wrote = true;
            if (buf && !await writeChunk(writable, buf)) return false;
            if (!writable.destroyed) writable.end();
            return true;
        } catch (e) {
            log.warn(`[tables] csv export of ${row.id} failed: ${/** @type {Error} */ (e).message}`);
            // Nothing written yet: the caller can still answer with a clean error.
            // Otherwise the download is already torn, so end it as a failure.
            if (wrote && !writable.destroyed) writable.destroy(e);
            throw e;
        } finally {
            await iterator.return?.();
        }
    }

    return { openTable, readTablePage, streamTableCsv, rowsOf };
}

module.exports = { makeTableReader, storedLines, csvCell };
