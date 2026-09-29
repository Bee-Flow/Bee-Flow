/**
 * The build visualisations: from the adapter's event to the client's.
 *
 * Four layers sit between an adapter emitting `tool_args_delta` and the canvas
 * drawing the steps a half-written tool call already describes — the shared
 * stream shell, this route's wrapper around it, the route handler, and the
 * thought narrator the loop writes through. All four are RUN here, so a layer
 * that drops, reshapes or floods an event fails.
 *
 * What they are for: on a single-slot llama.cpp a builder_add_steps call is a
 * 5-10 KB document the model takes half a minute to type, and the first
 * round's prefill takes minutes. Without these two events the canvas shows
 * nothing at all for that whole time. They are also the two events that must
 * never be able to break a build — a scanner that throws is swallowed — and
 * the two that must be throttled, because the adapter emits one per token.
 *
 * Run: cd server && node --test --test-force-exit routes/ai/automationBuilder/chatStream.toolDraft.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');

const { createBuilderStream, call } = require('../../../testUtils/builderStreamHarness');

const h = createBuilderStream();
after(() => h.restore());

const { streamWithRetry: sharedStreamWithRetry } = require('../builderShared');
const { streamWithRetry: routeStreamWithRetry } = require('./modelStream');

// ── The route ─────────────────────────────────────────────

/** The arguments of a builder_add_steps call, as a growing prefix. */
const PARTIAL = [
    '{"steps":[{"type":"set"',
    '{"steps":[{"type":"set","spec":{"label":"Factuur lezen"',
    '{"steps":[{"type":"set","spec":{"label":"Factuur lezen"}},{"type":"action","spec":{"tool":"beta_write_row"',
];

test('a half-written tool call reaches the client as the steps it already describes', async () => {
    const run = await h.run({
        rounds: [
            {
                events: PARTIAL.map((partial) => ['tool_args_delta', { name: 'builder_add_steps', partial }]),
                toolCalls: [call('builder_add_steps', { steps: [{ type: 'set' }] })],
            },
            { text: 'Klaar.' },
        ],
        tools: { builder_add_steps: () => ({ ok: true, added: [{ id: 's1' }] }) },
    });

    const drafts = run.dataOf('tool_draft');
    assert.ok(drafts.length >= 2, 'the canvas is fed while the call is still being typed');
    assert.ok(!run.dataOf('tool_draft').some((d) => d.capped), 'nothing near the step cap here');
    assert.strictEqual(drafts[0].iter, 0);
    assert.strictEqual(drafts[0].name, 'builder_add_steps');
    assert.strictEqual(drafts[0].chars, PARTIAL[0].length, 'how much of the document has arrived');
    assert.deepStrictEqual(drafts[0].steps, [{ type: 'set', tool: null, label: null, partial: true }]);
    assert.deepStrictEqual(drafts.at(-1).steps, [
        { type: 'set', tool: null, label: 'Factuur lezen', partial: false },
        { type: 'action', tool: 'beta_write_row', label: null, partial: true },
    ], 'a step is drawn as it is typed, and stops being a ghost when its object closes');
    assert.strictEqual(drafts.at(-1).count, 2);
    assert.deepStrictEqual(drafts.at(-1).inspect, []);
});

test('the draft gate emits on every change and swallows a repeat, so a token stream is not a flood', async () => {
    const run = await h.run({
        rounds: [
            {
                // Three deltas in the same millisecond: only the ones that
                // change what the canvas would DRAW get through. A label
                // being typed INSIDE a step that is still open is not one —
                // the card is already a ghost either way.
                events: PARTIAL.map((partial) => ['tool_args_delta', { name: 'builder_add_steps', partial }]),
                toolCalls: [call('builder_add_steps', { steps: [{ type: 'set' }] })],
            },
            { text: 'Klaar.' },
        ],
        tools: { builder_add_steps: () => ({ ok: true, added: [{ id: 's1' }] }) },
    });
    const drafts = run.dataOf('tool_draft');
    assert.strictEqual(drafts.length, 2, 'the middle delta drew nothing new');
    assert.deepStrictEqual(drafts.map((d) => d.chars), [PARTIAL[0].length, PARTIAL[2].length]);
});

