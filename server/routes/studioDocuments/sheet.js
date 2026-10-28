/**
 * Spreadsheet documents (docType 'spreadsheet'). Mounted by
 * routes/studioDocuments.js under /api/studio-documents.
 *
 *   POST  /sheets             { name?, folderId? }  → 201 { document }   start one
 *   GET   /:id/sheet          → { columns, rows, cells: { A1: raw }, refTabs: { Tab: cells }, readOnly }
 *   PATCH /:id/sheet          { cells: { B3: '12', C3: '=SUM(B1:B3)', D4: '' } } → { ok, cells }
 *   GET   /:id/sheet.csv      the computed values, as a CSV download
 *   GET   /:id/sheet.xlsx     every tab as one Excel workbook, formulas kept (core/documents/sheetExport)
 *   POST  /:id/sheet/assistant  { message, selection?, selectionKind?, history?, modelTier? }
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

const crypto = require('crypto');
const express = require('express');
const { validate } = require('../../core/http/validate');
const { HttpError, notFound, forbidden } = require('../../core/http/errors');
const { z, worded, bodyOf, typeError } = require('../../core/http/schemaParts');
const { sheetTabsOf, newTabId, settingsWithTabs } = require('../../stores/lib/sheetDocument');
const { sheetCsv, buildSheetWorkbook } = require('../../core/documents/sheetExport');
const { bestEffort } = require('../../utils/bestEffort');

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
    selectionKind: z.enum(['cell', 'range', 'rows', 'columns'], { error: () => 'selectionKind is cell, range, rows or columns.' }).nullable().optional(),
    modelTier: z.enum(/** @type {[string, ...string[]]} */ (DEPTHS), { error: () => `modelTier is one of ${DEPTHS.join(', ')}.` }).optional(),
    tab: z.string().max(100).optional(),
    history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) }), { error: typeError({ invalid: ROLE_TEXT }) }).max(20).optional(),
}, 'Asking the spreadsheet assistant');
const WriteBody = bodyOf({
    cells: z.record(z.string(), z.union([z.string(), z.null()]), { error: typeError({ required: CELLS_TEXT, invalid: CELLS_TEXT }) }),
}, 'Changing cells');
const TAB_NAME_TEXT = 'name is the tab name, at most 100 characters.';
const TabCreateBody = bodyOf({
    name: worded(TAB_NAME_TEXT).max(100, TAB_NAME_TEXT).optional(),
}, 'Creating a tab');
const TabRenameBody = bodyOf({
    name: worded(TAB_NAME_TEXT).min(1, 'A tab needs a name.').max(100, TAB_NAME_TEXT),
}, 'Renaming a tab');

/**
 * The document store and the datatable runtime refuse with an Error carrying
 * `status` and a code (`errorClass` / `code`); the terminal error handler only
 * passes a code on for an HttpError. Said again as one, so the editor can tell
 * "read only" from "busy" from "too large" by code.
 *
 * @param {{ status?: unknown, code?: unknown, errorClass?: string, message?: string } | null | undefined} e  what was thrown
 */
function asHttp(e) {
    if (!e || e instanceof HttpError || !(Number(e.status) >= 400 && Number(e.status) < 500)) return e;
    // A storage limit keeps its frozen code (core/dataEngine/datatableLimits).
    const code = e.code === 'quota_exceeded' ? e.code : (e.errorClass || (typeof e.code === 'string' ? e.code : 'sheet_refused'));
    return new HttpError(Number(e.status), code, e.message);
}

/** Wrap a handler so whatever it throws reaches the terminal handler in that shape. */
const handle = (/** @type {(req: SheetReq, res: import('express').Response) => Promise<unknown>} */ fn) => async (/** @type {SheetReq} */ req, /** @type {import('express').Response} */ res) => {
    try { await fn(req, res); } catch (e) { throw asHttp(e); }
};

