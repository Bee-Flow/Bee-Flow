/**
 * What the spreadsheet linking routes accept, and what they say when they
 * refuse (routes/datatablesSpreadsheets.js).
 *
 *   - `?headerrow=3` (one letter off) was dropped and the sheet was described
 *     from row 1; `?shared=True` listed the caller's OWN files instead of
 *     "shared with me";
 *   - a column typed in the wizard as `{ col: '2', type: 'number' }` or
 *     `{ col: 2, tpye: 'number' }` was skipped, and the mirror got the
 *     INFERRED type instead of the chosen one, under a 201;
 *   - `sharedWriteOptIn: 'true'` (text) left a shared file read-only.
 *
 * What this file pins:
 *
 *   - the 400 NAMES the field, in a sentence;
 *   - link.js is never reached, so a refused request reads and links nothing;
 *   - the wizard's own requests — and the integration suite's bodies, whose
 *     harness does not look at a validation refusal — still pass.
 *
 * Run: cd server && node --test routes/datatablesSpreadsheets.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every engine call lands in `touched`. A refused request must leave it empty.
const touched = [];

const link = {
    storageLimiter: (req, res, next) => next(),
    providers: async () => { touched.push({ what: 'providers' }); return { providers: [] }; },
    browse: async (session, principal, scope, opts) => { touched.push({ what: 'browse', args: [opts] }); return { items: [] }; },
    describe: async (session, principal, scope, opts) => { touched.push({ what: 'describe', args: [opts] }); return { sheet: {} }; },
    linkSpreadsheets: async (args) => { touched.push({ what: 'linkSpreadsheets', args: [args] }); return { datatables: [], warnings: [], partial: false }; },
};

const MOCKS = {
    '../auth': {
        assertUserCanUseOrg: async () => {},
        hasPermission: async () => true,
        Permissions: { MANAGE_DATATABLES: 'manage_datatables' },
    },
    '../stores/datatableStore': {
        orgScope: (id) => ({ kind: 'org', id }),
        userScope: (id) => ({ kind: 'user', id }),
    },
    '../auth/datatableAccess': { resolveDatatablePrincipal: async () => ({ userId: 'u1', orgId: 'org1' }) },
    '../core/dataEngine/sources/mirror/errors': { isSourceError: () => false },
    '../core/dataEngine/sources': { adapterFor: () => ({ link }) },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:dt-spreadsheets-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]datatablesSpreadsheets\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./datatablesSpreadsheets')({ publicTable: (t) => t });
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ method, url, body }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = url.split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method, url, originalUrl: url, path: pathname, body, query, headers: {},
            session: { user: { id: 'u1' } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            set() { return this; },
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

const SHEET = {
    provider: 'google_drive', fileId: 'xlsx1', sheet: 'Facturen', headerRow: 1, keyColumn: 1,
    columns: [{ col: 0, header: 'Datum', type: 'date' }, { col: 1, header: 'Factuurnummer', type: 'text' }, { col: 3, header: 'Bedrag', type: 'number' }],
    name: 'Facturen', key: 'facturen',
};

test.beforeEach(() => { touched.length = 0; });

test('a misspelled header row is refused, instead of describing the sheet from row 1', async () => {
    const res = await dispatch({ method: 'GET', url: '/describe?provider=google_drive&fileId=xlsx1&headerrow=3' });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
});

test('?shared=True is refused, instead of listing your own files as "shared with me"', async () => {
    const res = await dispatch({ method: 'GET', url: '/browse?provider=google_drive&shared=True' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'shared is true or false.');
    assert.deepStrictEqual(touched, []);
});

test('the file browser\'s own queries still browse and describe', async () => {
    let res = await dispatch({ method: 'GET', url: '/browse?provider=google_drive&folderId=shared&shared=true&scope=personal' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched[0].args[0].shared, true);
    res = await dispatch({ method: 'GET', url: '/browse?provider=dropbox' });
    assert.strictEqual(res.statusCode, 200, 'the provider WORD stays link.js\'s to refuse, with its own code');
    res = await dispatch({ method: 'GET', url: '/describe?provider=google_drive&fileId=xlsx1&sheet=Facturen&headerRow=2' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched[2].args[0].headerRow, '2');
});

test('a declared column whose number is text, or whose type is misspelled, is refused', async () => {
    for (const column of [{ col: '2', type: 'number' }, { col: 2, tpye: 'number' }]) {
        const res = await dispatch({ method: 'POST', url: '/link', body: { tables: [{ ...SHEET, columns: [column] }] } });
        assert.strictEqual(res.statusCode, 400, JSON.stringify(column));
        assert.ok(res.body.details.some((d) => d.path.startsWith('body.tables.0.columns.0')), JSON.stringify(res.body.details));
    }
    assert.deepStrictEqual(touched, []);
});

test('a misspelled key column is refused, instead of linking the sheet with row-position identity', async () => {
    const res = await dispatch({
        method: 'POST', url: '/link',
        body: { tables: [{ provider: 'google_drive', fileId: 'f1', sheet: 'Facturen', keycolumn: 1, key: 'facturen' }] },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.tables.0'), JSON.stringify(res.body.details));
    assert.deepStrictEqual(touched, [], 'no mirror keyed r<n> by position was made');
});

test('one relation sent as an object, not a list, is refused rather than skipped without the warning', async () => {
    const res = await dispatch({
        method: 'POST', url: '/link',
        body: { tables: [SHEET], relations: { from: { provider: 'google_drive', fileId: 'xlsx1', sheet: 'Facturen', col: 2 }, to: { provider: 'google_drive', fileId: 'csv1', sheet: null, col: 0 } } },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'relations is a list of { from, to } pairs.');
    assert.deepStrictEqual(touched, []);
});

test('an opt-in given as text is refused, instead of leaving the file read-only without a word', async () => {
    const res = await dispatch({ method: 'POST', url: '/link', body: { tables: [{ ...SHEET, sharedWriteOptIn: 'true' }] } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'sharedWriteOptIn is true or false.');
    assert.deepStrictEqual(touched, []);
});

test('the wizard\'s link body, and the integration suite\'s, still reach link.js as sent', async () => {
    const wizard = {
        scope: 'organisation',
        tables: [SHEET, { provider: 'google_drive', fileId: 'csv1', path: '/x/klanten.csv', sheet: null, headerRow: 1, keyColumn: null, columns: [], sharedWriteOptIn: true, name: 'Klanten', key: 'klanten', description: 'Customers' }],
        relations: [{ from: { provider: 'google_drive', fileId: 'xlsx1', sheet: 'Facturen', col: 2 }, to: { provider: 'google_drive', fileId: 'csv1', sheet: null, col: 0 } }],
    };
    let res = await dispatch({ method: 'POST', url: '/link', body: wizard });
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    assert.deepStrictEqual(touched[0].args[0].tables, wizard.tables);

    for (const body of [
        { tables: [{ provider: 'google_drive', fileId: 'xlsx1', sheet: 'Facturen', key: 'again' }] },
        { tables: [{ provider: 'google_drive', fileId: 'xlsx1', sheet: 'Leveranciers', keyColumn: 1, key: 'bystad' }] },
        { tables: [{ provider: 'google_drive', fileId: 'csv2', key: 'shared' }] },
    ]) {
        res = await dispatch({ method: 'POST', url: '/link', body });
        assert.strictEqual(res.statusCode, 201, JSON.stringify(body));
    }
});
