'use strict';

/**
 * Spreadsheet documents over HTTP (studioDocuments/sheet.js): who may read and
 * change a sheet is the document's answer; starting one sits behind the
 * datatables gates and makes the table before the document (and drops it
 * again when the document cannot be made); the CSV carries computed values;
 * a refusal keeps its code.
 *
 * Run: cd server && node --test routes/studioDocuments/sheet.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const h = require('../../core/http/routeHarness');
const { HttpError } = require('../../core/http/errors');
const { makeSheetRouter, sheetCsv } = require('./sheet');
const { makeSheetGate, sheetsVisible } = require('./sheetGate');

const state = { cells: {}, writes: [], created: [], dropped: [], copies: [], gateOpen: true, failCreate: false, asked: [], overLimit: false };
const baseSettings = () => ({ sheet: { tabs: [{ id: 't1', name: 'Budget', datatableId: 'dt1' }] } });
const DOCS = {
    s1: { id: 's1', userId: 'owner', name: 'Budget', docType: 'spreadsheet', settings: baseSettings() },
    p1: { id: 'p1', userId: 'owner', name: 'A page', docType: 'page', settings: {} },
};
const router = makeSheetRouter({
    documents: {
        async getDocument(id, userId) {
            const doc = DOCS[id];
            if (!doc) return null;
            if (userId === 'owner') return doc;
            if (userId === 'viewer') return { ...doc, projectRole: 'viewer' };
            if (userId === 'sharedViewer') return { ...doc, sharingRole: 'viewer' };
            if (userId === 'editor') return { ...doc, projectRole: 'editor' };
            return null;
        },
        async createDocument(input) {
            if (state.failCreate) throw Object.assign(new Error('Folder not found'), { status: 404, errorClass: 'document_invalid' });
            state.created.push(input);
            return { id: 'new-doc', ...input };
        },
        async updateDocument(id, _ctx, { settings }) {
            const doc = DOCS[id];
            if (!doc) return null;
            doc.settings = settings;
            return doc;
        },
    },
    cells: {
        async createSheetTable({ ownerUserId, name }) { return { id: `dt-${ownerUserId}-${name}` }; },
        async dropSheetTable(userId, id) { state.dropped.push([userId, id]); return true; },
        async copyCells(...a) { state.copies.push(a); },
        async readSheet(ownerUserId, tableId) {
            assert.strictEqual(ownerUserId, 'owner', 'cells are read as the document owner');
            assert.strictEqual(tableId, 'dt1');
            return { cells: { ...state.cells }, rows: 3, columns: 26 };
        },
        async writeCells(ownerUserId, tableId, cells) {
            assert.strictEqual(ownerUserId, 'owner', 'cells are written as the document owner');
            if (cells.Z1 === 'busy') throw new HttpError(409, 'sheet_busy', 'Somebody else is changing the same row right now.');
            state.writes.push(cells);
            return { cells };
        },
    },
    gate: (req, res, next) => (state.gateOpen ? next() : next(new HttpError(403, 'sheets_unavailable', 'Spreadsheets are not available to you.'))),
    evaluate: require('../../shared/expr/sheet.mjs').evaluateSheet,
    requireAuth: (req, res, next) => (req.session?.user ? next() : res.status(401).json({ error: 'Authentication required' })),
    assistant: {
        async ask(doc, o) {
            state.asked.push({ doc: doc.id, role: doc.projectRole || 'owner', ...o });
            if (o.message === 'privacy') throw new HttpError(422, 'privacy_review_required', 'Review first.');
            return { reply: 'Done.', changes: { D2: { before: '', after: '=B2*C2' } }, rounds: 1, tier: 'thinking' };
        },
    },
    checkLimits: async () => (state.overLimit ? 'You have used this month\'s AI budget.' : null),
    assistantLimiter: (req, res, next) => next(),
});
const api = h.serve('/api/studio-documents', router);
test.after(api.close);
test.beforeEach(() => {
    Object.assign(state, { cells: { A1: '2', A2: '3', A3: '=A1*A2' }, writes: [], created: [], dropped: [], copies: [], gateOpen: true, failCreate: false, asked: [], overLimit: false });
    DOCS.s1.settings = baseSettings();
});

const as = (user, method, path, body) => api.call(method, `/api/studio-documents${path}`, { user: user && { id: user, organizationId: 'org1' }, body });

const expectedTabs = [{ id: 't1', name: 'Budget', datatableId: 'dt1' }];

test('the owner reads the cells; a project viewer reads them read-only', async () => {
    const mine = await as('owner', 'GET', '/s1/sheet');
    assert.strictEqual(mine.status, 200, mine.text);
    assert.deepStrictEqual(mine.body, { cells: { A1: '2', A2: '3', A3: '=A1*A2' }, rows: 3, columns: 26, tabs: expectedTabs, activeTab: 't1', readOnly: false });
    const theirs = await as('viewer', 'GET', '/s1/sheet');
    assert.strictEqual(theirs.body.readOnly, true);
    assert.deepStrictEqual(theirs.body.tabs, expectedTabs);
    assert.strictEqual(theirs.body.activeTab, 't1');
});

test('somebody without access, or a document that is no spreadsheet, is a 404', async () => {
    assert.strictEqual((await as('stranger', 'GET', '/s1/sheet')).status, 404);
    assert.strictEqual((await as('owner', 'GET', '/p1/sheet')).status, 404);
    assert.strictEqual((await as(null, 'GET', '/s1/sheet')).status, 401);
});

test('an editor writes cells; a viewer is refused with a code', async () => {
    const ok = await as('editor', 'PATCH', '/s1/sheet', { cells: { B2: '12', C3: '' } });
    assert.strictEqual(ok.status, 200, ok.text);
    assert.deepStrictEqual(state.writes, [{ B2: '12', C3: '' }]);
    const no = await as('viewer', 'PATCH', '/s1/sheet', { cells: { B2: '12' } });
    assert.strictEqual(no.status, 403);
    assert.strictEqual(no.body.code, 'document_read_only');
    assert.strictEqual(state.writes.length, 1);
});

test('a malformed write is a 400; a refusal from the cells keeps its code', async () => {
    assert.strictEqual((await as('owner', 'PATCH', '/s1/sheet', { cells: { A1: 12 } })).status, 400);
    assert.strictEqual((await as('owner', 'PATCH', '/s1/sheet', {})).status, 400);
    const busy = await as('owner', 'PATCH', '/s1/sheet', { cells: { Z1: 'busy' } });
    assert.strictEqual(busy.status, 409);
    assert.strictEqual(busy.body.code, 'sheet_busy');
});

test('the CSV holds what the sheet shows, formulas computed', async () => {
    const res = await as('owner', 'GET', '/s1/sheet.csv');
    assert.strictEqual(res.status, 200);
    assert.match(String(res.headers.get('content-type')), /text\/csv/);
    assert.match(String(res.headers.get('content-disposition')), /filename="Budget\.csv"/);
    assert.strictEqual(res.text.replace(/^﻿/, ''), '2\r\n3\r\n6\r\n');
});

test('sheetCsv quotes what needs quoting and fills the gaps', () => {
    const csv = sheetCsv({ A1: 'a,b', C1: 'say "hi"', B2: '=1/0' }, require('../../shared/expr/sheet.mjs').evaluateSheet);
    assert.strictEqual(csv, '"a,b",,"say ""hi"""\r\n,#DIV/0!,\r\n');
    assert.strictEqual(sheetCsv({}, () => ({})), '');
});

test('starting a sheet makes its table, then the document that names it', async () => {
    const res = await as('owner', 'POST', '/sheets', { name: 'Q3 numbers', folderId: 'f1' });
    assert.strictEqual(res.status, 201, res.text);
    assert.deepStrictEqual(state.created, [{
        userId: 'owner', name: 'Q3 numbers', docType: 'spreadsheet', kind: 'document', visibility: 'private',
        folderId: 'f1', sheetTableId: 'dt-owner-Q3 numbers',
    }]);
});

test('a document that cannot be made takes its new table with it, and says why', async () => {
    state.failCreate = true;
    const res = await as('owner', 'POST', '/sheets', { name: 'X', folderId: 'gone' });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.code, 'document_invalid');
    assert.deepStrictEqual(state.dropped, [['owner', 'dt-owner-X']]);
});

test('starting one needs the datatables gates', async () => {
    state.gateOpen = false;
    const res = await as('owner', 'POST', '/sheets', { name: 'X' });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.code, 'sheets_unavailable');
    assert.deepStrictEqual(state.created, []);
});

test('a copy is a new sheet in the copier\'s own table, with the cells copied', async () => {
    const res = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await router.duplicateSheet({ session: { user: { id: 'editor' } }, body: {} }, res, DOCS.s1);
    assert.strictEqual(res.statusCode, 201);
    assert.deepStrictEqual(state.copies, [['owner', 'dt1', 'dt-editor-Budget — copy', 'editor']]);
    assert.strictEqual(state.created[0].sheetTableId, 'dt-editor-Budget — copy');
    assert.strictEqual(state.created[0].userId, 'editor');
});

test('the sheet gate runs the datatables gates in order and says no without throwing', async () => {
    const seen = [];
    const gate = makeSheetGate({ gates: [
        (req, res, next) => { seen.push('module'); next(); },
        (req, res, _next) => { seen.push('licence'); res.status(403).json({ error: 'feature_locked' }); },
        (req, res, next) => { seen.push('beta'); next(); },
    ] });
    const req = { session: { user: { id: 'u' } } };
    assert.strictEqual(await sheetsVisible(gate, req), false);
    assert.deepStrictEqual(seen, ['module', 'licence']);
    const open = makeSheetGate({ gates: [(req2, res, next) => next()] });
    assert.strictEqual(await sheetsVisible(open, req), true);
    const unknown = makeSheetGate({ gates: [(req2, res) => res.status(503).json({})] });
    await assert.rejects(unknown(req, {}, () => {}), (e) => e.status === 503 && e.code === 'sheets_unknown');
});

test('the assistant answers with its reply, the saved changes and the tier that answered', async () => {
    const res = await as('editor', 'POST', '/s1/sheet/assistant', {
        message: 'Add totals', selection: 'B2:C3', selectionKind: 'range', modelTier: 'thinking', history: [{ role: 'user', content: 'hi' }],
    });
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(res.body, { reply: 'Done.', changes: { D2: { before: '', after: '=B2*C2' } }, rounds: 1, tier: 'thinking' });
    assert.deepStrictEqual(state.asked, [{
        doc: 's1', role: 'editor', message: 'Add totals', selection: 'B2:C3', selectionKind: 'range', modelTier: 'thinking',
        history: [{ role: 'user', content: 'hi' }], userId: 'editor', orgId: 'org1',
    }]);
});

test('the tier defaults to auto; a viewer may still ask (the assistant only reads for them)', async () => {
    const res = await as('viewer', 'POST', '/s1/sheet/assistant', { message: 'What is the total?' });
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(state.asked[0].modelTier, 'auto');
    assert.strictEqual(state.asked[0].role, 'viewer');
});

test('the assistant receives the requested tab', async () => {
    const res = await as('editor', 'POST', '/s1/sheet/assistant', { message: 'Sum this tab', tab: 't1' });
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(state.asked[0].tabId, 't1');
});

test('a malformed request, a spent budget or a privacy hold is answered with a code', async () => {
    assert.strictEqual((await as('owner', 'POST', '/s1/sheet/assistant', { message: '' })).status, 400);
    assert.strictEqual((await as('owner', 'POST', '/s1/sheet/assistant', { message: 'x', modelTier: 'turbo' })).status, 400);
    assert.strictEqual((await as('owner', 'POST', '/s1/sheet/assistant', { message: 'x', selectionKind: 'sheet' })).status, 400);
    assert.strictEqual((await as('stranger', 'POST', '/s1/sheet/assistant', { message: 'x' })).status, 404);
    state.overLimit = true;
    const limit = await as('owner', 'POST', '/s1/sheet/assistant', { message: 'x' });
    assert.strictEqual(limit.status, 402);
    assert.strictEqual(limit.body.code, 'usage_limit');
    state.overLimit = false;
    const held = await as('owner', 'POST', '/s1/sheet/assistant', { message: 'privacy' });
    assert.strictEqual(held.status, 422);
    assert.strictEqual(held.body.code, 'privacy_review_required');
});

test('an editor can add, rename and remove tabs; the last tab cannot be removed', async () => {
    const add = await as('editor', 'POST', '/s1/sheet/tabs', { name: 'Q4' });
    assert.strictEqual(add.status, 201, add.text);
    assert.strictEqual(add.body.tabs.length, 2);
    assert.strictEqual(add.body.tab.name, 'Q4');
    assert.strictEqual(add.body.tab.datatableId, 'dt-owner-Q4');

    const rename = await as('editor', 'PATCH', '/s1/sheet/tabs/t1', { name: 'Renamed' });
    assert.strictEqual(rename.status, 200, rename.text);
    assert.strictEqual(rename.body.tabs[0].name, 'Renamed');
    assert.strictEqual(rename.body.tabs[1].name, 'Q4');

    const remove = await as('editor', 'DELETE', '/s1/sheet/tabs/t1');
    assert.strictEqual(remove.status, 200, remove.text);
    assert.strictEqual(remove.body.tabs.length, 1);
    assert.strictEqual(remove.body.tabs[0].id, add.body.tab.id);
    assert.deepStrictEqual(state.dropped, [['owner', 'dt1']]);

    const last = await as('editor', 'DELETE', `/s1/sheet/tabs/${add.body.tab.id}`);
    assert.strictEqual(last.status, 422);
    assert.strictEqual(last.body.code, 'sheet_last_tab');
});

test('a viewer cannot change tabs', async () => {
    assert.strictEqual((await as('viewer', 'POST', '/s1/sheet/tabs', { name: 'X' })).status, 403);
    assert.strictEqual((await as('viewer', 'PATCH', '/s1/sheet/tabs/t1', { name: 'X' })).status, 403);
    assert.strictEqual((await as('viewer', 'DELETE', '/s1/sheet/tabs/t1')).status, 403);
});


test('a directly shared spreadsheet is read-only even without a project role', async () => {
    const user = { id: 'sharedViewer', organizationId: 'org1' };
    const read = await api.call('GET', '/api/studio-documents/s1/sheet', { user });
    assert.strictEqual(read.status, 200);
    assert.strictEqual(read.body.readOnly, true);
    const previousWrites = state.writes.length;
    const write = await api.call('PATCH', '/api/studio-documents/s1/sheet', { user, body: { cells: { A1: 'Changed' } } });
    assert.strictEqual(write.status, 403);
    assert.strictEqual(write.body.code, 'document_read_only');
    assert.strictEqual(state.writes.length, previousWrites);
});