/** A safe download name. */
function fileNameOf(name) {
    return (String(name || 'spreadsheet').replace(/[^\p{L}\p{N} ._-]+/gu, '').trim().slice(0, 100) || 'spreadsheet') + '.csv';
}

/**
 * Every tab of `doc` copied into a new table of `userId`'s own.
 * @param {typeof import('../../core/documents/sheetCells')} cellsApi
 * @param {import('../../stores/documentStore').DocumentView} doc
 * @param {string} userId
 * @param {string[]} [made]  collects every table made, also when a later tab fails, so the caller can give them back
 * @returns {Promise<{ newTabs: { id: string, name: string, datatableId: string }[], tabIds: Map<string, string> }>}  tabIds: old tab id → the copy's
 */
async function copyTabs(cellsApi, doc, userId, made = []) {
    const newTabs = [];
    const tabIds = new Map();
    for (const t of sheetTabsOf(doc)) {
        const table = await cellsApi.createSheetTable({ ownerUserId: userId, name: `${t.name} — copy` });
        made.push(table.id);
        await cellsApi.copyCells(doc.userId, t.datatableId, table.id, userId);
        const id = newTabId();
        tabIds.set(t.id, id);
        newTabs.push({ id, name: t.name, datatableId: table.id });
    }
    return { newTabs, tabIds };
}

/**
 * Name a new tab's table in the document's tab list. A document that refuses
 * it (a conflict, gone meanwhile) takes the new, empty table with it: no
 * document points at it, so nothing else would give it back.
 * @param {typeof import('../../core/documents/sheetCells')} cellsApi
 * @param {typeof import('../../stores/documentStore')} documentsApi
 * @param {import('../../stores/documentStore').DocumentView} doc
 * @param {{ userId: string }} ctx
 * @param {{ id: string, name: string, datatableId: string }[]} nextTabs
 * @param {string} tableId
 */
async function attachTab(cellsApi, documentsApi, doc, ctx, nextTabs, tableId) {
    const giveBack = () => cellsApi.dropSheetTable(doc.userId, tableId).catch((/** @type {unknown} */ e) => bestEffort('routes/studioDocuments/sheet:addTab', e));
    let updated;
    try {
        updated = await documentsApi.updateDocument(doc.id, ctx, { settings: settingsWithTabs(doc.settings, nextTabs), expectedVersionId: doc.versionId });
    } catch (e) {
        await giveBack();
        throw e;
    }
    if (!updated) {
        await giveBack();
        throw notFound('sheet_not_found', 'Spreadsheet not found');
    }
}

/**
 * A copy of `doc` owned by `userId`: every tab in a new table of theirs, the
 * cells and charts carried over. A copy that cannot finish (the tab cap
 * half-way, a read error, a refused save) gives back the tables no document
 * points at, so the failure does not count against the owner.
 * @param {typeof import('../../core/documents/sheetCells')} cellsApi
 * @param {typeof import('../../stores/documentStore')} documentsApi
 * @param {import('../../stores/documentStore').DocumentView} doc
 * @param {string} userId
 * @param {string} name
 * @param {{ userId: string }} ctx
 */
async function copySheet(cellsApi, documentsApi, doc, userId, name, ctx) {
    /** @type {string[]} */
    const made = [];
    try {
        const { newTabs, tabIds } = await copyTabs(cellsApi, doc, userId, made);
        const charts = copiedCharts(doc.settings?.sheet?.charts, tabIds);
        const copy = await documentsApi.createDocument({
            userId, name, docType: 'spreadsheet', kind: 'document', visibility: 'private', folderId: null,
            sheetTableId: newTabs[0].datatableId,
        });
        // The copy owns its first tab's table from here on.
        made.splice(made.indexOf(newTabs[0].datatableId), 1);
        let updated = null;
        if (newTabs.length > 1 || charts.length) {
            const settings = settingsWithTabs(copy.settings, newTabs);
            updated = await documentsApi.updateDocument(copy.id, ctx, {
                settings: { ...settings, sheet: { ...settings.sheet, ...(charts.length ? { charts } : {}) } },
                expectedVersionId: copy.versionId,
            });
        }
        made.length = 0;
        // The copy as stored now: its tabs, its charts and the version after that save.
        return updated || copy;
    } catch (e) {
        for (const id of made) {
            await cellsApi.dropSheetTable(userId, id).catch((/** @type {unknown} */ err) => bestEffort('routes/studioDocuments/sheet:duplicateSheet', err));
        }
        throw e;
    }
}

