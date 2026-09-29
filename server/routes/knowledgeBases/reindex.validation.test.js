/**
 * What the re-index accepts (routes/knowledgeBases/reindex.js): nothing but
 * the id in the path.
 *
 * A re-index re-fetches and re-embeds EVERY source of a knowledge base. The
 * body used to be ignored, so a caller that asked for less — a list of
 * sources, a dry run — started the whole pass anyway, with a 200 over it.
 * What this file pins:
 *
 *   - a body key is refused and named, and no source is touched;
 *   - no body at all (what the Studio sends) and `{}` still re-index.
 *
 * Run: cd server && node --test routes/knowledgeBases/reindex.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every source the engine is asked to sync lands in `touched`.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
    '../../stores/knowledgeBases': {
        getKB: async (id) => ({ id, name: 'Handboek' }),
        countDocuments: async () => 0,
    },
    '../../stores/kbSources': {
        listByKb: async () => [{ id: 's1', name: 'Website' }, { id: 's2', name: 'Uploads' }],
    },
    '../../auth': { requireAuth: pass, requirePermission: () => pass },
    './shared': { canAccessKB: async () => true, blockIfSystemKB: () => false },
    '../../core/kb/sources': {
        syncSource: async (source, opts) => { touched.push({ what: 'syncSource', args: [source.id, opts.reason] }); return { updated: 1 }; },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:kb-reindex-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /knowledgeBases[\\/]reindex\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./reindex');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch(body) {
    const url = '/kb1/reindex';
    return new Promise((resolve, reject) => {
        const req = {
            method: 'POST', url, originalUrl: url, path: url, body, query: {}, headers: {},
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
            if (!err) return reject(new Error(`fell through: POST ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { touched.length = 0; });

test('a body that asks for less than everything is refused, and no source is re-embedded', async () => {
    for (const body of [{ sourceIds: ['s1'] }, { dryRun: true }, { force: false }]) {
        const res = await dispatch(body);
        const what = JSON.stringify(body);
        assert.strictEqual(res.statusCode, 400, what);
        assert.strictEqual(res.body.code, 'invalid_request', what);
        assert.ok(res.body.details.some((d) => d.path === 'body' && d.message.includes(Object.keys(body)[0])),
            `the refusal must name the key; it said ${JSON.stringify(res.body.details)}`);
        assert.deepStrictEqual(touched, [], `${what} must not start a re-index`);
    }
});

test('no body — what the Studio sends — re-indexes every source', async () => {
    const res = await dispatch(undefined);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.map((t) => t.args), [['s1', 'reembed'], ['s2', 'reembed']]);
    assert.strictEqual(res.body.sources, 2);
});

test('an empty object is the same as no body', async () => {
    const res = await dispatch({});
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.length, 2);
});
