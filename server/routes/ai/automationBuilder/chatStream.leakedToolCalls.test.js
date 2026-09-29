/**
 * A tool call the model WROTE instead of made, and the rounds that follow it.
 *
 * Measured 2026-09-13 on the App Studio builder with the same Gemma 4 model
 * this route runs on: the fourth call of a build arrived as text inside the
 * thought channel, the round had no tool call and no content, and the loop
 * read it as "the model is done" — an empty canvas and a silent `done`.
 *
 * The parsing lives in core/llm/leakedToolCalls (one implementation, both
 * builders). What this file drives is the ROUTE's side of it: a written call
 * is recovered and run against THIS round's menu, the model is told in the
 * result that it never really made the call, a call the adapter had to close
 * after a cut says so too, a name the menu does not carry is nudged with the
 * specific mistake rather than guessed at, and a round that says nothing
 * twice ends with a sentence instead of a silent `done` — in BOTH builders,
 * which is why the app builder's loop is driven here as well.
 *
 * Run: cd server && node --test --test-force-exit routes/ai/automationBuilder/chatStream.leakedToolCalls.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');

const { createBuilderStream, call } = require('../../../testUtils/builderStreamHarness');

// Above `./chatTurnLoop`, deliberately: it reaches the builder tools and from
// there the draft store, and the harness can only replace a module nothing
// has loaded yet. It refuses to start if that has already happened.
const h = createBuilderStream();
after(() => h.restore());

const TURN_LOOP = require('./chatTurnLoop');
const CORE = require('../../../core/llm/leakedToolCalls');

const EMPTY_TURN_SENTENCE = 'The model stopped twice without calling a tool or saying anything — it wrote its next step as text instead of a call. Your draft is saved; send the message again, or switch the builder to another tier.';

/** The Hermes/Qwen spelling of a call the model typed out. */
const written = (name, args) => `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;

const DRAFT = {
    id: 'auto_1',
    userId: 'u1',
    title: 'Facturen',
    description: '',
    definition: {
        schemaVersion: 1,
        trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} },
        steps: [],
        edges: [],
        vars: {},
    },
};

test('chatTurnLoop binds the shared recovery and the empty-reply pair with the route prefix', () => {
    assert.strictEqual(TURN_LOOP.recoverLeakedToolCalls, CORE.recoverLeakedToolCalls);
    assert.strictEqual(TURN_LOOP.RECOVERED_CALL_HINT, CORE.RECOVERED_CALL_HINT);
    assert.strictEqual(TURN_LOOP.REPAIRED_CALL_HINT, CORE.REPAIRED_CALL_HINT);
    assert.ok(!/<\|/.test(CORE.REPAIRED_CALL_HINT), 'no control token spelled into model-facing text');
    assert.ok(!/<\|/.test(CORE.RECOVERED_CALL_HINT), 'nor in the other one');
    const [a, u] = TURN_LOOP.emptyReplyRetryMessages(null, [], [{ name: 'builder_add_step', reason: 'unknown_tool' }]);
    assert.strictEqual(a.role, 'assistant');
    assert.ok(a.content.length > 0, 'never an empty assistant message');
    assert.ok(u.content.startsWith(TURN_LOOP.VALIDATION_NOTE_PREFIX), 'the sanitiser drops the note cross-turn');
    assert.match(u.content, /`builder_add_step` is not a tool on this menu/);
});

test('a call typed into the reasoning is recovered and run like any other', async () => {
    const run = await h.run({
        body: { automationId: 'auto_1' },
        draft: DRAFT,
        rounds: [
            { thinking: [{ text: `Ik voeg de stap toe. ${written('builder_add_steps', { steps: [{ type: 'set', spec: { label: 'Factuur lezen' } }] })}` }] },
            { text: 'Klaar.' },
        ],
        tools: { builder_add_steps: () => ({ ok: true, added: [{ id: 's1', type: 'set' }] }) },
    });

    assert.deepStrictEqual(run.toolCalls, [{ name: 'builder_add_steps', args: { steps: [{ type: 'set', spec: { label: 'Factuur lezen' } }] } }],
        'the written call was executed, with the arguments it carried');
    assert.strictEqual(run.rounds.length, 2, 'the round was not read as "the model is done"');
    assert.ok(run.has('draft'), 'and the draft it built was persisted and announced');
});

test('a recovered span never reaches the stored transcript, and only the round\'s own menu is accepted', async () => {
    const run = await h.run({
        body: { automationId: 'auto_1' },
        draft: DRAFT,
        rounds: [
            { text: `Even dit doen: ${written('builder_add_steps', { steps: [{ type: 'set' }] })} en klaar.` },
            { text: 'Klaar.' },
        ],
        tools: { builder_add_steps: () => ({ ok: true, added: [{ id: 's1', type: 'set' }] }) },
    });
    const stored = run.storedSessions.at(-1).payload.conversation.find((m) => m.role === 'assistant');
    assert.ok(!stored.content.includes('<tool_call>'), 'the markup is stripped out of what is replayed');

    // A name this round's menu does not carry is reported back, not guessed at.
    const unknown = await h.run({
        body: { automationId: 'auto_1' },
        draft: DRAFT,
        rounds: [
            { thinking: [{ text: written('builder_add_invoice_step', { type: 'set' }) }] },
            { text: 'Sorry, dat lukt niet.' },
        ],
    });
    assert.deepStrictEqual(unknown.toolCalls, [], 'nothing was dispatched for a tool that does not exist');
    const nudge = unknown.roundMessages(1).at(-1);
    assert.strictEqual(nudge.role, 'user');
    assert.match(nudge.content, /`builder_add_invoice_step` is not a tool on this menu/,
        'the model is told the specific mistake, not "say something"');
});

test('a recovered call\'s result tells the model so, without dropping a hint the tool set', async () => {
    const run = await h.run({
        body: { automationId: 'auto_1' },
        draft: DRAFT,
        rounds: [
            { thinking: [{ text: written('builder_add_steps', { steps: [{ type: 'set' }] }) }] },
            { text: 'Klaar.' },
        ],
        tools: { builder_add_steps: () => ({ ok: true, added: [{ id: 's1' }], _hints: ['Wire the step to the trigger next.'] }) },
    });
    const result = run.first('tool_call').result;
    assert.deepStrictEqual(result._hints, ['Wire the step to the trigger next.', CORE.RECOVERED_CALL_HINT],
        'appended, never replacing the tool\'s own hint');
});

test('a call the adapter had to close after a cut says so in its result', async () => {
    const run = await h.run({
        body: { automationId: 'auto_1' },
        draft: DRAFT,
        rounds: [
            { toolCalls: [call('builder_add_steps', { steps: [{ type: 'set' }] }, { repaired: true })] },
            { text: 'Klaar.' },
        ],
        tools: { builder_add_steps: () => ({ ok: true, added: [{ id: 's1' }] }) },
    });
    assert.deepStrictEqual(run.first('tool_call').result._hints, [CORE.REPAIRED_CALL_HINT],
        'a clean-looking result would let the model assume the cut-off tail landed too');
});

test('an empty round is nudged once and then reported — never a silent done', async () => {
    const run = await h.run({
        body: { automationId: 'auto_1' },
        draft: DRAFT,
        rounds: [{}, {}, { text: 'een derde ronde zou er niet moeten zijn' }],
    });
    assert.strictEqual(run.rounds.length, 2, 'one nudge, then the turn ends');
    const nudge = run.roundMessages(1).at(-1);
    assert.strictEqual(nudge.role, 'user');
    assert.ok(nudge.content.startsWith(TURN_LOOP.VALIDATION_NOTE_PREFIX));
    assert.deepStrictEqual(run.last('error'), { error: EMPTY_TURN_SENTENCE, transient: false });
});

test('the truncation ladder goes first: a cut-off round is retried, not nudged', async () => {
    const run = await h.run({
        body: { automationId: 'auto_1' },
        draft: DRAFT,
        rounds: [
            { text: 'Ik denk nog na', finishReason: 'length' },
            { text: 'Ik denk nog steeds na', finishReason: 'length' },
            { text: 'een derde ronde zou er niet moeten zijn' },
        ],
    });
    assert.strictEqual(run.rounds.length, 2);
    const retry = run.roundMessages(1).at(-1);
    assert.match(retry.content, /tool call/i, 'the truncation note asks for the call directly');
    assert.deepStrictEqual(run.last('error'), {
        error: 'The model ran out of room while reasoning and never got to building. Switch the builder to a tier with thinking off, or shorten the request.',
        transient: false,
    }, 'and the second cut-off round says that, not the empty-reply sentence');
});

// ── The same two promises, in the app builder ───────────────────────
// Its loop takes every collaborator as an argument, so it can be driven
// without its route. Both sentences and both hints are shared wording: a fix
// to one that misses the other is the bug this half exists to catch.

const APP_TOOLS = require.resolve('../../../appStudio/builderTools');
const realAppTools = require(APP_TOOLS);
require.cache[APP_TOOLS] = {
    id: APP_TOOLS, filename: APP_TOOLS, loaded: true, children: [], paths: [],
    exports: { ...realAppTools, async applyToolCall(name) { return { ok: true, wrote: name }; }, async persistDraft() { return {}; } },
};
const { runBuildLoop } = require('../../../appStudio/../routes/ai/appStudioBuilder/buildLoop');
after(() => { require.cache[APP_TOOLS] = { id: APP_TOOLS, filename: APP_TOOLS, loaded: true, children: [], paths: [], exports: realAppTools }; });

/** One app-builder turn with a scripted model; returns its events and errors. */
async function runAppTurn(rounds) {
    const events = [];
    const errors = [];
    let i = 0;
    const turn = {
        iter: 0, lastFinalized: false, toolCallCount: 0, mutatingToolCalls: 0, validationErrorCount: 0,
        modelEndedTurn: false, builtThisTurn: false, proposedPlan: null, lastPhaseIndex: null,
        lastValidation: null, persistBroken: false, clientGone: false,
    };
    await runBuildLoop(turn, {
        res: { writableEnded: false },
        send: (event, data) => events.push({ event, data }),
        sendError: (code, message) => errors.push({ code, message }),
        messages: [{ role: 'user', content: 'Bouw een app' }],
        adapter: {
            surfacesRawReasoning: () => false,
            async stream(_k, _u, _m, _msgs, _opts, onEvent) {
                const spec = rounds[i++] || {};
                if (spec.text) onEvent('text', { text: spec.text });
                for (const tc of spec.toolCalls || []) {
                    onEvent('tool_use', { id: tc.id || `c${i}`, name: tc.name, input: tc.args || {}, _repaired: tc.repaired });
                }
                onEvent('done', { stop_reason: 'stop' });
            },
        },
        cfg: { apiKey: 'k', url: 'https://example.invalid', providerType: 'claude' },
        modelId: 'm1',
        tier: {},
        profile: { maxIterations: 4 },
        tools: [{ type: 'function', function: { name: 'app_write_file' } }],
        toolNameSet: new Set(['app_write_file']),
        iterationBudget: 4,
        draftWrap: { appId: 'app_1', builderSessionId: 'bs_1', def: { files: [] }, _todos: [] },
        userId: 'u1',
        modelSupportsVision: false,
        approvedPlanForTurn: null,
        writeCheckpoint: () => {},
        usageTotals: { prompt: 0, completion: 0, cached: 0, cacheCreation: 0, rounds: 0 },
        proseParts: [],
        clientAbort: new AbortController(),
    });
    return { events, errors, turn };
}

test('the app builder stamps the same cut-off hint on the same kind of call', async () => {
    const out = await runAppTurn([
        { toolCalls: [{ name: 'app_write_file', args: { path: 'index.html' }, repaired: true }] },
        { text: 'Klaar.' },
    ]);
    const wire = out.events.find((e) => e.event === 'tool_call').data;
    assert.deepStrictEqual(JSON.parse(wire.result)._hints, [CORE.REPAIRED_CALL_HINT]);
});

test('the app builder ends an empty turn with the same sentence, under its taxonomy code', async () => {
    const out = await runAppTurn([{}, {}]);
    assert.deepStrictEqual(out.errors, [{ code: 'model_empty_reply', message: EMPTY_TURN_SENTENCE }]);
    assert.strictEqual(out.turn.modelEndedTurn, false, 'a turn that said nothing is not a turn the model closed');
});
