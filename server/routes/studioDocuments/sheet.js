// @typecheck
/**
 * Spreadsheet documents (docType 'spreadsheet'). Mounted by
 * routes/studioDocuments.js under /api/studio-documents.
 *
 *   POST  /sheets             { name?, folderId? }  → 201 { document }   start one
 *   GET   /:id/sheet          → { columns, rows, cells: { A1: raw }, readOnly }
 *   PATCH /:id/sheet          { cells: { B3: '12', C3: '=SUM(B1:B3)', D4: '' } } → { ok, cells }
 *   GET   /:id/sheet.csv      the computed values, as a CSV download
 *   POST  /:id/sheet/assistant  { message, selection?, history?, modelTier? }
 *                             → { reply, changes: { B2: { before, after } }, tier }
 *                             the spreadsheet assistant (core/documents/sheetAssist):
 *                             reads and changes the sheet, the changes already saved
 *   (and `duplicateSheet`, which POST /:id/duplicate hands a spreadsheet to)
 *
 * The cells live in a datatable owned by the document's owner
 * (core/documents/sheetCells.js). WHO may read or change them is the
 * document's question, answered by documentStore.getDocument exactly as for
 * any other document: the owner, or a member of the project it is filed in
 * (a project viewer reads, an editor also writes).
 *
 * STARTING a spreadsheet makes a datatable, so it sits behind the datatables
 * gates (sheetGate.js); a reader who does not pass them is not offered the
 * type either (`sheetsVisible`, asked by the library list). Reading and
 * editing an existing sheet does not ask again, like the datatables rows
 * routes themselves (their "drain exemption"): a plan that lapses must not
 * lock people out of what they wrote.
 *
 * A FACTORY: `makeSheetRouter(deps)`; the default export is over the real modules.
 */

'use strict';

const express = require('express');
const { validate } = require('../../core/http/validate');
const { HttpError, notFound, forbidden } = require('../../core/http/errors');
const { z, worded, bodyOf } = require('../../core/http/schemaParts');

const NAME_TEXT = 'name is the spreadsheet\'s name, at most 200 characters.';
const CreateBody = bodyOf({
    name: worded(NAME_TEXT).max(200, NAME_TEXT).optional(),
    folderId: worded('folderId is the id of one of your document folders.').max(200).nullable().optional(),
}, 'Starting a spreadsheet');
const CELLS_TEXT = 'cells maps a cell such as "B3" to what is typed in it ("" clears it).';
const DEPTHS = ['auto', 'fast', 'thinking', 'pro', 'deep_thinking'];
const ROLE_TEXT = 'history is the earlier turns: { role: user|assistant, content }.';
const AssistantBody = bodyOf({
    message: worded('Say what the assistant should do.').trim().min(1, 'Say what the assistant should do.').max(4000, 'Keep the request under 4,000 characters.'),
    selection: worded('selection is a cell or range such as B2:D9.').max(20).nullable().optional(),
    modelTier: z.enum(/** @type {[string, ...string[]]} */ (DEPTHS), { errorMap: () => ({ message: `modelTier is one of ${DEPTHS.join(', ')}.` }) }).optional(),
    history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) }), { invalid_type_error: ROLE_TEXT }).max(20).optional(),
}, 'Asking the spreadsheet assistant');
const WriteBody = bodyOf({
    cells: z.record(z.union([z.string(), z.null()]), { required_error: CELLS_TEXT, invalid_type_error: CELLS_TEXT }),
}, 'Changing cells');

/**
 * The document store and the datatable runtime refuse with an Error carrying
 * `status` and a code (`errorClass` / `code`); the terminal error handler only
 * passes a code on for an HttpError. Said again as one, so the editor can tell
 * "read only" from "busy" from "too large" by code.
 *
 * @param {any} e
 */
function asHttp(e) {
    if (!e || e instanceof HttpError || !(Number(e.status) >= 400 && Number(e.status) < 500)) return e;
    const code = e.errorClass || (typeof e.code === 'string' ? e.code : 'sheet_refused');
    return new HttpError(Number(e.status), code, e.message);
}

