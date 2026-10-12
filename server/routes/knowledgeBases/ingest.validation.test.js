/**
 * What the hand-fed KB ingestion routes accept, and what they say when they
 * refuse (routes/knowledgeBases/ingest.js).
 *
 * "Content is required (min 3 chars)" was the answer to a snippet that WAS
 * there but arrived as a number, and a misspelled `titel` was answered with a
 * 201 — the document was filed as "Text snippet" and the person who typed a
 * title never learned why it was not there. What this file pins is the part a
 * caller can act on:
 *
 *   - the 400 NAMES the field (`body.content`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - the store is never reached, so a refused request changes nothing.
 *
 * `POST /:id/ingest/file` has no schema: its body is a multipart upload, and
 * "no file" is multer's answer, not a JSON field's.
 *
 * Run: cd server && node --test --test-force-exit routes/knowledgeBases/ingest.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── Fixtures ────────────────────────────────────────────────────────
// Every store and ingestion call lands in `touched`. A refused request must
// leave it empty.
const touched = [];

const KB = { id: 'kb1', tenant_id: 'owner1', organization_id: 'org1' };
const pass = (req, res, next) => next();

const MOCKS = {
    '../../stores/knowledgeBases': {
        getKB: async (id) => { touched.push({ what: 'getKB', args: [id] }); return { ...KB }; },
    },
    '../../auth': { requireAuth: pass, requirePermission: () => pass },
    '../../core/kb/kbIngestionHelpers': {
        extractFileContentWithMeta: async () => ({ text: '', meta: {} }),
        fetchUrlContent: async (u) => { touched.push({ what: 'fetchUrlContent', args: [u] }); return { content: '# Page', title: 'Page', resolvedUrl: u }; },
        ingestDocument: async (...a) => { touched.push({ what: 'ingestDocument', args: a }); return { document: { id: 'd1' }, chunks: 2 }; },
    },
    './shared': {
        getUserId: (req) => req.session?.user?.id || null,
        canAccessKB: async () => true,
        blockIfSystemKB: () => false,
        ensureKbSource: async (...a) => { touched.push({ what: 'ensureKbSource', args: a }); return { id: 's1' }; },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:kb-ingest-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /knowledgeBases[\\/]ingest\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./ingest');
test.after(() => { Module._resolveFilename = originalResolve; });

const { dispatcher } = require('../../core/http/routeHarness');

const dispatch = dispatcher(router);

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

// ═══ POST /:id/ingest/text ══════════════════════════════════════════

test('a snippet that is not text is refused by name, not called missing', async () => {
    await refuses({ method: 'POST', url: '/kb1/ingest/text', body: { content: 42 } }, 'body.content');
});

test('absent and blank get the same sentence, and it says how much is enough', async () => {
    const missing = await dispatch({ method: 'POST', url: '/kb1/ingest/text', body: {} });
    const blank = await dispatch({ method: 'POST', url: '/kb1/ingest/text', body: { content: ' ' } });
    for (const res of [missing, blank]) {
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(res.body.error, 'A text snippet needs at least three characters of text.');
        assert.ok(res.body.details.some((d) => d.path === 'body.content'));
    }
    assert.deepStrictEqual(touched, []);
});

test('a misspelled title is refused rather than filed as "Text snippet" with a 201', async () => {
    await refuses({ method: 'POST', url: '/kb1/ingest/text', body: { content: 'We open at nine.', titel: 'Openingstijden' } }, 'body');
});

test('an accepted snippet is stored as it was typed, with its title trimmed once', async () => {
    const res = await dispatch({ method: 'POST', url: '/kb1/ingest/text', body: { content: '  We open at nine.  ', title: '  Hours  ' } });
    assert.strictEqual(res.statusCode, 201);
    const ingested = touched.find((t) => t.what === 'ingestDocument');
    assert.strictEqual(ingested.args[2], '  We open at nine.  ', 'the snippet keeps its own whitespace');
    assert.strictEqual(ingested.args[3], 'Hours');
});

// ═══ POST /:id/ingest/url ═══════════════════════════════════════════

test('an address that is not text is refused by name, before anything is fetched', async () => {
    await refuses({ method: 'POST', url: '/kb1/ingest/url', body: { url: 42 } }, 'body.url');
});

test('no address at all is refused in words, not with "Required"', async () => {
    const res = await dispatch({ method: 'POST', url: '/kb1/ingest/url', body: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'An address is required — the page to read.');
    assert.deepStrictEqual(touched, [], 'and nothing is fetched');
});
