// @typecheck
/**
 * Writing a table to Bee Flow's own storage.
 *
 * The rows stream through gzip into a temp file (never all in memory), the file
 * goes up under a key that belongs to this table alone, and a row in the table
 * ledger makes it readable. The key is never content-addressed: the reaper
 * deletes a blob when its row expires, and a shared blob would vanish under a
 * second table that still needs it.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const log = require('../../../telemetry/log');
const { tableLimits, exceeds } = require('./limits');
const { buildHandle } = require('./handle');
const { headerLine, rowLine } = require('./tableCodec');
const { DOCUMENT_TTL_MIN_DAYS, DOCUMENT_TTL_MAX_DAYS, DOCUMENT_TTL_DEFAULT_DAYS } = require('../execDocument');
const { bestEffort } = require('../../../utils/bestEffort');

const DAY_MS = 86_400_000;
const FLUSH_CHARS = 64 * 1024;

function tableError(message, errorClass) {
    return Object.assign(new Error(message), { errorClass });
}

function clampTtlDays(ttlDays) {
    const days = Math.round(Number(ttlDays) || DOCUMENT_TTL_DEFAULT_DAYS);
    return Math.min(DOCUMENT_TTL_MAX_DAYS, Math.max(DOCUMENT_TTL_MIN_DAYS, days));
}

/**
 * @param {{ store?: any, storage?: any, limits?: () => ReturnType<typeof tableLimits> }} [deps]
 */
function makeTableWriter(deps = {}) {
    const store = () => deps.store || require('../../../stores/automationStore');
    const storage = () => deps.storage || require('../../../stores/storageStore');
    const limitsNow = () => (deps.limits ? deps.limits() : tableLimits());

    /**
     * @param {{ ctx: {userId: string, automationId: string, runId: string},
     *   stepId?: string|null, name: string, columns: Array<{key: string, label: string, type: string}>,
     *   rows: Iterable<any>|AsyncIterable<any>, ttlDays?: number, provenance?: Record<string,string>|null }} args
     */
    async function writeTable({ ctx, stepId = null, name, columns, rows, ttlDays, provenance = null }) {
        const limits = limitsNow();
        const cols = Array.isArray(columns) ? columns : [];
        if (exceeds(cols.length, limits.maxColumns)) {
            throw tableError(`The table has ${cols.length} columns; the limit is ${limits.maxColumns}.`, 'table_too_many_columns');
        }
        if (!storage().isAvailable()) {
            throw tableError('Table storage is not available on this server.', 'storage_unavailable');
        }
        if (limits.maxTablesPerRun > 0 && await store().countRunTablesForRun(ctx.runId) >= limits.maxTablesPerRun) {
            throw tableError(`This run already wrote ${limits.maxTablesPerRun} tables; the limit is reached.`, 'table_limit_per_run');
        }

        const idHex = crypto.randomBytes(16).toString('hex');
        const tableId = `rtb_${idHex}`;
        const key = storage().buildAutomationFileKey(ctx.userId, ctx.automationId, `table-${crypto.randomBytes(16).toString('hex')}`);
        const keys = cols.map(c => c.key);
        const previewKeep = limits.previewRows > 0 ? limits.previewRows : 0;

        const sample = [];
        let rowCount = 0;
        let rawBytes = 0;

        async function* lines() {
            const head = headerLine(cols);
            rawBytes += Buffer.byteLength(head);
            let buf = head;
            for await (const row of rows) {
                rowCount += 1;
                if (exceeds(rowCount, limits.maxRows)) {
                    throw tableError(`The table has more than ${limits.maxRows} rows, which is the limit.`, 'table_too_large');
                }
                if (sample.length < previewKeep) sample.push(row);
                const line = rowLine(row, keys);
                rawBytes += Buffer.byteLength(line);
                if (exceeds(rawBytes, limits.maxBytes)) {
                    throw tableError(`The table is larger than ${Math.round(limits.maxBytes / 1048576)} MB; the limit is ${Math.round(limits.maxBytes / 1048576)} MB.`, 'table_too_large');
                }
                buf += line;
                if (buf.length >= FLUSH_CHARS) { yield buf; buf = ''; }
            }
            if (buf) yield buf;
        }

        const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bf-table-'));
        const tmpPath = path.join(dir, 'table.jsonl.gz');
        let uploaded = false;
        try {
            await pipeline(Readable.from(lines()), zlib.createGzip(), fs.createWriteStream(tmpPath));
            const { size } = await fs.promises.stat(tmpPath);
            try {
                await storage().uploadFileFromPath(key, tmpPath, 'application/gzip');
            } catch (e) {
                log.warn(`[tables] upload failed: ${e.message}`);
                throw tableError('The table could not be saved to storage.', 'storage_unavailable');
            }
            uploaded = true;
            const days = clampTtlDays(ttlDays);
            const ttlMs = days * DAY_MS;
            await store().recordRunTable({
                id: tableId, runId: ctx.runId, automationId: ctx.automationId, stepId,
                storageKey: key, name, columns: cols, rowCount, size, ttlMs,
            });
            return buildHandle({
                tableId, runId: ctx.runId, name, columns: cols, rowCount, rows: sample,
                expiresAt: new Date(Date.now() + ttlMs), provenance, previewRows: limits.previewRows,
            });
        } catch (e) {
            // A blob with no row is unreachable garbage: remove it now.
            if (uploaded) await storage().deleteFile(key).catch((e) => bestEffort('core/automationRunner/tables/tableWriter:writeTable', e));
            throw e;
        } finally {
            await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
    }

    return { writeTable };
}

module.exports = { makeTableWriter, clampTtlDays };
