'use strict';

/**
 * routes/automation/formsAi — "Build it with AI" for a form, and "Describe
 * the look" (POST /:id/forms/style-assist) further down.
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
 * Style assist, pinned: the answer is { css, notes, removed } with the CSS
 * sanitised; the prompt carries the questions' labels and the unsaved
 * style/theme/CSS, never an answer; left out, the saved form's are used; a
 * trigger that is no form is 409, an unknown one 400; no model 503; an
 * unusable answer 502 (still logged); one usage row, source form_ai_style;
 * the body: prompt 1..2000, customCss at most 20 000, no other keys. The edit
 * gate in front of it (forms.js) is covered by tenantIsolation.matrix.test.js.
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
const path = require('path');

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
const { StyleAssistBody } = require('./formStyleAssistBody.mts');
const SERVER = path.resolve(__dirname, '..', '..');
const { validate } = require(path.join(SERVER, 'core/http/validate'));
const { terminalErrorHandler } = require(path.join(SERVER, 'core/http/terminalErrorHandler'));
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
        await assert.rejects(formsAi.draft(makeReq({ mode: 'create', brief: 'anything' }), makeRes()),
            (err) => err.status === 503 && err.code === 'no_model');
    });

    test('an unusable answer → 502 ai_unusable', async () => {
        fx.structured = { title: 'x', fields: [] };
        await assert.rejects(formsAi.draft(makeReq({ mode: 'create', brief: 'anything' }), makeRes()),
            (err) => err.status === 502 && err.code === 'ai_unusable');
        // still counted: the tokens were spent
        assert.ok(lastCall('logUsage'));
    });
});

// ── POST /api/automation/:id/forms/style-assist ──────────────────────

const SAVED_STYLE = { font: 'serif', customCss: '.bf-form__title { color: #7a3e00 }' };
const AUTOMATION = {
    id: 'a1',
    definition: {
        trigger: {
            id: 'trg', kind: 'form',
            pinnedOutput: { email: 'visitor@example.com' },
            form: {
                title: 'Order a cake',
                theme: { primary: '#B45309' },
                style: SAVED_STYLE,
                fields: [{ name: 'email', type: 'email', label: 'Your e-mail' }, { name: 'cake', type: 'select', label: 'Which cake?', options: ['Apple', 'Cherry'] }],
            },
        },
        triggers: [{ id: 'hook', kind: 'webhook' }],
        steps: [
            { id: 'fp1', type: 'form_page', mode: 'input', form: { fields: [{ name: 'pickup', type: 'date', label: 'Pick-up day' }] } },
            { id: 'end', type: 'form_page', mode: 'ending', form: { title: 'Thanks' } },
        ],
        edges: [],
    },
};

function styleReq(body = {}) { return { params: { id: 'a1' }, body, session: { user: { id: 'u1' } } }; }
function styleRes(automation = AUTOMATION) {
    const res = { statusCode: 200, body: undefined, locals: { automation } };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    return res;
}

describe('POST /api/automation/:id/forms/style-assist', () => {
    beforeEach(() => {
        fx.structured = {
            css: '.bf-form__card { background: url(https://fonts.example/bg.jpg); border-radius: 24px }\n.bf-form__submit { border-radius: 999px }',
            notes: ['Rounded the card and the button.'],
        };
    });

    test('a look in words → sanitised CSS, the notes and what was removed; one usage row', async () => {
        const res = styleRes();
        await formsAi.styleAssist(styleReq({ prompt: 'a warm bakery look' }), res);
        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(res.body, {
            css: '.bf-form__card { border-radius: 24px }\n.bf-form__submit { border-radius: 999px }',
            notes: ['Rounded the card and the button.'],
            removed: ['outside address'],
        });
        const ask = lastCall('chatForcedTool');
        assert.strictEqual(ask.args.toolDef.function.name, 'style_form');
        assert.strictEqual(ask.args.modelId, 'claude-fast');
        const usage = fx.calls.filter(c => c.name === 'logUsage');
        assert.strictEqual(usage.length, 1);
        assert.strictEqual(usage[0].args.source, 'form_ai_style');
        assert.strictEqual(usage[0].args.total_tokens, 15);
    });

    test('the prompt carries the labels of the trigger and of every input page, never an answer', async () => {
        await formsAi.styleAssist(styleReq({ prompt: 'bigger inputs' }), styleRes());
        const user = lastCall('chatForcedTool').args.messages[1].content;
        assert.match(user, /- email: "Your e-mail" \(email\)/);
        assert.match(user, /- cake: "Which cake\?" \(select\)/);
        assert.match(user, /- pickup: "Pick-up day" \(date\)/);
        assert.ok(!user.includes('visitor@example.com'), 'the pinned sample answer stays out');
        assert.ok(!user.includes('Apple'), 'options are answers-to-be, not labels');
        assert.match(user, /<request>\nbigger inputs\n<\/request>/);
    });

    test('left out, the saved theme, style and CSS are used', async () => {
        await formsAi.styleAssist(styleReq({ prompt: 'darker' }), styleRes());
        const user = lastCall('chatForcedTool').args.messages[1].content;
        assert.match(user, /<theme>\n\{"primary":"#B45309"\}\n<\/theme>/);
        assert.match(user, /<form_style>\n\{"font":"serif"\}\n<\/form_style>/);
        assert.match(user, /<current_css>\n\.bf-form__title \{ color: #7a3e00 \}\n<\/current_css>/);
    });

    test('the editor\'s unsaved values win; null clears', async () => {
        await formsAi.styleAssist(styleReq({
            prompt: 'darker', theme: { primary: '#1D4ED8' }, style: { width: 'wide' }, customCss: null,
        }), styleRes());
        const user = lastCall('chatForcedTool').args.messages[1].content;
        assert.match(user, /<theme>\n\{"primary":"#1D4ED8"\}\n<\/theme>/);
        assert.match(user, /<form_style>\n\{"width":"wide"\}\n<\/form_style>/);
        assert.match(user, /<current_css>\n\(none\)\n<\/current_css>/);
    });

    test('a trigger that is no form → 409 not_a_form; an unknown trigger → 400; no model asked', async () => {
        await assert.rejects(formsAi.styleAssist(styleReq({ prompt: 'x', triggerStepId: 'hook' }), styleRes()),
            (err) => err.status === 409 && err.code === 'not_a_form');
        await assert.rejects(formsAi.styleAssist(styleReq({ prompt: 'x', triggerStepId: 'nope' }), styleRes()),
            (err) => err.status === 400 && err.code === 'invalid_trigger_step');
        assert.strictEqual(lastCall('chatForcedTool'), undefined);
    });

    test('no model → 503 no_model', async () => {
        fx.model = null;
        await assert.rejects(formsAi.styleAssist(styleReq({ prompt: 'x' }), styleRes()),
            (err) => err.status === 503 && err.code === 'no_model');
    });

    test('an unusable answer → 502 ai_unusable, still counted', async () => {
        fx.structured = { notes: ['I could not'] };
        await assert.rejects(formsAi.styleAssist(styleReq({ prompt: 'x' }), styleRes()),
            (err) => err.status === 502 && err.code === 'ai_unusable');
        assert.ok(lastCall('logUsage'));
    });
});

/** The body as forms.js validates it, through the real error handler. */
function dispatch(body) {
    return new Promise((resolve, reject) => {
        const req = {
            method: 'POST', url: '/a1/forms/style-assist', originalUrl: '/a1/forms/style-assist', path: '/a1/forms/style-assist',
            params: { id: 'a1' }, query: {}, body, headers: {}, session: { user: { id: 'u1' } },
            get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false, locals: { automation: AUTOMATION },
            set() { return this; }, setHeader() {},
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
        };
        validate({ body: StyleAssistBody })(req, res, (err) => {
            if (err) return terminalErrorHandler(err, req, res, (e) => reject(e));
            Promise.resolve(formsAi.styleAssist(req, res)).catch(reject);
        });
    });
}

