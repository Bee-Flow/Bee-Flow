/**
 * What knowledge-base creation accepts, and what it says when it refuses
 * (routes/knowledgeBases/create.js).
 *
 * `sourceKind` is the key this route deliberately ignores — everything made
 * here is a manual KB — and ignoring it in silence is how a caller asking for
 * another kind was told it had worked. `?withSurces=1` was the same failure
 * on the duplicate route: the copy arrived without the sources the person
 * asked for, with a 200 over it. What this file pins is the part a caller can
 * act on:
 *
 *   - the 400 NAMES the field (`body.name`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - the store is never reached, so a refused request changes nothing.
 *
 * Run: cd server && node --test --test-force-exit routes/knowledgeBases/create.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store call lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const KB = { id: 'kb1', name: 'Handbook', organization_id: 'org1', description: '', usage_contexts: null };

const MOCKS = {
    '../../stores/knowledgeBases': {
        getKB: async (id) => { touched.push({ what: 'getKB', args: [id] }); return { ...KB }; },
        createKB: async (...a) => { touched.push({ what: 'createKB', args: a }); return { id: 'kb9' }; },
    },
    '../../auth': {
        requireAuth: pass,
        requirePermission: () => pass,
        assertUserCanUseOrg: async (_req, orgId) => orgId || 'org1',
    },
    './shared': {
        getUserId: (req) => req.session?.user?.id || null,
        canAccessKB: async () => true,
        sanitizeUsageContexts: (v) => (Array.isArray(v) && v.length ? v : null),
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:kb-create-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /knowledgeBases[\\/]create\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./create');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, body = {} }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
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

/** Assert: refused with 400, the named field is in `details`, nothing touched. */
async function refuses(request, field) {
    const res = await dispatch(request);
    const what = `${request.method} ${request.url} ${JSON.stringify(request.body)}`;
    assert.strictEqual(res.statusCode, 400, what);
    assert.strictEqual(res.body.code, 'invalid_request', what);
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
}

// ═══ POST / ═════════════════════════════════════════════════════════

test('a knowledge base with no name is refused in words, not with "Required"', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A knowledge base needs a name.', 'the caller reads this sentence');
    assert.ok(res.body.details.some((d) => d.path === 'body.name'));
    assert.deepStrictEqual(touched, []);
});

test('a blank name gets the same sentence as a missing one', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { name: '   ' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A knowledge base needs a name.');
});

test('a numeric name is refused by name, instead of "Name is required" for a name that was there', async () => {
    await refuses({ method: 'POST', url: '/', body: { name: 42 } }, 'body.name');
});

test('asking for another source kind is refused rather than quietly overruled', async () => {
    // Everything made here is a manual KB. Answering 201 to `sourceKind`
    // tells the caller it got the kind it asked for.
    await refuses({ method: 'POST', url: '/', body: { name: 'Handbook', sourceKind: 'webpage' } }, 'body');
});

test('usage contexts must be a list, and the bad entry is named by index', async () => {
    await refuses({ method: 'POST', url: '/', body: { name: 'Handbook', usageContexts: 'chat' } }, 'body.usageContexts');
    await refuses({ method: 'POST', url: '/', body: { name: 'Handbook', usageContexts: ['chat', 7] } }, 'body.usageContexts.1');
});

test('a name is trimmed once, by the schema, on its way to the store', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { name: '  Handbook  ' } });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(touched.find((t) => t.what === 'createKB').args[1], 'Handbook');
});

// ═══ POST /:id/duplicate ════════════════════════════════════════════

test('a misspelled withSources is refused rather than copying nothing with a 200', async () => {
    // `?withSurces=1` copied the shell and none of the sources, and said the
    // duplicate had worked.
    await refuses({ method: 'POST', url: '/kb1/duplicate?withSurces=1' }, 'query');
});