/**
 * The charts of a sheet for its copy, which looks like the original: new
 * ids, pinned to the copied tabs (a chart pinned to no tab stays on every
 * tab); a chart pinned to a tab that no longer exists is left behind.
 * @param {unknown} charts
 * @param {Map<string, string>} tabIds
 */
function copiedCharts(charts, tabIds) {
    if (!Array.isArray(charts)) return [];
    return charts
        .filter((c) => c && typeof c === 'object' && (!c.tab || tabIds.has(c.tab)))
        .map((c) => ({ ...c, id: `chart-${crypto.randomBytes(5).toString('hex')}`, ...(c.tab ? { tab: tabIds.get(c.tab) } : {}) }));
}

/**
 * @param {{ documents?: typeof import('../../stores/documentStore'),
 *   cells?: typeof import('../../core/documents/sheetCells'),
 *   gate?: import('./sheetGate').Middleware, // the datatables gates as one middleware
 *   evaluate?: (cells: Record<string, string>) => any, // shared/expr/sheet.mjs evaluateSheet
 *   requireAuth?: import('express').RequestHandler,
 *   assistant?: Pick<typeof import('../../core/documents/sheetAssist/sheetAssistant'), 'ask'>,
 *   checkLimits?: (orgId: string|null, userId: string) => Promise<string|null>,
 *   assistantLimiter?: import('express').RequestHandler }} [deps]
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
    const requireSheets = (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res, /** @type {(err?: unknown) => void} */ next) => gate()(req, res, next);
    const assistant = () => deps.assistant || require('../../core/documents/sheetAssist/sheetAssistant');
    const checkLimits = deps.checkLimits || ((orgId, userId) => require('../../core/entitlements/limits').checkSubscriptionLimits(orgId, 'chat', userId));
    // An answer is several model calls; this is well above a person working
    // with the panel and still stops a runaway loop.
    const assistantLimiter = deps.assistantLimiter || require('../../utils/perUserRateLimit')
        .perUserRateLimit({ windowMs: 60_000, max: 20, name: 'sheet-assistant' });

    /** The spreadsheet this reader may see, or a 404 (another type is not a sheet). */
    async function sheetFor(/** @type {SheetReq} */ req) {
        const doc = await documents().getDocument(req.params.id, req.session.user.id);
        if (!doc || doc.docType !== 'spreadsheet') throw notFound('sheet_not_found', 'Spreadsheet not found');
        const tabs = sheetTabsOf(doc);
        if (!tabs.length) throw new HttpError(410, 'sheet_table_missing', 'This spreadsheet has no table for its cells.');
        return { doc, tabs };
    }
    /** The tab a request asks for, defaulting to the first tab. */
    function resolveTab(/** @type {any[]} */ tabs, /** @type {string|undefined} */ tabId) {
        const id = tabId || tabs[0].id;
        const tab = tabs.find((t) => t.id === id);
        if (!tab) throw new HttpError(404, 'sheet_tab_not_found', 'This tab does not exist.');
        return tab;
    }
    function actorContext(/** @type {import('express').Request} */ req) {
        return { userId: req.session.user.id };
    }

    /**
     * Make the table, then the document; a document that cannot be made takes
     * its new, empty table with it.
     */
    async function startSheet(/** @type {import('express').Request} */ req, { name, folderId = null, copyFrom = null }) {
        const userId = req.session.user.id;
        const table = await cells().createSheetTable({ ownerUserId: userId, name });
        try {
            if (copyFrom) await cells().copyCells(copyFrom.ownerUserId, copyFrom.tableId, table.id, userId);
            return await documents().createDocument({
                userId, name, docType: 'spreadsheet', kind: 'document', visibility: 'private', folderId,
                sheetTableId: table.id,
            });
        } catch (e) {
            await cells().dropSheetTable(userId, table.id).catch((e) => bestEffort('routes/studioDocuments/sheet:startSheet', e));
            throw e;
        }
    }

    router.post('/sheets', requireAuth, requireSheets, validate({ body: CreateBody }), handle(async (req, res) => {
        const name = (req.body.name || '').trim() || 'Untitled spreadsheet';
        res.status(201).json({ document: await startSheet(req, { name, folderId: req.body.folderId || null }) });
    }));

    router.get('/:id/sheet', requireAuth, handle(async (req, res) => {
        const { doc, tabs } = await sheetFor(req);
        const tab = resolveTab(tabs, req.query.tab);
        const sheet = await cells().readSheet(doc.userId, tab.datatableId);
        // The tabs its formulas point at, so the editor computes `Klanten!A1` instead of #REF!.
        const refTabs = await require('../../core/documents/sheetWorkbook').readReferencedTabs(doc, tabs, tab.id, sheet.cells, cells());
        res.json({ ...sheet, refTabs, tabs, activeTab: tab.id, readOnly: (doc.projectRole === 'viewer' || doc.sharingRole === 'viewer') });
    }));

    router.patch('/:id/sheet', requireAuth, validate({ body: WriteBody }), handle(async (req, res) => {
        const { doc, tabs } = await sheetFor(req);
        if ((doc.projectRole === 'viewer' || doc.sharingRole === 'viewer')) throw forbidden('document_read_only', 'You can read this spreadsheet, but only its editors can change it.');
        const tab = resolveTab(tabs, req.query.tab);
        const saved = await cells().writeCells(doc.userId, tab.datatableId, req.body.cells);
        res.json({ ok: true, cells: saved.cells, tabs, activeTab: tab.id });
    }));

    router.get('/:id/sheet.csv', requireAuth, handle(async (req, res) => {
        const { doc, tabs } = await sheetFor(req);
        const tab = resolveTab(tabs, req.query.tab);
        const { cells: raw } = await cells().readSheet(doc.userId, tab.datatableId);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${fileNameOf(doc.name)}"`);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        // A BOM so spreadsheet apps read the file as UTF-8.
        res.send('\uFEFF' + sheetCsv(raw, evaluate));
    }));

    router.get('/:id/sheet.xlsx', requireAuth, handle(async (req, res) => {
        const { doc } = await sheetFor(req);
        const file = await buildSheetWorkbook(doc, { cells: cells() });
        res.setHeader('Content-Type', file.contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.send(file.buffer);
    }));

    router.post('/:id/sheet/tabs', requireAuth, validate({ body: TabCreateBody }), handle(async (req, res) => {
        const { doc, tabs } = await sheetFor(req);
        if ((doc.projectRole === 'viewer' || doc.sharingRole === 'viewer')) throw forbidden('document_read_only', 'You can read this spreadsheet, but only its editors can change it.');
        const name = (req.body.name || '').trim() || `Sheet${tabs.length + 1}`;
        const table = await cells().createSheetTable({ ownerUserId: doc.userId, name });
        const tab = { id: newTabId(), name, datatableId: table.id };
        const nextTabs = [...tabs, tab];
        await attachTab(cells(), documents(), doc, actorContext(req), nextTabs, table.id);
        res.status(201).json({ tab, tabs: nextTabs });
    }));

    router.patch('/:id/sheet/tabs/:tabId', requireAuth, validate({ body: TabRenameBody }), handle(async (req, res) => {
        const { doc, tabs } = await sheetFor(req);
        if ((doc.projectRole === 'viewer' || doc.sharingRole === 'viewer')) throw forbidden('document_read_only', 'You can read this spreadsheet, but only its editors can change it.');
        const idx = tabs.findIndex((t) => t.id === req.params.tabId);
        if (idx === -1) throw new HttpError(404, 'sheet_tab_not_found', 'This tab does not exist.');
        tabs[idx] = { ...tabs[idx], name: req.body.name.trim() };
        const updated = await documents().updateDocument(doc.id, actorContext(req), {
            settings: settingsWithTabs(doc.settings, [...tabs]),
            expectedVersionId: doc.versionId,
        });
        if (!updated) throw notFound('sheet_not_found', 'Spreadsheet not found');
        res.json({ tabs });
    }));

    router.delete('/:id/sheet/tabs/:tabId', requireAuth, handle(async (req, res) => {
        const { doc, tabs } = await sheetFor(req);
        if ((doc.projectRole === 'viewer' || doc.sharingRole === 'viewer')) throw forbidden('document_read_only', 'You can read this spreadsheet, but only its editors can change it.');
        if (tabs.length === 1) throw new HttpError(422, 'sheet_last_tab', 'A spreadsheet must keep at least one tab.');
        const idx = tabs.findIndex((t) => t.id === req.params.tabId);
        if (idx === -1) throw new HttpError(404, 'sheet_tab_not_found', 'This tab does not exist.');
        const [removed] = tabs.splice(idx, 1);
        const updated = await documents().updateDocument(doc.id, actorContext(req), {
            settings: settingsWithTabs(doc.settings, [...tabs]),
            expectedVersionId: doc.versionId,
        });
        if (!updated) throw notFound('sheet_not_found', 'Spreadsheet not found');
        await cells().dropSheetTable(doc.userId, removed.datatableId).catch((e) => bestEffort('routes/studioDocuments/sheet:makeSheetRouter', e));
        res.json({ tabs });
    }));

    router.post('/:id/sheet/assistant', requireAuth, assistantLimiter, validate({ body: AssistantBody }), handle(async (req, res) => {
        const { doc } = await sheetFor(req);
        const userId = req.session.user.id;
        const orgId = req.session.connectorOrgId || req.session.user.organizationId || null;
        const limit = await checkLimits(orgId, userId);
        if (limit) throw new HttpError(402, 'usage_limit', String(limit));
        const answer = await assistant().ask(doc, {
            message: req.body.message, selection: req.body.selection || null, selectionKind: req.body.selectionKind || null,
            history: req.body.history || [], modelTier: req.body.modelTier || 'auto', userId, orgId,
            ...(req.body.tab ? { tabId: req.body.tab } : {}),
        });
        res.json(answer);
    }));

    /**
     * POST /:id/duplicate for a spreadsheet: a new sheet of the caller's own,
     * in a new table of theirs, with the cells copied — never a second
     * document on the same table.
     */
    async function duplicateSheet(/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res, /** @type {import('../../stores/documentStore').DocumentView} */ doc) {
        await new Promise((resolve, reject) => {
            Promise.resolve().then(() => requireSheets(req, res, (/** @type {unknown} */ err) => (err ? reject(err) : resolve(undefined)))).catch(reject);
        });
        const name = (req.body?.name || `${doc.name} — copy`).slice(0, 200);
        try {
            res.status(201).json({ document: await copySheet(cells(), documents(), doc, req.session.user.id, name, actorContext(req)) });
        } catch (e) { throw asHttp(e); }
    }

    /** Whether this reader may start spreadsheets (the library offers the type). Never throws. */
    function sheetsVisible(/** @type {import('express').Request} */ req) {
        return require('./sheetGate').sheetsVisible(/** @type {import('./sheetGate').Middleware} */ (gate()), req);
    }

    return Object.assign(router, { sheetsVisible, duplicateSheet });
}

module.exports = Object.assign(makeSheetRouter(), {
    makeSheetRouter,
    sheetCsv,
});

/** @typedef {import('express').Request<{ id: string, tabId?: string }>} SheetReq */