test('prefill progress is gated to a few per second, and the completing chunk always passes', async () => {
    const chunk = (processed, time_ms) => ['prompt_progress', { total: 4000, cache: 1500, processed, time_ms }];
    const run = await h.run({
        rounds: [{ events: [chunk(1000, 100), chunk(2000, 200), chunk(3000, 300), chunk(4000, 400)], text: 'Klaar.' }],
    });
    assert.deepStrictEqual(run.dataOf('prompt_progress'), [
        { iter: 0, total: 4000, cache: 1500, processed: 1000, timeMs: 100 },
        { iter: 0, total: 4000, cache: 1500, processed: 4000, timeMs: 400 },
    ], 'the two middle chunks arrived inside the same gate window; "prefill done" never waits for it');
});

test('round_start says whether the model runs on this machine', async () => {
    const local = await h.run({
        providerConfig: { apiKey: '', url: 'http://127.0.0.1:8080', providerType: 'llamacpp' },
        modelId: 'gemma-4-26b-a4b',
    });
    assert.deepStrictEqual(local.first('round_start'), {
        iter: 0,
        modelId: 'gemma-4-26b-a4b',
        promptChars: local.first('round_start').promptChars,
        effort: local.first('round_start').effort,
        local: true,
        providerType: 'llamacpp',
    }, 'the client says "on this machine, nothing sent outside" and expects a prefill measurement');
    assert.ok(local.first('round_start').promptChars > 1000, 'promptChars sizes the waiting card');

    const cloud = await h.run({ providerConfig: { apiKey: 'k', url: 'https://api.example.invalid', providerType: 'claude' } });
    assert.strictEqual(cloud.first('round_start').local, false);
    assert.strictEqual(cloud.first('round_start').providerType, 'claude');
});

test('a draft gate is per ROUND: the first delta of every round always lands', async () => {
    const run = await h.run({
        rounds: [
            {
                events: [['tool_args_delta', { name: 'builder_add_steps', partial: PARTIAL[0] }]],
                toolCalls: [call('builder_add_steps', { steps: [{ type: 'set' }] })],
            },
            {
                events: [['tool_args_delta', { name: 'builder_add_steps', partial: PARTIAL[0] }]],
                toolCalls: [call('builder_add_steps', { steps: [{ type: 'set' }] })],
            },
            { text: 'Klaar.' },
        ],
        tools: { builder_add_steps: () => ({ ok: true, added: [{ id: 's1' }] }) },
    });
    assert.deepStrictEqual(run.dataOf('tool_draft').map((d) => d.iter), [0, 1],
        'a fresh gate each round — otherwise round 2 opens on a suppressed repeat');
});

// ── The shared stream shell ───────────────────────────────
// It used to drop `tool_args_delta` on the floor, with a comment saying so.

/** An adapter that replays a scripted event list into the shell's onEvent. */
const adapterEmitting = (events) => ({
    stream: async (apiKey, url, modelId, messages, options, onEvent) => {
        for (const [type, data] of events) onEvent(type, data);
        onEvent('done', { stop_reason: 'stop' });
    },
});

const CFG = { apiKey: 'k', url: 'https://x', providerType: 'claude' };
const EMIT_THINKING = { start: () => {}, delta: () => {}, stop: () => {} };

function runShell(events, hooks = {}) {
    return sharedStreamWithRetry(adapterEmitting(events), CFG, 'm1', [], {}, {
        send: () => {},
        emitThinking: EMIT_THINKING,
        ...hooks,
    });
}

