/**
 * POST /agents/:id/persona/parse (A1c) — the gate, and what happens to what
 * the model says.
 *
 * The endpoint exists to turn a hand-written prompt back into fields, which
 * means its input is a model completion: untrusted, like any request body. The
 * tests below pin the three things that follow from that — the enum narrows,
 * the automation id never survives, and the parse never writes — plus the editor
 * gate, because the endpoint reads the agent's own concept prompt when the
 * caller sends no text.
 *
 * The real `personaPrompt` does the clamping; only the LLM client, the store
 * and the auth helpers are stubbed.
 *
 * Run: cd server && node --test --test-force-exit routes/agents/persona.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const mw = () => (req, res, next) => next();

const fx = {
    userId: 'owner',
    agent: null,
    canModify: true,
    structured: null,
    chatThrows: false,
    chatCalls: [],
    modelId: 'fast-model',
    modelThrows: false,
    modelCalls: [],
    orgThrows: false,
};

const MOCKS = {
    '../../stores/agentStore': { getAgent: async () => fx.agent },
    '../../core/llm/llmClient': {
        chatForcedTool: async (modelId, messages, toolDef, opts) => {
            fx.chatCalls.push({ modelId, messages, toolDef, opts });
            if (fx.chatThrows) throw new Error('provider down');
            return { structured: fx.structured, content: null };
        },
    },
    '../../core/llm/modelResolver': {
        resolveModelForTierName: async (tierName, opts) => {
            fx.modelCalls.push({ tierName, opts });
            // Onleesbaar is niet hetzelfde als niet ingericht.
            if (fx.modelThrows) throw new Error('config store unreachable');
            return fx.modelId;
        },
    },
    '../../auth': {
        requirePermission: mw,
        resolveUserOrgIds: async () => {
            if (fx.orgThrows) throw new Error('org lookup down');
            return new Set(['orgA']);
        },
    },
    '../../utils/routeHelpers': { getEffectiveUserId: () => fx.userId },
    '../../utils/perUserRateLimit': { perUserRateLimit: mw },
    './crud': { canModifyAgent: async () => fx.canModify },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:agent-persona-route:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /agents[\\/]persona\.js$/.test(parent.filename) && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./persona');
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');
test.after(() => { Module._resolveFilename = originalResolve; });

test.beforeEach(() => {
    fx.userId = 'owner';
    fx.agent = { id: 'a1', owner_id: 'owner', organization_id: 'orgA', system_prompt: 'You help with invoices. Never give tax advice.', persona: null };
    fx.canModify = true;
    fx.structured = { who: 'You help with invoices.', does: ['Answer invoice questions'], doesNot: ['Give tax advice'] };
    fx.chatThrows = false;
    fx.chatCalls = [];
    fx.modelId = 'fast-model';
    fx.modelThrows = false;
    fx.modelCalls = [];
    fx.orgThrows = false;
});

function dispatch(body = {}, url = '/a1/persona/parse') {
    return new Promise((resolve, reject) => {
        const request = {
            method: 'POST', url, body, headers: {},
            session: { user: { id: fx.userId } },
            get(name) { return this.headers[String(name).toLowerCase()]; },
        };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(request, res, (err) => {
            // A schema refusal travels as an error to the terminal handler,
            // so the harness has to answer one the way index.js does.
            if (!err) return reject(new Error('fell through router'));
            terminalErrorHandler(err, request, res, (e) => reject(e));
        });
    });
}

test('a parse returns the fields and writes nothing', async () => {
    const res = await dispatch({ text: 'You help with invoices. Never give tax advice.' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.persona.who, 'You help with invoices.');
    assert.deepStrictEqual(res.body.persona.doesNot, ['Give tax advice']);
    assert.strictEqual(res.body.persona.mode, 'fields');
    // Nothing in this file can write: the store mock exposes only getAgent, so
    // a save attempt would have thrown rather than passed quietly.
});

test('with no text supplied it reads the agent\'s own prompt', async () => {
    await dispatch({});
    assert.match(fx.chatCalls[0].messages[1].content, /You help with invoices\./);
});

test('a stored free text wins over the generated prompt as the thing to parse', async () => {
    fx.agent.persona = { mode: 'free', freeText: 'the text the editor is showing' };
    await dispatch({});
    assert.match(fx.chatCalls[0].messages[1].content, /the text the editor is showing/);
});

test('THE MODEL DOES NOT GET TO WIDEN: enum, mode and automation id are all overridden', async () => {
    fx.structured = {
        who: 'x',
        does: ['a'],
        unknown: { mode: 'handoff', automationId: 'auto-42' },
        mode: 'free',
        freeText: 'a prompt the model invented',
        language: 'klingon',
    };
    const res = await dispatch({ text: 'anything' });
    const p = res.body.persona;
    assert.strictEqual(p.unknown.automationId, null,
        'no model knows this installation\'s automation ids — anything there is a guess, and a guess there is a grant request');
    assert.strictEqual(p.mode, 'fields', 'a parse always lands in fields mode: that is the button the user pressed');
    assert.strictEqual(p.freeText, '');
    assert.strictEqual(p.language, null, 'a language nobody can name never becomes a prompt line');
    assert.strictEqual(p.unknown.mode, 'handoff', 'the mode itself is a suggestion the user reviews, and it survives');
});

test('an unreadable enum from the model lands on the narrowest mode', async () => {
    fx.structured = { who: 'x', does: ['a'], unknown: { mode: 'browse-the-internet' } };
    const res = await dispatch({ text: 'anything' });
    assert.strictEqual(res.body.persona.unknown.mode, 'honest');
});

test('a caller who may not edit this agent gets 403 and no inference', async () => {
    fx.canModify = false;
    const res = await dispatch({ text: 'anything' });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'agent_not_editable');
    assert.strictEqual(fx.chatCalls.length, 0, 'the endpoint reads the concept prompt — the gate comes first');
});

test('an unknown agent is 404, not a parse of nothing', async () => {
    fx.agent = null;
    const res = await dispatch({ text: 'anything' });
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(fx.chatCalls.length, 0);
});

test('nothing to read → 400, without spending an inference call', async () => {
    fx.agent.system_prompt = '';
    const res = await dispatch({});
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'persona_empty');
    assert.strictEqual(fx.chatCalls.length, 0);
});

test('an inference failure is a 502, and a refusal to answer a 422', async () => {
    fx.chatThrows = true;
    assert.strictEqual((await dispatch({ text: 'anything' })).statusCode, 502);

    fx.chatThrows = false;
    fx.structured = null;
    const res = await dispatch({ text: 'anything' });
    assert.strictEqual(res.statusCode, 422);
    assert.strictEqual(res.body.code, 'persona_parse_failed');
});

test('the text handed to the model is bounded', async () => {
    const { LIMITS } = require('../../core/agentRuntime/personaPrompt');
    await dispatch({ text: 'y'.repeat(LIMITS.freeText + 5000) });
    const sent = fx.chatCalls[0].messages[1].content;
    assert.ok(sent.length <= LIMITS.freeText + 100, `a paste may not become an unbounded prompt (${sent.length})`);
});

// ── Welk model leest deze instructietekst? ────────────────────────────
// Deze route stuurde de agent-instructies naar `resolveModelForTierName` met
// een hardgecodeerde `fallback: 'gemini-2.0-flash-lite'`. Een workspace die dat
// Google-model nooit koos — of die in EU-mode staat — kreeg het toch, zonder
// dat er iets van te zien was. Geen beoordelaar/lezer ingericht is een
// weigering, geen stille keuze.

test('geen model ingericht → weigeren, en de instructietekst gaat nergens heen', async () => {
    fx.modelId = null;
    const res = await dispatch({ text: 'You help with invoices.' });
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.code, 'no_persona_model');
    assert.ok(/configured/i.test(res.body.error), 'de reden hoort leesbaar te zijn');
    assert.strictEqual(fx.chatCalls.length, 0, 'er ging geen tekst naar enig model');
    assert.ok(!fx.modelCalls[0].opts?.fallback,
        `de route vroeg om fallback ${fx.modelCalls[0].opts?.fallback}`);
});

test('een model dat niet GELEZEN kon worden is een ander antwoord dan geen model', async () => {
    fx.modelThrows = true;
    const res = await dispatch({ text: 'You help with invoices.' });
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.code, 'persona_model_unavailable');
    assert.notStrictEqual(res.body.code, 'no_persona_model');
    assert.strictEqual(fx.chatCalls.length, 0);
});

test('een workspace die niet te bepalen was weigert, in plaats van als "geen workspace" te lezen', async () => {
    // userOrgId stuurt de EU-override en de org-tier. Een mislukte resolve als
    // `null` lezen betekent: de globale (niet-EU) tiermap, en dus mogelijk een
    // ander model dan deze organisatie koos.
    fx.orgThrows = true;
    const res = await dispatch({ text: 'You help with invoices.' });
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.code, 'org_check_failed');
    assert.strictEqual(fx.chatCalls.length, 0);
    assert.strictEqual(fx.modelCalls.length, 0, 'zonder workspace wordt er niet eens een tier opgezocht');
});

test('met configuratie leest het GEKOZEN model, op de fast-tier', async () => {
    fx.modelId = 'org-chosen-fast';
    await dispatch({ text: 'You help with invoices.' });
    assert.strictEqual(fx.chatCalls[0].modelId, 'org-chosen-fast');
    assert.deepStrictEqual(fx.modelCalls.map(c => c.tierName), ['fast']);
    assert.strictEqual(fx.modelCalls[0].opts.userOrgId, 'orgA');
});

test('a misspelled key is refused rather than parsing the STORED prompt instead', async () => {
    // One key is read here: the text on screen. `txt` fell through to the
    // agent's own saved prompt, so the cards came back 200 describing
    // something the person was not looking at.
    const res = await dispatch({ txt: 'You help with invoices.' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.ok(res.body.details.some((d) => d.path === 'body'), JSON.stringify(res.body.details));
});

test('a text that is not text is refused by name', async () => {
    const res = await dispatch({ text: 42 });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.text'), JSON.stringify(res.body.details));
});