/** Wrap a handler so whatever it throws reaches the terminal handler in that shape. */
const handle = (/** @type {Function} */ fn) => async (/** @type {any} */ req, /** @type {any} */ res) => {
    try { await fn(req, res); } catch (e) { throw asHttp(e); }
};

/** One CSV field: quoted when it has to be, quotes doubled. */
function csvField(text) {
    const s = String(text ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The computed sheet as CSV: rows 1 … the last used row, columns A … the last
 * used column. Values as they show (formulas evaluated, errors as their code).
 *
 * @param {Record<string, string>} cells
 * @param {(cells: Record<string, string>) => Record<string, { display: string }>} evaluate
 */
function sheetCsv(cells, evaluate) {
    const shown = evaluate(cells);
    let lastRow = 0;
    let lastCol = -1;
    for (const name of Object.keys(cells)) {
        const m = /^([A-Z])(\d+)$/.exec(name);
        if (!m) continue;
        lastRow = Math.max(lastRow, Number(m[2]));
        lastCol = Math.max(lastCol, m[1].charCodeAt(0) - 65);
    }
    const lines = [];
    for (let r = 1; r <= lastRow; r++) {
        const fields = [];
        for (let c = 0; c <= lastCol; c++) fields.push(csvField(shown[`${String.fromCharCode(65 + c)}${r}`]?.display ?? ''));
        lines.push(fields.join(','));
    }
    return lines.join('\r\n') + (lines.length ? '\r\n' : '');
}

/** A safe download name. */
function fileNameOf(name) {
    return (String(name || 'spreadsheet').replace(/[^\p{L}\p{N} ._-]+/gu, '').trim().slice(0, 100) || 'spreadsheet') + '.csv';
}

/**
 * @param {object} [deps]
 * @param {any} [deps.documents]   stores/documentStore surface
 * @param {any} [deps.cells]       core/documents/sheetCells surface
 * @param {Function} [deps.gate]   the datatables gates as one middleware
 * @param {(cells: Record<string, string>) => any} [deps.evaluate]  shared/expr/sheet.mjs evaluateSheet
 * @param {Function} [deps.requireAuth]
 * @param {any} [deps.assistant]     core/documents/sheetAssist/sheetAssistant surface ({ ask })
 * @param {(orgId: string|null, userId: string) => Promise<string|null>} [deps.checkLimits]
 * @param {Function} [deps.assistantLimiter]
 */
function makeSheetRouter(deps = {}) {
    const router = express.Router({ mergeParams: true });
    const documents = () => deps.documents || require('../../stores/documentStore');
    const cells = () => deps.cells || require('../../core/documents/sheetCells');
    const evaluate = (/** @type {Record<string, string>} */ c) => (deps.evaluate || require('../../shared/expr/sheet.mjs').evaluateSheet)(c);
    const requireAuth = deps.requireAuth || ((req, res, next) => require('../../auth/permissions').requireAuth(req, res, next));
    /** @type {Function|null} */
    let boundGate = null;
    const gate = () => {
        if (!boundGate) boundGate = deps.gate || require('./sheetGate').makeSheetGate();
        return boundGate;
    };
    const requireSheets = (/** @type {any} */ req, /** @type {any} */ res, /** @type {Function} */ next) => gate()(req, res, next);
    const assistant = () => deps.assistant || require('../../core/documents/sheetAssist/sheetAssistant');
    const checkLimits = deps.checkLimits || ((orgId, userId) => require('../../core/entitlements/limits').checkSubscriptionLimits(orgId, 'chat', userId));
    // An answer is several model calls; this is well above a person working
    // with the panel and still stops a runaway loop.
    const assistantLimiter = deps.assistantLimiter || require('../../utils/perUserRateLimit')
        .perUserRateLimit({ windowMs: 60_000, max: 20, name: 'sheet-assistant' });

    /** The spreadsheet this reader may see, or a 404 (another type is not a sheet). */
    async function sheetFor(/** @type {any} */ req) {
        const doc = await documents().getDocument(req.params.id, req.session.user.id);
        if (!doc || doc.docType !== 'spreadsheet') throw notFound('sheet_not_found', 'Spreadsheet not found');
        const tableId = doc.settings?.sheet?.datatableId;
        if (typeof tableId !== 'string' || !tableId) throw new HttpError(410, 'sheet_table_missing', 'This spreadsheet has no table for its cells.');
        return { doc, tableId };
    }

    /**
     * Make the table, then the document; a document that cannot be made takes
     * its new, empty table with it.
     */
    async function startSheet(/** @type {any} */ req, { name, folderId = null, copyFrom = null }) {
        const userId = req.session.user.id;
        const table = await cells().createSheetTable({ ownerUserId: userId, name });
        try {
            if (copyFrom) await cells().copyCells(copyFrom.ownerUserId, copyFrom.tableId, table.id, userId);
            return await documents().createDocument({
                userId, name, docType: 'spreadsheet', kind: 'document', visibility: 'private', folderId,
                sheetTableId: table.id,
            });
        } catch (e) {
            await cells().dropSheetTable(userId, table.id).catch(() => undefined);
            throw e;
        }
    }

    router.post('/sheets', requireAuth, requireSheets, validate({ body: CreateBody }), handle(async (req, res) => {
        const name = (req.body.name || '').trim() || 'Untitled spreadsheet';
        res.status(201).json({ document: await startSheet(req, { name, folderId: req.body.folderId || null }) });
    }));

    router.get('/:id/sheet', requireAuth, handle(async (req, res) => {
        const { doc, tableId } = await sheetFor(req);
        const sheet = await cells().readSheet(doc.userId, tableId);
        res.json({ ...sheet, readOnly: doc.projectRole === 'viewer' });
    }));

    router.patch('/:id/sheet', requireAuth, validate({ body: WriteBody }), handle(async (req, res) => {
        const { doc, tableId } = await sheetFor(req);
        if (doc.projectRole === 'viewer') throw forbidden('document_read_only', 'You can read this spreadsheet, but only the project\'s editors can change it.');
        const saved = await cells().writeCells(doc.userId, tableId, req.body.cells);
        res.json({ ok: true, cells: saved.cells });
    }));

    router.get('/:id/sheet.csv', requireAuth, handle(async (req, res) => {
        const { doc, tableId } = await sheetFor(req);
        const { cells: raw } = await cells().readSheet(doc.userId, tableId);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${fileNameOf(doc.name)}"`);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        // A BOM so spreadsheet apps read the file as UTF-8.
        res.send('\uFEFF' + sheetCsv(raw, evaluate));
    }));

    router.post('/:id/sheet/assistant', requireAuth, assistantLimiter, validate({ body: AssistantBody }), handle(async (req, res) => {
        const { doc } = await sheetFor(req);
        const userId = req.session.user.id;
        const orgId = req.session.connectorOrgId || req.session.user.organizationId || null;
        const limit = await checkLimits(orgId, userId);
        if (limit) throw new HttpError(402, 'usage_limit', String(limit));
        const answer = await assistant().ask(doc, {
            message: req.body.message, selection: req.body.selection || null,
            history: req.body.history || [], modelTier: req.body.modelTier || 'auto', userId, orgId,
        });
        res.json(answer);
    }));

    /**
     * POST /:id/duplicate for a spreadsheet: a new sheet of the caller's own,
     * in a new table of theirs, with the cells copied — never a second
     * document on the same table.
     */
    async function duplicateSheet(/** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ doc) {
        await new Promise((resolve, reject) => {
            Promise.resolve().then(() => requireSheets(req, res, (/** @type {unknown} */ err) => (err ? reject(err) : resolve(undefined)))).catch(reject);
        });
        const name = (req.body?.name || `${doc.name} — copy`).slice(0, 200);
        try {
            const copy = await startSheet(req, { name, copyFrom: { ownerUserId: doc.userId, tableId: doc.settings?.sheet?.datatableId } });
            res.status(201).json({ document: copy });
        } catch (e) { throw asHttp(e); }
    }

    /** Whether this reader may start spreadsheets (the library offers the type). Never throws. */
    function sheetsVisible(/** @type {any} */ req) {
        return require('./sheetGate').sheetsVisible(gate(), req);
    }

    return Object.assign(router, { sheetsVisible, duplicateSheet });
}

module.exports = makeSheetRouter();
module.exports.makeSheetRouter = makeSheetRouter;
module.exports.sheetCsv = sheetCsv;
