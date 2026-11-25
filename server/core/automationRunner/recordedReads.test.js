/**
 * Recorded reads in the dry-run harness (./recordedReads.mts): a read answered from an earlier run's recording, a
 * miss that never reads live, the other steps that reach outside, and a harness that only a dry run carries.
 *
 * Run: cd server && node --test core/automationRunner/recordedReads.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
    NO_RECORDING, canonicalHash, recordingKey, normalizeRecordedReads, persistedInputOfStep,
    recordedIntegrationRead, recordedStepResult, answersFromRecordings,
} = require('./recordedReads.mts');
const { harnessFor, normalizeHarness } = require('./testHarness');

const literal = (value) => ({ kind: 'literal', value });
const search = { id: 'mails', type: 'integration_action', tool: 'outlook_search', inputs: { query: literal('overdue'), since: { kind: 'ref', path: 'trigger.output.since' } } };
const state = (since = '2026-10-01T00:00:00.000Z', steps = {}) => ({ trigger: { output: { since } }, steps });
const MAILS = { messages: [{ id: 'm1', subject: 'Order 12 is late' }] };

/** A dry-run ctx whose harness recorded `search` as it reads on `runState`. */
function ctxRecording(runState, { recordedOnly = true, unchanged = {}, outputHashes = {}, skipUpstream = [] } = {}) {
    const key = recordingKey('mails', 'outlook_search', persistedInputOfStep(search, runState));
    return { testHarness: harnessFor('dry_run', { recordedReads: { recordedOnly, byKey: new Map([[key, MAILS]]), unchanged, outputHashes, skipUpstream } }) };
}
const empty = () => ({ messages: [] });

test('the key is the step, the tool and the hash of the input as the run history stores it', () => {
    assert.strictEqual(canonicalHash({ b: 1, a: [2, { d: 3, c: undefined }] }), canonicalHash({ a: [2, { d: 3 }], b: 1 }), 'key order and undefined do not count');
    assert.notStrictEqual(recordingKey('mails', 'outlook_search', { q: 'a' }), recordingKey('mails', 'outlook_search', { q: 'b' }));
    assert.notStrictEqual(recordingKey('mails', 'outlook_search', { q: 'a' }), recordingKey('mails', 'outlook_read', { q: 'a' }));
    assert.deepStrictEqual(persistedInputOfStep(search, state()), { query: 'overdue', since: '2026-10-01T00:00:00.000Z' });
});

test('a recorded read hands on what it read then; nothing in the harness is the step\'s own object', () => {
    const runState = state();
    const ctx = ctxRecording(runState);
    const got = recordedIntegrationRead(search, ctx, runState, 'dry_run', { sideEffect: false, emptyOutput: empty });
    assert.deepStrictEqual(got, { output: MAILS });
    got.output.messages.push({ id: 'changed' });
    assert.deepStrictEqual(recordedIntegrationRead(search, ctx, runState, 'dry_run', { sideEffect: false, emptyOutput: empty }), { output: MAILS });
});

test('a read with another input has no recording, and under recordedOnly it never falls through to a live read', () => {
    const ctx = ctxRecording(state());
    const other = state('2026-11-01T00:00:00.000Z');
    assert.deepStrictEqual(recordedIntegrationRead(search, ctx, other, 'dry_run', { sideEffect: false, emptyOutput: empty }), {
        output: { messages: [], [NO_RECORDING]: true }, dryRunSynthesised: true, dryRunFallback: 'no_recording',
    });
    const lenient = ctxRecording(state(), { recordedOnly: false });
    assert.strictEqual(recordedIntegrationRead(search, lenient, other, 'dry_run', { sideEffect: false, emptyOutput: empty }), null, 'without recordedOnly the dry run goes on as before');
});

test('a write is never answered from a recording: the dry run simulates it as always', () => {
    const runState = state();
    assert.strictEqual(recordedIntegrationRead(search, ctxRecording(runState), runState, 'dry_run', { sideEffect: true, emptyOutput: empty }), null);
});

test('only a dry run carries recorded reads: a live run, a resume or a partial run gets no harness at all', () => {
    const raw = { recordedReads: { recordedOnly: true, byKey: { k: 1 } } };
    for (const mode of ['live', 'test', 'partial']) assert.strictEqual(harnessFor(mode, raw), null, mode);
    const runState = state();
    const ctx = ctxRecording(runState);
    assert.strictEqual(recordedIntegrationRead(search, ctx, runState, 'live', { sideEffect: false, emptyOutput: empty }), null, 'a live mode ignores a harness it was handed');
    assert.strictEqual(answersFromRecordings(ctx, 'live'), false);
    assert.strictEqual(answersFromRecordings(ctx, 'dry_run'), true);
    assert.strictEqual('recordedReads' in normalizeHarness({ aiAnswers: 'live' }), false, 'a harness without recordings looks as before');
    assert.deepStrictEqual(normalizeRecordedReads({ byKey: { k: 1 }, recordedOnly: 'yes' })?.recordedOnly, false, 'only true is true');
});

test('a step that reaches outside is answered when it is unchanged and read the same; otherwise it has no recording', () => {
    const ask = { id: 'sum', type: 'ai_step', prompt: 'Summarise {{steps.mails.output}}' };
    const withTools = { ...ask, allowTools: true };
    const upstream = state(undefined, { mails: { output: MAILS }, draft: { output: { id: 'sample-id' }, synthesised: true } });
    const ctx = ctxRecording(upstream, { unchanged: { sum: 'Two orders are late.', sumTools: 'x' }, outputHashes: { mails: canonicalHash(MAILS) } });
    assert.deepStrictEqual(recordedStepResult(ask, ctx, upstream, 'dry_run'), { output: 'Two orders are late.' }, 'a simulated write before it does not count');
    const changedUpstream = state(undefined, { mails: { output: { messages: [] } } });
    assert.strictEqual(recordedStepResult(ask, ctx, changedUpstream, 'dry_run'), null, 'it read something else: the model is asked');
    assert.strictEqual(recordedStepResult({ ...ask, id: 'fresh' }, ctx, upstream, 'dry_run'), null, 'a new plain AI step asks the model');
    assert.deepStrictEqual(recordedStepResult({ ...withTools, id: 'fresh' }, ctx, upstream, 'dry_run')?.output, { [NO_RECORDING]: true }, 'one with tools could call an app: no recording');
    assert.deepStrictEqual(recordedStepResult({ id: 'web', type: 'http_request', url: 'https://example.com' }, ctx, upstream, 'dry_run')?.output, { [NO_RECORDING]: true });
    assert.strictEqual(recordedStepResult({ id: 'post', type: 'http_request', method: 'POST', url: 'https://example.com' }, ctx, upstream, 'dry_run'), null, 'a write is simulated as always');
    assert.deepStrictEqual(recordedStepResult({ id: 'rows', type: 'datatable', op: 'find_rows' }, ctx, upstream, 'dry_run')?.output, { [NO_RECORDING]: true });
    assert.strictEqual(recordedStepResult({ id: 'facts', type: 'set', fields: {} }, ctx, upstream, 'dry_run'), null, 'the run\'s own work runs');
    assert.strictEqual(recordedStepResult(withTools, ctx, upstream, 'live'), null);
});
