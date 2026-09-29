'use strict';

/**
 * routes/datatablesAi — "Build it with AI" for a datatable.
 *
 * Pinned:
 *   - NOTHING IS STORED: the route answers a draft and touches no store;
 *   - create without a brief is 400 `no_brief`; revise without a note or the
 *     current columns is 400 (`no_note` / `no_current`); a locked kind
 *     (cache, mirror, form answers) is 409 `schema_locked` before any model call;
 *   - `allowDestructive` defaults to FALSE and reaches both the prompt and
 *     the clamps: a left-out column comes back;
 *   - no model configured is 503 `no_model`, not a 500;
 *   - an answer the clamps refuse is 502 `ai_unusable`;
 *   - the model is asked with the forced tool and the brief fenced;
 *   - every call writes ONE usage row (`chatForcedTool` logs nothing).
 *
 * DB-free: dependencies are stubbed through a `Module._resolveFilename` hook
 * keyed on this route file; `automation/formDraft` stays REAL — the clamps
 * are the contract.
 *
 * Run: cd server && node --test --test-force-exit routes/datatablesAi.test.js
 */

const test = require('node:test');
const { beforeEach, describe } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const fx = { model: 'claude-fast', structured: null, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, calls: [] };
const rec = (name, args) => { fx.calls.push({ name, args }); };
const lastCall = (name) => [...fx.calls].reverse().find(c => c.name === name);

const MOCKS = {
    '../utils/perUserRateLimit': { perUserRateLimit: () => (req, res, next) => next() },
    '../stores/userStore': { getUser: async () => ({ id: 'u1', organizationId: 'org1' }) },
    '../stores/usageStore': { logUsage: async (entry) => { rec('logUsage', entry); } },
    '../core/llm/modelResolver': {
        resolveModelForTier: async () => fx.model,
        resolveModelWithGlobalFallback: async () => fx.model,
    },
    '../core/llm/llmClient': {
        chatForcedTool: async (modelId, messages, toolDef, options) => {
            rec('chatForcedTool', { modelId, messages, toolDef, options });
            return { structured: fx.structured, content: null, usage: fx.usage };
        },
    },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:datatables-ai:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]datatablesAi\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};
const datatablesAi = require('./datatablesAi');
test.after(() => { Module._resolveFilename = originalResolve; });

function makeReq(body = {}) { return { body, session: { user: { id: 'u1' } } }; }
function makeRes() {
    const res = { statusCode: 200, body: undefined };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    return res;
}

const GOOD = {
    name: 'Invoices',
    description: 'One row per supplier invoice, kept for the audit.',
    fields: [
        { name: 'Supplier', type: 'text', required: true },
        { name: 'Amount', type: 'number' },
        { name: 'Status', type: 'select', options: ['New', 'Approved'] },
    ],
    notes: '',
};
const CURRENT = {
    name: 'Customers', rowCount: 12,
    fields: [{ id: 'fld_a1', key: 'email', name: 'E-mail', type: 'text' }, { id: 'fld_a2', key: 'notes', name: 'Notes', type: 'richtext' }],
};

beforeEach(() => { fx.calls = []; fx.model = 'claude-fast'; fx.structured = { ...GOOD }; });

describe('POST /api/datatables/ai/draft', () => {
    test('a brief in, a table out, one usage row, nothing stored', async () => {
        const res = makeRes();
        await datatablesAi.draft(makeReq({ mode: 'create', brief: 'Track supplier invoices with amount and status' }), res);
        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(res.body.draft.fields.map(f => f.key), ['supplier', 'amount', 'status']);
        assert.strictEqual(res.body.draft.key, 'invoices');
        const ask = lastCall('chatForcedTool');
        assert.strictEqual(ask.args.toolDef.function.name, 'draft_datatable');
        assert.match(ask.args.messages[1].content, /<brief>\nTrack supplier invoices with amount and status\n<\/brief>/);
        const usage = lastCall('logUsage');
        assert.strictEqual(usage.args.source, 'datatable_ai_draft');
        assert.strictEqual(fx.calls.filter(c => c.name === 'logUsage').length, 1);
    });

    test('revise: the guard is on by default — a left-out column comes back and the prompt says never remove', async () => {
        fx.structured = { fields: [{ key: 'email', name: 'E-mail address', type: 'text' }, { name: 'Phone', type: 'text' }] };
        const res = makeRes();
        await datatablesAi.draft(makeReq({ mode: 'revise', note: 'add a phone number', current: CURRENT }), res);
        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(res.body.draft.fields.map(f => f.key), ['email', 'notes', 'phone']);
        assert.deepStrictEqual(res.body.draft.changes.removed, []);
        assert.match(lastCall('chatForcedTool').args.messages[0].content, /Never remove or retype a column/);
        assert.match(lastCall('chatForcedTool').args.messages[1].content, /\[key: email\] E-mail \(text\)/);
    });

    test('revise with allowDestructive: the removal passes through and is reported', async () => {
        fx.structured = { fields: [{ key: 'email', name: 'E-mail', type: 'text' }] };
        const res = makeRes();
        await datatablesAi.draft(makeReq({ mode: 'revise', note: 'drop the notes', current: CURRENT, allowDestructive: true }), res);
        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(res.body.draft.fields.map(f => f.key), ['email']);
        assert.deepStrictEqual(res.body.draft.changes.removed, ['notes']);
        assert.match(lastCall('chatForcedTool').args.messages[0].content, /only when the request asks for it/);
    });

    test('400s: no brief, no note, no current; 409 for a locked kind before any model call', async () => {
        let res = makeRes();
        await datatablesAi.draft(makeReq({ mode: 'create', brief: ' ' }), res);
        assert.strictEqual(res.statusCode, 400); assert.strictEqual(res.body.code, 'no_brief');
        res = makeRes();
        await datatablesAi.draft(makeReq({ mode: 'revise', current: CURRENT }), res);
        assert.strictEqual(res.statusCode, 400); assert.strictEqual(res.body.code, 'no_note');
        res = makeRes();
        await datatablesAi.draft(makeReq({ mode: 'revise', note: 'x' }), res);
        assert.strictEqual(res.statusCode, 400); assert.strictEqual(res.body.code, 'no_current');
        res = makeRes();
        await datatablesAi.draft(makeReq({ mode: 'revise', note: 'x', current: { ...CURRENT, managedKind: 'form_answers' } }), res);
        assert.strictEqual(res.statusCode, 409); assert.strictEqual(res.body.code, 'schema_locked');
        assert.strictEqual(lastCall('chatForcedTool'), undefined);
    });

    test('no model → 503 no_model; an unusable answer → 502 ai_unusable', async () => {
        fx.model = null;
        let res = makeRes();
        await datatablesAi.draft(makeReq({ mode: 'create', brief: 'anything' }), res);
        assert.strictEqual(res.statusCode, 503); assert.strictEqual(res.body.code, 'no_model');
        fx.model = 'claude-fast';
        fx.structured = { name: 'x', fields: [] };
        res = makeRes();
        await datatablesAi.draft(makeReq({ mode: 'create', brief: 'anything' }), res);
        assert.strictEqual(res.statusCode, 502); assert.strictEqual(res.body.code, 'ai_unusable');
    });
});
