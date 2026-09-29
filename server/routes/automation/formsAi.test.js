'use strict';

/**
 * routes/automation/formsAi — "Build it with AI" for a form.
 *
 * Pinned:
 *   - NOTHING IS STORED: the route answers a draft and touches no store;
 *   - create without a brief is 400 `no_brief`; revise without a note or the
 *     current questions is 400 (`no_note` / `no_current`);
 *   - no model configured is 503 `no_model`, not a 500;
 *   - an answer the clamps refuse is 502 `ai_unusable`;
 *   - the model is asked with the forced tool and the brief fenced;
 *   - every call writes ONE usage row (`chatForcedTool` logs nothing).
 *
 * DB-free: dependencies are stubbed through a `Module._resolveFilename` hook
 * keyed on this route file; `automation/formDraft` stays REAL — the clamps
 * are the contract.
 *
 * Run: cd server && node --test --test-force-exit routes/automation/formsAi.test.js
 */

const test = require('node:test');
const { beforeEach, describe } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const fx = { model: 'claude-fast', structured: null, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, calls: [] };
const rec = (name, args) => { fx.calls.push({ name, args }); };
const lastCall = (name) => [...fx.calls].reverse().find(c => c.name === name);

const MOCKS = {
    '../../utils/perUserRateLimit': { perUserRateLimit: () => (req, res, next) => next() },
    '../../stores/userStore': { getUser: async () => ({ id: 'u1', organizationId: 'org1' }) },
    '../../stores/usageStore': { logUsage: async (entry) => { rec('logUsage', entry); } },
    '../../core/llm/modelResolver': {
        resolveModelForTier: async () => fx.model,
        resolveModelWithGlobalFallback: async () => fx.model,
    },
    '../../core/llm/llmClient': {
        chatForcedTool: async (modelId, messages, toolDef, options) => {
            rec('chatForcedTool', { modelId, messages, toolDef, options });
            return { structured: fx.structured, content: null, usage: fx.usage };
        },
    },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:forms-ai:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]automation[\\/]formsAi\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};
const formsAi = require('./formsAi');
test.after(() => { Module._resolveFilename = originalResolve; });

function makeReq(body = {}) { return { body, session: { user: { id: 'u1' } } }; }
function makeRes() {
    const res = { statusCode: 200, body: undefined };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    return res;
}

const GOOD = {
    title: 'Vacation request',
    description: 'Ask before you book.',
    fields: [
        { label: 'Your name', type: 'text', required: true },
        { label: 'First day', type: 'date', required: true },
        { label: 'Department', type: 'select', options: ['Sales', 'Support'] },
    ],
    notes: '',
};

beforeEach(() => { fx.calls = []; fx.model = 'claude-fast'; fx.structured = { ...GOOD }; });

describe('POST /api/automation/forms/ai/draft', () => {
    test('a brief in, a form out, one usage row, nothing stored', async () => {
        const res = makeRes();
        await formsAi.draft(makeReq({ mode: 'create', brief: 'A vacation request form for our staff' }), res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.mode, 'create');
        assert.deepStrictEqual(res.body.draft.form.fields.map(f => f.name), ['your_name', 'first_day', 'department']);
        assert.strictEqual(res.body.draft.form.title, 'Vacation request');
        const ask = lastCall('chatForcedTool');
        assert.strictEqual(ask.args.toolDef.function.name, 'draft_form');
        assert.match(ask.args.messages[1].content, /<brief>\nA vacation request form for our staff\n<\/brief>/);
        assert.strictEqual(ask.args.modelId, 'claude-fast');
        const usage = lastCall('logUsage');
        assert.strictEqual(usage.args.source, 'form_ai_draft');
        assert.strictEqual(usage.args.total_tokens, 15);
        assert.strictEqual(fx.calls.filter(c => c.name === 'logUsage').length, 1);
    });

    test('revise: the current questions and the note travel, and kept names survive', async () => {
        fx.structured = { fields: [{ name: 'email', label: 'E-mail address', type: 'email' }, { label: 'Phone', type: 'text' }] };
        const res = makeRes();
        await formsAi.draft(makeReq({
            mode: 'revise', note: 'add a phone number',
            current: { title: 'Feedback', collect: true, fields: [{ name: 'email', type: 'email', label: 'Your e-mail', required: true }] },
        }), res);
        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(res.body.draft.form.fields.map(f => f.name), ['email', 'phone']);
        assert.strictEqual(res.body.draft.form.collect, true);
        assert.match(lastCall('chatForcedTool').args.messages[1].content, /\[name: email\] Your e-mail \(email, required\)/);
        assert.match(lastCall('chatForcedTool').args.messages[1].content, /<request>\nadd a phone number\n<\/request>/);
    });

    test('create without a brief → 400 no_brief; revise without a note → 400 no_note; without the current form → 400 no_current', async () => {
        let res = makeRes();
        await formsAi.draft(makeReq({ mode: 'create', brief: '   ' }), res);
        assert.strictEqual(res.statusCode, 400); assert.strictEqual(res.body.code, 'no_brief');
        res = makeRes();
        await formsAi.draft(makeReq({ mode: 'revise', current: { fields: [] } }), res);
        assert.strictEqual(res.statusCode, 400); assert.strictEqual(res.body.code, 'no_note');
        res = makeRes();
        await formsAi.draft(makeReq({ mode: 'revise', note: 'shorter' }), res);
        assert.strictEqual(res.statusCode, 400); assert.strictEqual(res.body.code, 'no_current');
        assert.strictEqual(lastCall('chatForcedTool'), undefined);
    });

    test('no model → 503 no_model', async () => {
        fx.model = null;
        const res = makeRes();
        await formsAi.draft(makeReq({ mode: 'create', brief: 'anything' }), res);
        assert.strictEqual(res.statusCode, 503);
        assert.strictEqual(res.body.code, 'no_model');
    });

    test('an unusable answer → 502 ai_unusable', async () => {
        fx.structured = { title: 'x', fields: [] };
        const res = makeRes();
        await formsAi.draft(makeReq({ mode: 'create', brief: 'anything' }), res);
        assert.strictEqual(res.statusCode, 502);
        assert.strictEqual(res.body.code, 'ai_unusable');
        // still counted: the tokens were spent
        assert.ok(lastCall('logUsage'));
    });
});
