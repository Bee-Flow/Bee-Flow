'use strict';

/**
 * What POST /api/automation/forms/ai/draft accepts, and what it says when it
 * refuses (routes/automation/formsAi.js).
 *
 * `mode` was read as `body.mode === 'revise' ? 'revise' : 'create'`, so
 * `mode: 'Revise'` — or any other spelling — DREW A NEW FORM over the one on
 * screen instead of changing it, and answered 200 with a draft that looked
 * plausible. The same class as `mode: 'defenition'` on the n8n route: a word
 * one letter off picks the other action, silently.
 *
 * `current` stays open on purpose — it is the form as the editor holds it,
 * and readCurrent() is already the allow-list of the parts the prompt quotes.
 *
 * Run: cd server && node --test routes/automation/formsAi.validation.test.js
 */

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const SERVER = path.resolve(__dirname, '..', '..');
function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

// Every model call lands in `touched`. A refused request must leave it empty.
const touched = [];

mock(path.join(SERVER, 'utils/perUserRateLimit'), { perUserRateLimit: () => (req, res, next) => next() });
mock(path.join(SERVER, 'core/llm/llmClient'), {
    chatForcedTool: async (...a) => { touched.push({ what: 'chatForcedTool', args: a }); return { structured: { form: { fields: [] } }, usage: {} }; },
});
mock(path.join(SERVER, 'stores/userStore'), { getUser: async (id) => ({ id, organizationId: 'org1' }) });
mock(path.join(SERVER, 'stores/usageStore'), { logUsage: async () => true });
mock(path.join(SERVER, 'core/llm/modelResolver'), {
    resolveModelForTier: async () => 'mistral-small-latest',
    resolveModelWithGlobalFallback: async () => 'mistral-small-latest',
});
mock(path.join(SERVER, 'automation/formDraft'), {
    DRAFT_TOOL: { name: 'draft_form' },
    MAX_BRIEF_CHARS: 4000,
    MAX_NOTE_CHARS: 2000,
    buildDraftMessages: () => [],
    parseFormDraft: (structured) => (structured ? { form: structured.form, notes: null } : null),
});

const { draft, DraftBody } = require('./formsAi');
const { validate } = require(path.join(SERVER, 'core/http/validate'));
const { terminalErrorHandler } = require(path.join(SERVER, 'core/http/terminalErrorHandler'));

/** The two middlewares crud.js registers, in that order. */
function dispatch({ body }) {
    return new Promise((resolve, reject) => {
        const req = {
            method: 'POST', url: '/forms/ai/draft', originalUrl: '/forms/ai/draft', path: '/forms/ai/draft',
            query: {}, body, headers: {}, session: { user: { id: 'u1', organizationId: 'org1' } },
            get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            set() { return this; }, setHeader() {},
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
        };
        validate({ body: DraftBody })(req, res, (err) => {
            if (err) return terminalErrorHandler(err, req, res, (e) => reject(e));
            Promise.resolve(draft(req, res)).catch(reject);
        });
    });
}

test.beforeEach(() => { touched.length = 0; });

test('a mis-cased mode is refused, not read as "draw a new form over this one"', async () => {
    const res = await dispatch({ body: { mode: 'Revise', note: 'add a phone field', current: { title: 'Intake' } } });
    assert.strictEqual(res.statusCode, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body.error, 'mode is "create" or "revise".');
    assert.ok(res.body.details.some((d) => d.path === 'body.mode'));
    assert.deepStrictEqual(touched, [], 'and no model is asked for a draft');
});

test('a key the panel does not send is refused rather than quietly dropped', async () => {
    const res = await dispatch({ body: { mode: 'create', prompt: 'an intake form' } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body'));
    assert.deepStrictEqual(touched, []);
});

test('a current form that is a list, not a document, is refused by name', async () => {
    const res = await dispatch({ body: { mode: 'revise', note: 'x', current: [] } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.current'));
    assert.deepStrictEqual(touched, []);
});

test('no mode at all still means "create", from the schema', async () => {
    const res = await dispatch({ body: { brief: 'an intake form for suppliers' } });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.mode, 'create');
});

test('the two words this route knows still pick the two actions', async () => {
    const res = await dispatch({ body: { mode: 'revise', note: 'add a phone field', current: { title: 'Intake' } } });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.mode, 'revise');
    assert.strictEqual(touched.length, 1, 'and the model was asked exactly once');
});
