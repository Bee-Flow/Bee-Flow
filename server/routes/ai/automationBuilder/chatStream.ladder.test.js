/**
 * The build loop's three ways of giving up, driven through the route.
 *
 * Measured 2026-09-12/13 with the fast local model: a refused batch was resent
 * three rounds running, a refused builder_update_steps fifteen times. The
 * ladder in builderTools.js decides WHEN a turn is lost (`_stop` on a tool
 * result); this file is where the turn actually ends, and what it costs:
 *
 *   - a `_stop` ends the round, and the calls BEHIND it in the same reply are
 *     never dispatched — a builder_finalize among them would have saved a
 *     draft the model was still fighting with;
 *   - a round in which every call was refused is charged a second iteration,
 *     and four such rounds in a row end the turn as `no_progress`; any
 *     accepted call — a partial batch that landed steps included — resets it;
 *   - the abort carries the round's own validation and the rejected call, and
 *     ONE sentence reaches both the wire and the stored turn;
 *   - auto-finalize is guarded by the stop, not by the budget;
 *   - the rejected-call log line is the only surviving record of what the
 *     model sent, and scripts/builder-trace-from-log.mjs turns it back into a
 *     fixture — so this file feeds the route's own line to that parser.
 *
 * Run: cd server && node --test --test-force-exit routes/ai/automationBuilder/chatStream.ladder.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { createBuilderStream, call } = require('../../../testUtils/builderStreamHarness');

const h = createBuilderStream();
after(() => h.restore());

const TRACE_SCRIPT = path.join(__dirname, '../../../scripts/builder-trace-from-log.mjs');

const step = (id, label) => ({ id, type: 'set', label, spec: {}, settings: { assignments: [{ var: id, value: '1' }] } });
/** A draft row with `n` real steps, so the sentence's step count is known. */
const draftWith = (n) => ({
    id: 'auto_1',
    userId: 'u1',
    title: 'Facturen',
    description: '',
    definition: {
        schemaVersion: 1,
        trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} },
        steps: Array.from({ length: n }, (_, i) => step(`s${i + 1}`, `Stap ${i + 1}`)),
        edges: n ? [{ from: 'trg', to: 's1' }, ...Array.from({ length: n - 1 }, (_, i) => ({ from: `s${i + 1}`, to: `s${i + 2}` }))] : [],
        vars: {},
    },
});

/** The ladder's third rung, as builderTools stamps it on the result. */
const stopped = (over = {}) => ({
    error: 'Step 2 has no `tool`.',
    _repeated: 3,
    failedIndex: 1,
    _stop: { reason: 'repeated_rejection', tool: 'builder_add_steps', error: 'Step 2 has no `tool`.', entryIndex: 1 },
    ...over,
});

const refused = (message = 'Nope.') => ({ error: message });

/** A round whose single call is refused — the wasted round. */
const refusedRound = () => ({ toolCalls: [call('builder_add_steps', { steps: [{ type: 'set', spec: { label: 'A' } }] })] });

test('a _stop ends the round: the calls behind it are never dispatched, and a finalize among them cannot land', async () => {
    const run = await h.run({
        body: { automationId: 'auto_1' },
        draft: draftWith(2),
        rounds: [{
            toolCalls: [
                call('builder_add_steps', { steps: [{ type: 'set', spec: { label: 'A' } }, { type: 'set', spec: { label: 'Boeking wegschrijven' } }] }),
                call('builder_update_step', { stepId: 's1', type: 'set' }),
                call('builder_finalize', {}),
            ],
        }],
        tools: { builder_add_steps: () => stopped() },
    });

    assert.deepStrictEqual(run.toolCalls.map((c) => c.name), ['builder_add_steps'],
        'only the call that carried the stop was executed');
    assert.ok(!run.has('finalized'), 'the finalize behind the stop did not run');
    assert.strictEqual(run.last('done').finalized, false);

    const skipped = run.dataOf('tool_call').slice(1);
    assert.strictEqual(skipped.length, 2);
    for (const ev of skipped) {
        assert.strictEqual(ev.result._skipped, true);
        assert.strictEqual(ev.result.error, 'Not run: the build stopped before this call (repeated_rejection).');
        assert.match(ev.result._fixHint, /^Reject reason: /);
    }

    // Every call still has a tool result paired with it in the stored turn —
    // an assistant turn with a dangling tool_call is what the next visit
    // replays, and what the provider rejects.
    const stored = run.storedSessions.at(-1).payload.conversation.at(-1);
    assert.deepStrictEqual(stored.toolCalls.map((c) => c.name),
        ['builder_add_steps', 'builder_update_step', 'builder_finalize']);
    assert.ok(stored.toolCalls.every((c) => c.result), 'no call was left without its result');
});

