/** @typedef {import('express-serve-static-core').NextFunction} NextFunction */
// @typecheck strict
/**
 * The tables a run produced, as the run page shows them:
 *
 *   GET /runs/:runId/tables/:tableId?offset=0&limit=50   one page of rows
 *   GET /runs/:runId/tables/:tableId/csv                 the whole table as CSV
 *
 * They read the table ledger (stores/automationStore/runTables.js) and nothing
 * else: no new bearer path, no signed URL. The credential is the one every other
 * run read uses (routes/automation/runJourney.js), and a table is only looked up
 * THROUGH the runs of the journey the caller may read, so an id from another
 * run, another automation or another organisation resolves to nothing.
 *
 * Answers:
 *   400  `invalid_page`: offset or limit is not a whole number in range
 *   404  the run does not exist, the caller has no role on its automation, the
 *        table is not one of this journey's, it expired, or its bytes are gone
 *   403  the caller is on the automation but may not read this run, or the run
 *        used the starter's own connections (`caller_run_private`)
 *
 * The CSV is an attachment with `X-Content-Type-Options: nosniff`; it is never
 * served inline. Text cells that a spreadsheet would run as a formula get a
 * leading apostrophe.
 */

'use strict';

const express = require('express');
const log = require('../../telemetry/log');
const { HttpError } = require('../../core/http/errors');
const { contentDisposition } = require('../../core/http/contentDisposition');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { TABLE_ID_RE } = require('../../core/automationRunner/tables/handle');
const { tableRouterDeps } = require('./tableRouterDeps');

const WHOLE_NUMBER = /^\d{1,12}$/;
const notFound = () => new HttpError(404, 'run_table_not_found', 'Not found');

/**
 * A storage miss: the reaper deletes bytes before rows, so a live row without bytes is a normal race.
 * @param {{ name?: string, code?: string } | null | undefined} e
 */
function isMissingObject(e) {
    return !!e && (e.name === 'NoSuchKey' || e.code === 'ENOENT' || e.code === 'NoSuchKey');
}

/**
 * A name for the download: no path, quote or control characters.
 * @param {string} name
 */
function csvFileName(name) {
    const { safeDocumentName } = require('../../core/automationRunner/execDocument');
    return `${safeDocumentName(name, 'table')}.csv`;
}

/**
 * Page parameters, or an HttpError 400.
 * @param {import('express').Request['query']} query
 * @param {ReturnType<typeof import('../../core/automationRunner/tables/limits').tableLimits>} limits
 */
function pageParams(query, limits) {
    const rawOffset = query.offset == null ? '0' : String(query.offset);
    const rawLimit = query.limit == null ? '50' : String(query.limit);
    if (!WHOLE_NUMBER.test(rawOffset)) throw new HttpError(400, 'invalid_page', 'offset must be a whole number of 0 or more');
    if (!WHOLE_NUMBER.test(rawLimit)) throw new HttpError(400, 'invalid_page', 'limit must be a whole number of 1 or more');
    const offset = Number(rawOffset);
    const limit = Number(rawLimit);
    const max = limits.pageMaxRows;
    if (limit < 1 || (max > 0 && limit > max)) {
        throw new HttpError(400, 'invalid_page', max > 0 ? `limit must be between 1 and ${max}` : 'limit must be 1 or more');
    }
    return { offset, limit };
}

/**
 * @param {object} [overrides]
 * @param {any}   [overrides.store]       automationStore surface; typed, its nullable rows do not fit RunTableRow
 * @param {Pick<typeof import('../../core/automationRunner/tables/tableStore'), 'readTablePage'|'streamTableCsv'>} [overrides.tableStore]
 * @param {typeof import('../../stores/storageStore')} [overrides.storage]  unused by the routes themselves; kept so a test can name the seam
 * @param {() => ReturnType<typeof import('../../core/automationRunner/tables/limits').tableLimits>} [overrides.limits]
 * @param {(id: string) => Promise<any>} [overrides.getUser]
 * @param {(userId: string, permission: string, session?: any) => Promise<boolean>} [overrides.hasPermission]
 */
function makeRunTablesRouter(overrides = {}) {
    const router = express.Router();
    const { store, tables, limitsNow, journey } = tableRouterDeps(overrides);

    /**
     * The ledger row for this request, or null after a 403 was written; 404 for every other miss.
     * @param {import('express').Request<{ runId: string, tableId: string }>} req
     * @param {import('express').Response} res
     */
    async function openRow(req, res) {
        // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- TABLE_ID_RE is anchored and fixed length: linear
        if (!TABLE_ID_RE.test(String(req.params.tableId))) throw notFound();
        const found = await journey(req, res, req.params.runId);
        if (!found) return null;
        const row = await store().getRunTableForRuns(req.params.tableId, found.runIds);
        if (!row || row.automationId !== found.run.automationId) throw notFound();
        return row;
    }

    router.get('/runs/:runId/tables/:tableId', async (req, res) => {
        const { offset, limit } = pageParams(req.query, limitsNow());
        const row = await openRow(req, res);
        if (!row) return undefined;
        let page;
        try {
            page = await tables().readTablePage(row, { offset, limit });
        } catch (e) {
            if (isMissingObject(e)) {
                log.warn(`[automation/runTables] table ${row.id} has no bytes: ${e.message}`);
                throw notFound();
            }
            if (e && e.errorClass === 'table_too_large') {
                throw new HttpError(413, 'run_table_too_large', 'This table is too large to read here.');
            }
            throw e;
        }
        res.setHeader('Cache-Control', 'private, no-store');
        return res.json({
            tableId: row.id,
            name: row.name,
            runId: row.runId,
            columns: page.columns,
            rowCount: row.rowCount,
            offset: page.offset,
            limit: page.limit,
            rows: page.rows,
            hasMore: page.hasMore,
            expiresAt: row.expiresAt,
        });
    });

    // Read fresh on every request, so changing the variable needs no restart.
    /** @type {{ rpm: number, run: ReturnType<typeof perUserRateLimit> } | null} */
    let limiter = null;
    /**
     * @type {import('express').RequestHandler}
     * @param {NextFunction} next
     */
    const csvLimiter = (req, res, next) => {
        const rpm = limitsNow().csvRpm;
        if (rpm <= 0) return next();
        if (!limiter || limiter.rpm !== rpm) limiter = { rpm, run: perUserRateLimit({ windowMs: 60_000, max: rpm }) };

        return limiter.run(req, res, next);
    };

    router.get('/runs/:runId/tables/:tableId/csv', csvLimiter, async (/** @type {import('express').Request<{ runId: string, tableId: string }>} */ req, res) => {
        const row = await openRow(req, res);
        if (!row) return undefined;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', contentDisposition(csvFileName(row.name)));
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'private, no-store');
        try {
            await tables().streamTableCsv(row, res);
        } catch (e) {
            // Once bytes went out the response is already a failed download.
            if (res.headersSent) return undefined;
            for (const h of ['Content-Type', 'Content-Disposition']) res.removeHeader(h);
            if (isMissingObject(e)) throw notFound();
            throw e;
        }
        return undefined;
    });

    return router;
}

module.exports = { makeRunTablesRouter, pageParams, csvFileName };
