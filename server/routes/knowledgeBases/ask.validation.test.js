/**
 * What the Studio's test question accepts, and what it says when it refuses
 * (routes/knowledgeBases/ask.js).
 *
 * The question was read as `String(req.body?.question || '')`, so anything
 * with a truthy value became text: an object was asked as "[object Object]",
 * a number as its digits, and a misspelled key as "A question is required"
 * without saying which key was wrong. This route streams, so a refusal has to
 * happen before the first header or it cannot be a status at all. What this
 * file pins:
 *
 *   - the 400 NAMES the field (`body.question`), in a sentence;
 *   - a refused question is never searched and never reaches a model;
 *   - a padded question is trimmed once, on its way in.
 *
 * The length cap (a refusal, where it used to be a silent cut at 2000) is in
 * ask.test.js, next to the other properties of the stream.
 *
 * Run: cd server && node --test routes/knowledgeBases/ask.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every search and model call lands in `touched`. A refused question must
// leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
    '../../stores/knowledgeBases': {
        getKB: async (id) => ({ id, name: 'Handboek', organization_id: 'org1' }),
    },
    '../../auth': { requireAuth: pass },
    './shared': {
        canAccessKB: async () => true,
        getUserId: (req) => req.session?.user?.id || null,
    },
    '../../core/llm/modelResolver': {
        TIER_DEFAULTS: { fast: { modelId: 'model-fast' } },
        getUserTierMap: async () => ({ fast: { modelId: 'model-fast', maxTokens: 1024 } }),
    },
    '../../core/agentRuntime/knowledgeSearch': {
        quickKBSearch: async (...a) => {
            touched.push({ what: 'quickKBSearch', args: a });
            return [{ id: 'c1', title: 'Handboek', content: 'Twee dagen.', source_uri: 'h.pdf' }];
        },
    },
    '../../stores/kbSources': { listByKb: async () => [] },
    '../../core/aiAgent': {
        getProviderForModel: async (modelId) => ({ apiKey: 'k', url: 'https://u/', providerType: 'test', modelId }),
    },
    '../../core/providers': {
        getAdapter: () => ({
            async stream(apiKey, apiUrl, modelId, messages, options, onEvent) {
                touched.push({ what: 'stream', args: [messages] });
                onEvent('text', { text: 'Twee dagen.' });
            },
        }),
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:kb-ask-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /knowledgeBases[\\/]ask\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./ask');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch(body) {
    const url = '/kb1/ask';
    return new Promise((resolve, reject) => {
        const req = {
            method: 'POST', url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: { user: { id: 'u1' } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false, frames: [],
            status(c) { this.statusCode = c; return this; },
            writeHead(c) { this.statusCode = c; this.headersSent = true; return this; },
            write(frame) { this.frames.push(frame); return true; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error('fell through: POST /kb1/ask'));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { touched.length = 0; });

/** Assert: refused with 400 before any header, the field named, nothing asked. */
async function refuses(body, field) {
    const res = await dispatch(body);
    const what = JSON.stringify(body);
    assert.strictEqual(res.statusCode, 400, what);
    assert.strictEqual(res.body.code, 'invalid_request', what);
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(res.frames, [], 'no stream was opened');
    assert.deepStrictEqual(touched, [], 'a refused question is neither searched nor asked');
    return res;
}

test('no question at all is answered in words, not with "Required"', async () => {
    for (const body of [undefined, {}]) {
        const res = await refuses(body, 'body.question');
        assert.strictEqual(res.body.error, 'Type a question to test this knowledge base with.');
    }
});

test('an object is refused, not asked as "[object Object]"', async () => {
    await refuses({ question: { text: 'Hoeveel verlof?' } }, 'body.question');
});

test('a number is refused by name rather than asked as its digits', async () => {
    await refuses({ question: 42 }, 'body.question');
});

test('a misspelled key is named in the refusal, not only reported as a missing question', async () => {
    const res = await refuses({ qustion: 'Hoeveel verlof?' }, 'body');
    assert.ok(res.body.details.some((d) => d.path === 'body' && /qustion/.test(d.message)),
        `the refusal must name the key it did not know; it said ${JSON.stringify(res.body.details)}`);
});

test('a padded question is trimmed once, on its way to the search and the model', async () => {
    const res = await dispatch({ question: '  Hoeveel verlof?  ' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'quickKBSearch').args[2], 'Hoeveel verlof?');
    const [messages] = touched.find((t) => t.what === 'stream').args;
    assert.strictEqual(messages[1].content, 'Hoeveel verlof?');
});