test('the abort carries the round\'s own validation, the rejected call, and one sentence — on the wire and in the stored turn', async () => {
    const run = await h.run({
        body: { automationId: 'auto_1' },
        draft: draftWith(2),
        rounds: [{
            text: 'Ik voeg de boekingsstap toe.',
            toolCalls: [
                call('builder_update_step', { stepId: 's1', label: 'Factuur lezen' }),
                call('builder_add_steps', { steps: [{ type: 'set', spec: { label: 'A' } }, { type: 'set', spec: { label: 'Boeking wegschrijven' } }] }),
            ],
        }],
        tools: {
            builder_update_step: () => ({ ok: true, updated: { id: 's1', type: 'set' } }),
            builder_add_steps: () => stopped(),
        },
    });

    const aborted = run.first('builder_aborted');
    assert.strictEqual(aborted.reason, 'repeated_rejection');
    assert.deepStrictEqual(aborted.rejected, {
        tool: 'builder_add_steps',
        error: 'Step 2 has no `tool`.',
        label: 'Boeking wegschrijven',
    }, 'the label is the refused batch ENTRY, not the tool name');
    assert.ok(aborted.lastValidation, 'the mutation earlier in the round was validated before the abort was sent');
    assert.deepStrictEqual(aborted.lastValidation, run.last('validation_errors') && {
        ok: aborted.lastValidation.ok, errors: run.last('validation_errors').errors, warnings: run.last('validation_errors').warnings,
        ...aborted.lastValidation,
    }, 'and it is the validation the round just produced');

    const sentence = 'I could not build step 2 (Boeking wegschrijven): the builder kept rejecting it — Step 2 has no `tool`. 2 steps are in place. Tell me how to proceed, or fix that step on the canvas.';
    assert.strictEqual(run.last('message').content, `\n\n${sentence}`,
        'appended to the text the round already streamed');
    const stored = run.storedSessions.at(-1).payload.conversation.at(-1);
    assert.strictEqual(stored.content, `Ik voeg de boekingsstap toe.\n\n${sentence}`,
        'the stored turn carries it too — without this the next visit shows a build that just stopped talking');
});

test('the sentence agrees with the step count and caps a long rejection at 200 characters', async () => {
    const one = await h.run({
        body: { automationId: 'auto_1' },
        draft: draftWith(1),
        rounds: [{ toolCalls: [call('builder_update_steps', { stepId: 's1' })] }],
        tools: { builder_update_steps: () => ({ error: 'x', _stop: { reason: 'repeated_rejection', error: 'x', label: 'Stap 1' } }) },
    });
    assert.match(one.last('message').content, /1 step is in place\./, 'singular for one step');

    const long = 'y'.repeat(260);
    const many = await h.run({
        body: { automationId: 'auto_1' },
        draft: draftWith(3),
        rounds: [{ toolCalls: [call('builder_update_steps', { stepId: 's1' })] }],
        tools: { builder_update_steps: () => ({ error: long, _stop: { reason: 'repeated_rejection', error: long, label: 'Stap 1' } }) },
    });
    const said = many.last('message').content;
    assert.match(said, /3 steps are in place\./, 'plural for three');
    assert.ok(said.includes(`${'y'.repeat(200)}…`), 'the rejection is cut at 200 characters');
    assert.ok(!said.includes('y'.repeat(201)), 'and no further');
});

test('a round in which every call was refused is charged a second iteration, and the fourth in a row ends the turn', async () => {
    const run = await h.run({
        body: { automationId: 'auto_1' },
        draft: draftWith(2),
        rounds: [refusedRound(), refusedRound(), refusedRound(), refusedRound(), refusedRound()],
        tools: { builder_add_steps: () => refused('Step 1 has no `tool`.') },
    });

    assert.strictEqual(run.rounds.length, 4, 'the fourth wasted round is the last one');
    const aborted = run.first('builder_aborted');
    assert.strictEqual(aborted.reason, 'no_progress');
    assert.strictEqual(aborted.iterations, 8, 'four rounds, eight iterations — each wasted round costs two');
    assert.deepStrictEqual(aborted.rejected, { tool: 'builder_add_steps', error: 'Step 1 has no `tool`.', label: 'steps' },
        'no entry was named, so the call falls back to the kind of thing it was adding');
    assert.strictEqual(run.last('message').content,
        'I made no progress for four rounds — the builder rejected every step I tried. 2 steps are in place. Tell me how to proceed.');
});

