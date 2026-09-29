/**
 * What the Nextcloud linking routes accept, and what they say when they
 * refuse (routes/datatablesNextcloud.js).
 *
 *   - `/describe?ncViewId=12x&ncTableId=4` read the view id as NaN, fell
 *     through to the TABLE and described all its columns — where the view
 *     the person picked may show only some;
 *   - a misspelled `descripton` on a table to link was dropped and the mirror
 *     recorded the kind's default purpose, the Art. 30 register entry;
 *   - a misspelled `relatons` linked the tables with no relations and no
 *     warning.
 *
 * What this file pins:
 *
 *   - the 400 NAMES the field, in a sentence;
 *   - link.js is never reached, so a refused request links and reads nothing;
 *   - the dialog's own requests — and the integration suite's bodies, whose
 *     harness does not look at a validation refusal — still pass;
 *   - `scope` stays judged by the route, so the dialog keeps `bad_scope`.
 *
 * Run: cd server && node --test routes/datatablesNextcloud.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every engine call lands in `touched`. A refused request must leave it empty.
const touched = [];

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
    '../core/dataEngine/sources/nextcloudTable/errors': { isNextcloudSourceError: () => false },
    '../core/dataEngine/sources/nextcloudTable/link': {
        listLinkable: async (...a) => { touched.push({ what: 'listLinkable', args: a }); return { connected: true, tables: [] }; },
        describe: async (session, principal, scope, ref) => { touched.push({ what: 'describe', args: [ref] }); return { columns: [] }; },
        linkTables: async (args) => { touched.push({ what: 'linkTables', args: [args] }); return { datatables: [], warnings: [], partial: false }; },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:dt-nextcloud-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]datatablesNextcloud\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./datatablesNextcloud')({ publicTable: (t) => t });
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

test.beforeEach(() => { touched.length = 0; });

test('a view id that is not a number is refused, instead of describing the whole table', async () => {
    const res = await dispatch({ method: 'GET', url: '/describe?ncViewId=12x&ncTableId=4' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A Nextcloud table or view id is a whole number.');
    assert.ok(res.body.details.some((d) => d.path === 'query.ncViewId'));
    assert.deepStrictEqual(touched, []);
});

test('the dialog\'s describe still reads a view as a view, and a table as a table', async () => {
    let res = await dispatch({ method: 'GET', url: '/describe?ncViewId=12&scope=organisation' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched[0].args[0], { ncViewId: 12 });
    res = await dispatch({ method: 'GET', url: '/describe?ncTableId=4' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched[1].args[0], { ncTableId: 4 });
});

test('a misspelled describe parameter is refused rather than answered from the wrong object', async () => {
    const res = await dispatch({ method: 'GET', url: '/describe?ncviewId=12&ncTableId=4' });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
});

test('a misspelled purpose on a table to link is refused, instead of recording the default one', async () => {
    const res = await dispatch({ method: 'POST', url: '/link', body: { tables: [{ ncTableId: 4, name: 'Facturen', key: 'facturen', descripton: 'Invoices we must keep' }] } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.tables.0'));
    assert.deepStrictEqual(touched, []);
});

test('a misspelled view id is refused, instead of mirroring the WHOLE table the view narrows', async () => {
    const res = await dispatch({ method: 'POST', url: '/link', body: { tables: [{ ncTableId: 3, ncViewID: 7, key: 'tickets' }] } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.tables.0'), JSON.stringify(res.body.details));
    const described = await dispatch({ method: 'GET', url: '/describe?ncTableId=3&ncViewID=7' });
    assert.strictEqual(described.statusCode, 400);
    assert.deepStrictEqual(touched, [], 'link.js never saw table 3');
});

test('one relation sent as an object, not a list, is refused rather than skipped without the warning', async () => {
    const res = await dispatch({
        method: 'POST', url: '/link',
        body: { tables: [{ ncTableId: 4, key: 'facturen' }], relations: { from: { ncTableId: 4, ncColumnId: 2 }, to: { ncTableId: 6, ncColumnId: 20 } } },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'relations is a list of { from, to } pairs.');
    assert.deepStrictEqual(touched, []);
});

test('misspelled relations are refused, instead of linking with none and no warning', async () => {
    const res = await dispatch({ method: 'POST', url: '/link', body: { tables: [{ ncTableId: 4 }], relatons: [] } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
});

test('the dialog\'s link body, and the integration suite\'s, still reach link.js as sent', async () => {
    const dialog = {
        scope: 'organisation',
        tables: [{ ncTableId: 4, name: 'Facturen', key: 'facturen' }, { ncViewId: 9, name: 'Open', key: 'open', description: 'Open invoices' }],
        relations: [{ from: { ncTableId: 4, ncColumnId: 2 }, to: { ncTableId: 6, ncColumnId: 20 } }],
    };
    let res = await dispatch({ method: 'POST', url: '/link', body: dialog });
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    assert.deepStrictEqual(touched[0].args[0].tables, dialog.tables);
    assert.deepStrictEqual(touched[0].args[0].relations, dialog.relations);

    for (const body of [
        { tables: [{ ncTableId: 4, key: 'again' }] },
        { tables: [{ ncTableId: 6, name: 'Leveranciers', key: 'leveranciers' }], relations: [{ from: { ncTableId: 4, ncColumnId: 2 }, to: { ncTableId: 6, ncColumnId: 20 } }] },
        { tables: [{ ncTableId: '4' }], schedule: { everyMinutes: 15 } },
    ]) {
        res = await dispatch({ method: 'POST', url: '/link', body });
        assert.strictEqual(res.statusCode, 201, JSON.stringify(body));
    }
});

test('a scope word is still the route\'s to judge — bad_scope, the code the dialog translates', async () => {
    const res = await dispatch({ method: 'GET', url: '/linkable?scope=Personal' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'bad_scope');
    assert.deepStrictEqual(touched, []);
});
