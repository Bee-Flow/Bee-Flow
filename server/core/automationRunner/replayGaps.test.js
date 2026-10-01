/**
 * Replay gaps — which unrecoverable outputs a resume must stop on (BFSF-435).
 *
 * A gap is a step whose run-history row holds only the truncation sentinel,
 * with no full copy kept. It matters only when a step AFTER the pause reads
 * it: then carrying on would bind every reference to nothing. Pinned here:
 * "after" follows the edges from the paused step; "reads" catches the dotted
 * and bracketed forms anywhere in a step (a loop body, a layer call's inputs)
 * and does not confuse `steps.a_1` with `steps.a_10`.
 *
 * Run: cd server && node --test core/automationRunner/replayGaps.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { stepsAfter, readsStep, gapsReadAfterPause, replayGapError } = require('./replayGaps');

// trigger → http1 → form → mail
//                        ↘ note
const DEF = {
    trigger: { id: 'trig' },
    steps: [
        { id: 'http1', type: 'http_request' },
        { id: 'prep', type: 'set', fields: { n: { kind: 'ref', path: 'steps.http1.output.data.total' } } },
        { id: 'form', type: 'form_page', mode: 'input', form: { title: 'Found {{steps.http1.output.data.total}}' } },
        { id: 'mail', type: 'integration_action', params: { body: 'Items: {{steps.http1.output.data.items}}' } },
        { id: 'note', type: 'set', fields: { at: { kind: 'ref', path: 'trigger.output.at' } } },
    ],
    edges: [
        { from: 'trig', to: 'http1' },
        { from: 'http1', to: 'prep' },
        { from: 'prep', to: 'form' },
        { from: 'form', to: 'mail' },
        { from: 'form', to: 'note' },
    ],
};

test('stepsAfter follows the edges from the paused step, and only those', () => {
    assert.deepEqual([...stepsAfter(DEF, 'form')].sort(), ['mail', 'note']);
    assert.deepEqual([...stepsAfter(DEF, 'mail')], []);
    assert.deepEqual([...stepsAfter({ steps: [] }, 'form')], [], 'no edges, nothing after');
});

test('readsStep sees a binding wherever it sits in the step', () => {
    assert.ok(readsStep({ params: { body: '{{steps.http1.output.body}}' } }, 'http1'));
    assert.ok(readsStep({ fields: { a: { kind: 'ref', path: 'steps.http1.output' } } }, 'http1'));
    assert.ok(readsStep({ type: 'loop', body: [{ params: { q: '{{ steps.http1.output.q }}' } }] }, 'http1'));
    assert.ok(readsStep({ type: 'call_layer', inputs: { list: { kind: 'ref', path: 'steps.http1.output.items' } } }, 'http1'));
    assert.ok(readsStep({ expr: 'len(steps["http1"].output.items)' }, 'http1'), 'bracketed, double quotes');
    assert.ok(readsStep({ expr: "steps['http1'].output" }, 'http1'), 'bracketed, single quotes');
});

// Review M5a: the AI builder writes picks and composes, which hold no
// `steps.<id>` text; a "no" here would let a resumed run send empty values.
test('readsStep sees a pick and a compose part, a repeat and a loop over a step', () => {
    const { templateToCompose } = require('../../shared/mapping/index.mjs');
    const body = templateToCompose('Summary: {{steps.ai_1.output.text}}', { stepType: 'notification', field: 'body' });
    assert.equal(body.kind, 'compose');
    assert.ok(readsStep({ type: 'notification', body }, 'ai_1'));
    const pick = { kind: 'pick', v: 1, from: { root: 'steps', id: 'ai_1', path: ['text'] }, take: 'one', as: 'native' };
    assert.ok(readsStep({ type: 'integration_action', inputs: { text: pick } }, 'ai_1'));
    assert.ok(readsStep({ type: 'loop', body: [{ inputs: { text: pick } }] }, 'ai_1'), 'inside a loop body');
    assert.ok(readsStep({ type: 'integration_action', repeat: { over: { root: 'steps', id: 'ai_1', path: ['rows'] } } }, 'ai_1'));
    assert.equal(readsStep({ type: 'integration_action', inputs: { text: pick } }, 'ai_10'), false);
});

test('readsStep does not confuse one step id with a longer one', () => {
    assert.equal(readsStep({ params: { body: '{{steps.a_10.output}}' } }, 'a_1'), false);
    assert.equal(readsStep({ params: { body: '{{steps.a-1b.output}}' } }, 'a-1'), false);
    assert.equal(readsStep({ params: { body: 'nothing here' } }, 'a_1'), false);
    assert.equal(readsStep(null, 'a_1'), false);
});

test('a gap a later step reads is fatal; one only read before the pause is not', () => {
    const gaps = new Map([['http1', 2_400_000]]);
    // `prep` and the form page itself read http1 too — but they ran before
    // the pause, so they are no reason to stop.
    assert.deepEqual([...gapsReadAfterPause(DEF, 'form', gaps)], [['http1', 2_400_000]]);

    const noReader = { ...DEF, steps: DEF.steps.map(s => (s.id === 'mail' ? { ...s, params: { body: 'Done.' } } : s)) };
    assert.equal(gapsReadAfterPause(noReader, 'form', gaps).size, 0);
});

test('no gaps, no work', () => {
    assert.equal(gapsReadAfterPause(DEF, 'form', new Map()).size, 0);
    assert.equal(gapsReadAfterPause(DEF, 'form', null).size, 0);
});

test('the error says which step, how big, and what to do', () => {
    const err = replayGapError('http1', 2_400_000);
    assert.match(err.message, /step http1 \(2\.3 MB\)/);
    assert.match(err.message, /Start the routine again/);
    assert.deepEqual(err.replayGap, { stepId: 'http1', originalBytes: 2_400_000 });
    assert.doesNotMatch(replayGapError('http1', null).message, /\(/, 'no size is said when none is known');
});