test('any accepted call resets the count — progress is progress', async () => {
    const run = await h.run({
        body: { automationId: 'auto_1' },
        draft: draftWith(2),
        rounds: [
            refusedRound(), refusedRound(), refusedRound(),
            { toolCalls: [call('builder_update_step', { stepId: 's1', type: 'set' })] },
            refusedRound(), refusedRound(), refusedRound(), refusedRound(),
        ],
        tools: {
            builder_add_steps: () => refused('Nope.'),
            builder_update_step: () => ({ ok: true, updated: { id: 's1', type: 'set' } }),
        },
    });

    assert.strictEqual(run.rounds.length, 8, 'the accepted round in the middle bought four more');
    assert.strictEqual(run.first('builder_aborted').reason, 'no_progress');
});

test('a partial batch that landed NEW steps counts as accepted, so four of them never read as no progress', async () => {
    // Measured: four partial batches in a row, each landing steps, ended the
    // turn as `no_progress` ("rejected every step I tried") and were charged
    // the wasted-round iteration each time.
    const partial = () => ({ error: 'Step 2 has no `tool`.', failedIndex: 1, added: [{ id: 's9', type: 'set' }] });
    const run = await h.run({
        body: { automationId: 'auto_1' },
        draft: draftWith(2),
        rounds: [refusedRound(), refusedRound(), refusedRound(), refusedRound(), { text: 'Zo ver kom ik.' }],
        tools: { builder_add_steps: partial },
    });
    const aborted = run.first('builder_aborted');
    assert.notStrictEqual(aborted && aborted.reason, 'no_progress');
    assert.strictEqual(run.rounds.length, 5, 'no round was charged twice');

    // A batch whose `added` entries are all resends of steps built earlier is
    // not progress, and still stops the turn.
    const reused = await h.run({
        body: { automationId: 'auto_1' },
        draft: draftWith(2),
        rounds: [refusedRound(), refusedRound(), refusedRound(), refusedRound(), { text: 'Zo ver kom ik.' }],
        tools: { builder_add_steps: () => ({ ...partial(), added: [{ id: 's9', type: 'set', reused: true }] }) },
    });
    assert.strictEqual(reused.first('builder_aborted').reason, 'no_progress');
});

test('a partial batch ticks the plan from the entries that actually landed', async () => {
    const run = await h.run({
        body: { automationId: 'auto_1' },
        draft: draftWith(0),
        rounds: [
            { toolCalls: [call('builder_set_plan', { todos: [{ text: 'Bestanden ophalen uit Facturen' }, { text: 'Boeking wegschrijven in de tabel' }] })] },
            {
                toolCalls: [call('builder_add_steps', {
                    steps: [
                        { type: 'set', spec: { label: 'Bestanden ophalen uit Facturen' } },
                        { type: 'set', spec: { label: 'Boeking wegschrijven in de tabel' } },
                    ],
                })],
            },
            { text: 'Zo ver kom ik.' },
        ],
        tools: {
            builder_add_steps: () => ({ error: 'Step 2 has no `tool`.', failedIndex: 1, added: [{ id: 's9', type: 'set' }] }),
        },
    });

    const ticked = run.dataOf('plan').at(-1).todos;
    assert.deepStrictEqual(ticked.map((t) => t.done), [true, false],
        'only the entry that landed ticked its item — the refused one is not evidence');
    const batch = run.dataOf('tool_call').find((e) => e.name === 'builder_add_steps');
    assert.deepStrictEqual(batch.result._plan.markedDone, [0]);
    assert.strictEqual(batch.result._plan.next, 'Boeking wegschrijven in de tabel');
});

test('a finalize refused for validation errors reaches the wire as the diagnostic, never as {automation}', async () => {
    // The wire carried `{automation, ok:false}` for a refused finalize, so
    // scripts/drive-builder.js counted it as a success and the plan tick read
    // `{automation}` as "the build is over".
    const broken = draftWith(1);
    broken.definition.edges.push({ from: 's1', to: 'weg' });   // an edge to a step that is not there
    const run = await h.run({
        body: { automationId: 'auto_1' },
        draft: broken,
        rounds: [
            { toolCalls: [call('builder_set_plan', { todos: [{ text: 'Automation afronden en activeren' }] })] },
            { toolCalls: [call('builder_finalize', {})] },
            { text: 'Het lukt niet.' },
        ],
        tools: { builder_finalize: () => ({ automation: { id: 'auto_1' }, ok: false }) },
    });

    const wire = run.dataOf('tool_call').find((e) => e.name === 'builder_finalize').result;
    assert.strictEqual(wire.automation, undefined, 'the success shape never reaches the client');
    assert.strictEqual(wire.error, 'Cannot finalize: definition has validation errors. Address the errors below and try again.');
    assert.ok(wire.validation.errors.length, 'and it carries the errors the model has to fix');
    assert.ok(!run.has('finalized'));
    assert.deepStrictEqual(run.dataOf('plan').at(-1).todos.map((t) => t.done), [false],
        'the refused finalize did not tick the plan');
});