describe('POST /api/automation/:id/forms/style-assist: the body', () => {
    beforeEach(() => { fx.structured = { css: '.bf-form__card { padding: 2rem }', notes: [] }; });

    test('no prompt, a blank one or one over 2 000 characters is refused before the model is asked', async () => {
        for (const body of [{}, { prompt: '   ' }, { prompt: 'x'.repeat(2001) }, undefined]) {
            const res = await dispatch(body);
            assert.strictEqual(res.statusCode, 400, JSON.stringify(body));
            assert.ok(res.body.details.some((d) => d.path === 'body.prompt'), JSON.stringify(res.body));
        }
        assert.strictEqual(lastCall('chatForcedTool'), undefined);
    });

    test('custom CSS over 20 000 characters is a 400', async () => {
        const res = await dispatch({ prompt: 'x', customCss: 'a'.repeat(20001) });
        assert.strictEqual(res.statusCode, 400);
        assert.ok(res.body.details.some((d) => d.path === 'body.customCss'));
    });

    test('a key the editor does not send is refused by name; a list is no style', async () => {
        let res = await dispatch({ prompt: 'x', values: { email: 'a@b.c' } });
        assert.strictEqual(res.statusCode, 400);
        assert.match(res.body.error, /does not take "values"/);
        res = await dispatch({ prompt: 'x', style: ['wide'] });
        assert.strictEqual(res.statusCode, 400);
        assert.ok(res.body.details.some((d) => d.path === 'body.style'));
    });

    test('a full body passes and is answered', async () => {
        const res = await dispatch({ prompt: '  a dark glass card ', triggerStepId: 'trg', style: { font: 'mono' }, theme: { appearance: 'dark' }, customCss: '' });
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.match(lastCall('chatForcedTool').args.messages[1].content, /<request>\na dark glass card\n<\/request>/);
    });
});