test('the shell hands tool_args_delta and prompt_progress to their hooks, payload intact', async () => {
    const drafts = [];
    const progress = [];
    const partial = '{"steps":[{"type":"set"';
    const chunk = { total: 4000, cache: 1500, processed: 2048, time_ms: 8123 };

    await runShell(
        [['tool_args_delta', { name: 'builder_add_steps', partial }], ['prompt_progress', chunk]],
        { onToolArgsDelta: (d) => drafts.push(d), onPromptProgress: (d) => progress.push(d) },
    );

    assert.deepStrictEqual(drafts, [{ name: 'builder_add_steps', partial }]);
    assert.deepStrictEqual(progress, [chunk]);
});

test('a round with only a tool_args_delta is still a silent round', async () => {
    // Not counted as "the model said something": nothing is on the wire yet,
    // so a retry stays safe to take.
    const out = await runShell([['tool_args_delta', { name: 'x', partial: '{' }]], { onToolArgsDelta: () => {} });
    assert.strictEqual(out.content, null);
    assert.strictEqual(out.toolCalls, null);
});

test('a visualisation that throws never kills the build', async () => {
    const out = await runShell(
        [['tool_args_delta', { name: 'x', partial: '{' }], ['prompt_progress', {}], ['text', { text: 'hello' }]],
        {
            onToolArgsDelta: () => { throw new Error('draft scanner exploded'); },
            onPromptProgress: () => { throw new Error('progress meter exploded'); },
        },
    );
    assert.strictEqual(out.content, 'hello', 'the round must finish and keep what the model said');
});

test('a shell with no hooks at all just ignores the two events', async () => {
    const out = await runShell([['tool_args_delta', { name: 'x', partial: '{' }], ['prompt_progress', {}], ['text', { text: 'hi' }]]);
    assert.strictEqual(out.content, 'hi');
});

test("this route's wrapper passes every extra option through to the shared shell", async () => {
    // The route calls THIS wrapper; its own defaults must come first and the
    // caller's options last, or the hooks never reach builderShared.
    const drafts = [];
    const out = await routeStreamWithRetry(
        adapterEmitting([['tool_args_delta', { name: 'builder_add_steps', partial: '{' }], ['text', { text: 'ok' }]]),
        CFG, 'm1', [], {},
        { send: () => {}, onToolArgsDelta: (d) => drafts.push(d) },
    );
    assert.deepStrictEqual(drafts, [{ name: 'builder_add_steps', partial: '{' }],
        "the wrapper swallowed the caller's hook");
    assert.strictEqual(out.content, 'ok');
});

test('the thought narrator wrapper forwards the new events untouched, in order', () => {
    // The loop writes through `send`, which is the narrator's wrapper when an
    // admin configured a narration model. It must hand every unknown event to
    // the client exactly as sent — tool_draft and prompt_progress included.
    const { createThoughtNarrator } = require('./thoughtNarrator');
    const out = [];
    const target = (event, data) => out.push({ event, data });
    const narrator = createThoughtNarrator({
        send: target, modelId: 'lfm2.5-350m',
        chat: () => { throw new Error('the narrator must not call the model for these events'); },
        setTimeout: () => 0, clearTimeout: () => {}, log: () => {},
    });
    const send = narrator.wrap(target);
    const draft = { iter: 0, name: 'builder_add_steps', chars: 120, count: 1, steps: [{ type: 'set', tool: null, label: 'A', partial: true }], inspect: [] };
    const progress = { iter: 0, total: 4000, cache: 1500, processed: 2048, timeMs: 8123 };
    const start = { iter: 0, modelId: 'm', promptChars: 9000, effort: 'low', local: true, providerType: 'llamacpp' };
    send('round_start', start);
    send('prompt_progress', progress);
    send('tool_draft', draft);
    narrator.close();
    assert.deepStrictEqual(out, [
        { event: 'round_start', data: start },
        { event: 'prompt_progress', data: progress },
        { event: 'tool_draft', data: draft },
    ]);
    assert.strictEqual(out[2].data, draft, 'same object reference — nothing copied or reshaped');
});
