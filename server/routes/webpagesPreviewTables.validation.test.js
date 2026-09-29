/**
 * Wat de tabelbrug `window.beeflowTables` aanneemt, en wat hij zegt als hij
 * weigert (routes/webpagesPreviewTables.js).
 *
 * `beeflowTables.query(id, opts)` stuurt `opts` ongewijzigd als body, dus een
 * sleutel die de route niet las viel weg — en een weggevallen filter is hier
 * geen kleinere vraag maar een BREDER antwoord. `{ filter: [...] }`,
 * `{ search: {...} }` en één filter-object in plaats van een lijst gaven elk
 * alle rijen die de bezoeker mag zien, onder een 200. Wat dit bestand vastlegt:
 *
 *   - de 400 NOEMT het veld (`body.filters`), niet alleen "invalid request";
 *   - de melding is een zin;
 *   - de tabel wordt niet geopend, dus een geweigerd verzoek leest niets.
 *
 * Draaien: cd server && node --test routes/webpagesPreviewTables.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Elke aanraking van de binding of de runner komt in `touched`. Een geweigerd
// verzoek laat die leeg.
const touched = [];
const pass = (req, res, next) => next();

const BINDING = { datatableId: 'tbl_1', mode: 'readwrite', columns: ['name', 'status'] };

const MOCKS = {
    '../auth/webpagePreviewToken': {
        requirePreviewToken: (req, res, next) => {
            req.previewClaims = { userId: 'u-author', webpageId: 'wp1', viewerUserId: 'u-viewer' };
            next();
        },
    },
    './webpagesPreviewRateLimits': { tableReadBridgeLimiter: pass, tableWriteBridgeLimiter: pass },
    '../stores/webpage/bridgeGrants': {
        getBridgeGrants: async (id) => { touched.push({ what: 'getBridgeGrants', args: [id] }); return { tables: [BINDING] }; },
    },
    '../auth/datatableAccess': { resolveDatatablePrincipalForUser: async (userId) => ({ userId }) },
    '../core/dataEngine/datatableRuntime': {
        resolveForPrincipal: async () => ({}),
        readRows: async (resolved, opts) => { touched.push({ what: 'readRows', args: [opts] }); return { rows: [], hasMore: false }; },
        insertRow: async (resolved, opts) => { touched.push({ what: 'insertRow', args: [opts] }); return { id: 'r1' }; },
        updateRow: async (resolved, opts) => { touched.push({ what: 'updateRow', args: [opts] }); return { row: {} }; },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:webpages-preview-tables-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]webpagesPreviewTables\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./webpagesPreviewTables');
test.after(() => { Module._resolveFilename = originalResolve; });

// Een schemaweigering reist als fout naar de eindhandler, dus het harnas moet
// die beantwoorden zoals index.js dat doet.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ url, body }) {
    return new Promise((resolve, reject) => {
        const req = {
            method: 'POST', url, originalUrl: url, path: url, body, query: {}, headers: {},
            get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: POST ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { touched.length = 0; });

const QUERY = '/wp1/tables/tbl_1/query';

async function refuses(request, field) {
    const res = await dispatch(request);
    assert.strictEqual(res.statusCode, 400, `${request.url} -> ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.ok(res.body.details.some((d) => d.path === field),
        `de 400 moet ${field} noemen; hij zei ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'een geweigerd verzoek opent de tabel niet');
    return res;
}

// ═══ query — elke weggevallen sleutel was een BREDER antwoord ═══════

test('een filter in het enkelvoud wordt geweigerd, niet beantwoord met elke rij', async () => {
    await refuses({ url: QUERY, body: { filter: [{ field: 'status', op: 'eq', value: 'open' }] } }, 'body');
});

test('één filter-object in plaats van een lijst wordt geweigerd, niet een lege lijst', async () => {
    const res = await refuses({ url: QUERY, body: { filters: { field: 'status', op: 'eq', value: 'open' } } }, 'body.filters');
    assert.strictEqual(res.body.error, 'filters is a list of { field, op, value } conditions.');
});

test('een zoekvraag die deze brug niet doorgeeft wordt geweigerd, niet stil genegeerd', async () => {
    await refuses({ url: QUERY, body: { search: { value: 'jan', fields: ['name'] } } }, 'body');
});

test('een sortering als los woord wordt geweigerd in plaats van stil de standaard', async () => {
    const res = await refuses({ url: QUERY, body: { sort: 'name' } }, 'body.sort');
    assert.strictEqual(res.body.error, 'sort is { field, dir } or a list of those, dir "asc" or "desc".');
});

test('een richting die de compiler niet leest wordt geweigerd, niet stil aflopend gesorteerd', async () => {
    for (const sort of [
        { field: 'name', order: 'asc' },
        { field: 'name', dir: 'ascending' },
        [{ field: 'name', direction: 'up' }],
        { dir: 'asc' },
    ]) {
        const res = await dispatch({ url: QUERY, body: { sort } });
        assert.strictEqual(res.statusCode, 400, JSON.stringify(sort));
        assert.strictEqual(res.body.error, 'sort is { field, dir } or a list of those, dir "asc" or "desc".', JSON.stringify(sort));
        assert.ok(res.body.details.every((d) => d.path.startsWith('body.sort')), JSON.stringify(res.body.details));
    }
    assert.deepStrictEqual(touched, [], 'een geweigerd verzoek opent de tabel niet');
});

test('de richtingen die de compiler kent komen ongewijzigd door, ook in hoofdletters', async () => {
    for (const sort of [{ field: 'name', dir: 'asc' }, { field: 'name', direction: 'DESC' }, [{ field: 'name' }]]) {
        touched.length = 0;
        const res = await dispatch({ url: QUERY, body: { sort } });
        assert.strictEqual(res.statusCode, 200, JSON.stringify(sort));
        assert.deepStrictEqual(touched.find((t) => t.what === 'readRows').args[0].sort, sort);
    }
});

test('limit 0 wordt geweigerd in plaats van stil de standaardpagina', async () => {
    const res = await refuses({ url: QUERY, body: { limit: 0 } }, 'body.limit');
    assert.strictEqual(res.body.error, 'limit is a whole number of rows, at least 1.');
});

test('een onbekende combinator krijgt één zin, zonder zod-binnenwerk', async () => {
    const res = await refuses({ url: QUERY, body: { match: 'or' } }, 'body.match');
    assert.strictEqual(res.body.error, 'match is "all" or "any".');
});

test('wat een bf-element stuurt komt ongewijzigd door', async () => {
    const res = await dispatch({ url: QUERY, body: { limit: 500 } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'readRows').args[0].limit, 500);
});

test('een volledige paginavraag komt door, met null als "niet ingesteld"', async () => {
    const res = await dispatch({
        url: QUERY,
        body: {
            filters: [{ field: 'status', op: 'eq', value: 'open' }], match: 'any',
            sort: [{ field: 'name', dir: 'asc' }], limit: '20', cursor: null,
        },
    });
    assert.strictEqual(res.statusCode, 200);
    const opts = touched.find((t) => t.what === 'readRows').args[0];
    assert.deepStrictEqual(opts.filters, [{ field: 'status', op: 'eq', value: 'open' }]);
    assert.strictEqual(opts.match, 'any');
    assert.strictEqual(opts.limit, 20, 'een getal als tekst telde altijd al');
    assert.deepStrictEqual(opts.allowColumns, BINDING.columns);
});

test('filters: null vraagt om alle rijen, en krijgt die', async () => {
    const res = await dispatch({ url: QUERY, body: { filters: null } });
    assert.strictEqual(res.statusCode, 200);
});

test('een lege body is de kale vraag, zoals altijd', async () => {
    const res = await dispatch({ url: QUERY, body: undefined });
    assert.strictEqual(res.statusCode, 200);
});

// ═══ insert / update — de runner houdt zijn eigen codes ═════════════

test('een verkeerd gespelde values op insert wordt geweigerd vóór de binding', async () => {
    await refuses({ url: '/wp1/tables/tbl_1/insert', body: { value: { name: 'x' } } }, 'body');
});

test('wat de shim bij insert en update stuurt komt ongewijzigd bij de runner', async () => {
    const ins = await dispatch({ url: '/wp1/tables/tbl_1/insert', body: { values: { name: 'x' } } });
    assert.strictEqual(ins.statusCode, 200);
    const upd = await dispatch({
        url: '/wp1/tables/tbl_1/update',
        body: { rowId: 'r1', values: { status: 'done' }, expectedUpdatedAt: '2026-09-22T10:00:00.000Z' },
    });
    assert.strictEqual(upd.statusCode, 200);
    const u = touched.find((t) => t.what === 'updateRow').args[0];
    assert.strictEqual(u.rowId, 'r1');
    assert.deepStrictEqual(u.values, { status: 'done' });
    assert.strictEqual(u.expectedUpdatedAt, '2026-09-22T10:00:00.000Z');
});

test('een update zonder expectedUpdatedAt bereikt de runner, die zijn eigen weigering geeft', async () => {
    const res = await dispatch({ url: '/wp1/tables/tbl_1/update', body: { rowId: 'r1', values: { status: 'x' } } });
    assert.strictEqual(res.statusCode, 200, 'de runner-mock weigert niet; de echte doet dat met expected_updated_at_required');
    assert.strictEqual(touched.find((t) => t.what === 'updateRow').args[0].expectedUpdatedAt, undefined);
});