test('auto-finalize runs on any ending the model leaves unfinished, and never after a stop', async () => {
    // It used to require `iter >= iterationBudget`, so the net only caught a
    // build that ran out of rounds — the commonest small-model ending (a few
    // good steps, then prose instead of builder_finalize) left the automation a
    // draft for ever.
    const ended = await h.run({
        body: { automationId: 'auto_1' },
        draft: draftWith(1),
        rounds: [{ text: 'Je automation is klaar.' }],
        tools: { builder_finalize: () => ({ automation: { id: 'auto_1' } }) },
    });
    assert.deepStrictEqual(ended.first('finalized'), { automationId: 'auto_1', autoFinalized: true });
    assert.match(ended.last('message').content, /finalising as-is/);
    assert.strictEqual(ended.rounds.length, 1, 'one round — the budget was nowhere near spent');

    const stopped_ = await h.run({
        body: { automationId: 'auto_1' },
        draft: draftWith(1),
        rounds: [{ toolCalls: [call('builder_update_steps', { stepId: 's1' })] }],
        tools: { builder_update_steps: () => ({ error: 'x', _stop: { reason: 'repeated_rejection', error: 'x', label: 'Stap 1' } }) },
    });
    assert.deepStrictEqual(stopped_.toolCalls.map((c) => c.name), ['builder_update_steps'],
        'the finalize was never even attempted — a draft the model could not finish is not finalised for it');
    assert.ok(!stopped_.has('finalized'));
    assert.strictEqual(stopped_.first('builder_aborted').reason, 'repeated_rejection');
});

test('a draft carrying only a note is not an automation, and is not auto-finalized', async () => {
    const noteOnly = draftWith(0);
    noteOnly.definition.steps = [{ id: 'n1', type: 'note', label: 'Denk hier nog over na', spec: {} }];
    const run = await h.run({
        body: { automationId: 'auto_1' },
        draft: noteOnly,
        rounds: [{ text: 'Ik heb een notitie geplaatst.' }],
        tools: { builder_finalize: () => ({ automation: { id: 'auto_1' } }) },
    });
    assert.deepStrictEqual(run.toolCalls, [], 'the finalize was never attempted');
    assert.ok(!run.has('finalized'));
    assert.strictEqual(run.first('builder_aborted').reason, 'max_iterations');
});

test('the rejected-call log line is a fixture the trace script can read back', async () => {
    const lines = [];
    const realLog = console.log;
    console.log = (...a) => { lines.push(a.join(' ')); };
    let run;
    try {
        run = await h.run({
            body: { automationId: 'auto_1', builderSessionId: 'bs_trace' },
            draft: draftWith(2),
            rounds: [{ toolCalls: [call('builder_add_steps', { steps: [{ type: 'set', spec: { label: 'A' } }, { type: 'set', spec: { label: 'B' } }] })] }],
            tools: { builder_add_steps: () => stopped() },
        });
    } finally { console.log = realLog; }
    assert.ok(run.has('builder_aborted'));

    const line = lines.find((l) => l.includes('[AutomationBuilder] rejected '));
    assert.ok(line, 'the rejected call was logged');
    const { parseRejectedLine } = await import(TRACE_SCRIPT);
    const parsed = parseRejectedLine(line);
    assert.strictEqual(parsed.tool, 'builder_add_steps');
    assert.strictEqual(parsed.session, 'bs_trace');
    assert.strictEqual(parsed.ladderRepeat, 3, 'the ladder rung the rejection sat on');
    assert.strictEqual(parsed.failedIndex, 1, 'the batch entry it named');
    assert.deepStrictEqual(parsed.args.steps.map((s) => s.spec.label), ['A', 'B'],
        'the arguments replay as the call the model really sent');
});

test('a batch too big for the log cap is refused as a fixture rather than replayed in half', async () => {
    const lines = [];
    const realLog = console.log;
    console.log = (...a) => { lines.push(a.join(' ')); };
    try {
        await h.run({
            body: { automationId: 'auto_1', builderSessionId: 'bs_big' },
            draft: draftWith(2),
            rounds: [{ toolCalls: [call('builder_add_steps', { steps: [{ type: 'set', spec: { label: 'x'.repeat(30000) } }] })] }],
            tools: { builder_add_steps: () => stopped() },
        });
    } finally { console.log = realLog; }

    const line = lines.find((l) => l.includes('[AutomationBuilder] rejected '));
    assert.ok(line.length < 22000, 'the 20000-char cap held');
    const { parseRejectedLine } = await import(TRACE_SCRIPT);
    const parsed = parseRejectedLine(line);
    assert.match(parsed.refused, /cut by the log cap/, 'the script refuses a call it would replay in half');
    assert.strictEqual(parsed.args, undefined);
});
