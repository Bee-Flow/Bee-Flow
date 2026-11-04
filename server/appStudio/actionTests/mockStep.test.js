'use strict';

/**
 * A mock is the model's answer: the step's pure post-processing still runs on it.
 *
 * Run: cd server && node --test appStudio/actionTests/mockStep.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { mockStepResult, checkMock, mockablePaths, MAX_MOCKS } = require('./mockStep.mts');

const SCHEMA = [{ name: 'customer', type: 'string', required: true }, { name: 'amount', type: 'number' }];

test('ai_generate text: a string or { text } becomes { text, citations: [] }', () => {
    assert.deepEqual(mockStepResult({ kind: 'ai_generate' }, 'Hello').result, { text: 'Hello', citations: [] });
    assert.deepEqual(mockStepResult({ kind: 'ai_generate' }, { text: 'Hi' }).result, { text: 'Hi', citations: [] });
    assert.equal(mockStepResult({ kind: 'ai_generate' }, 42).ok, false);
});

test('ai_generate text with markdownToHtml converts like the real step', () => {
    const out = mockStepResult({ kind: 'ai_generate', markdownToHtml: true }, '**bold**');
    assert.match(out.result.text, /<strong>bold<\/strong>/);
});

test('ai_generate text: an empty interpolated prompt fails as the real step does', () => {
    const out = mockStepResult({ kind: 'ai_generate' }, 'x', { prompt: '   ' });
    assert.deepEqual(out, { ok: false, error: 'The prompt is empty' });
});

test('ai_generate structured: coerced to the step schema (unknown keys dropped, types coerced)', () => {
    const out = mockStepResult({ kind: 'ai_generate', output: 'structured', schema: SCHEMA }, { customer: 'ACME', amount: '1.234,5', extra: 'x' });
    assert.deepEqual(out.result, { customer: 'ACME', amount: 1234.5 });
    assert.equal(mockStepResult({ kind: 'ai_generate', output: 'structured', schema: SCHEMA }, 'text').ok, false);
    assert.match(mockStepResult({ kind: 'ai_generate', output: 'structured', schema: [] }, {}).error, /at least one field/);
});

test('ai_extract: { rows }, a list or one object; rows coerced, written 0, incomplete counted', () => {
    const step = { kind: 'ai_extract', schema: SCHEMA, writeTo: { tableId: 'tbl_a' } };
    const out = mockStepResult(step, { rows: [{ customer: 'ACME', amount: '3' }, { amount: 1 }] });
    assert.equal(out.ok, true);
    assert.deepEqual(out.result, {
        rows: [{ customer: 'ACME', amount: 3 }, { customer: null, amount: 1 }],
        count: 2, written: 0, incomplete: 1, unmatched: [], unmatchedCount: 0, model: 'mock', tier: 'mock',
    });
    assert.deepEqual(out.notes, ['mocked: writeTo not applied']);
    assert.equal(mockStepResult(step, [{ customer: 'B' }]).result.count, 1);
    assert.equal(mockStepResult(step, { customer: 'C' }).result.rows[0].customer, 'C');
    assert.deepEqual(mockStepResult({ ...step, resultDetail: 'summary' }, [{ customer: 'B' }]).result.rows, []);
    assert.equal(mockStepResult(step, 'nope').ok, false);
    assert.match(mockStepResult({ kind: 'ai_extract', schema: [] }, []).error, /No output fields/);
});

test('ai_extract slices the rows to the extract cap', () => {
    const many = Array.from({ length: 600 }, (_, i) => ({ customer: `c${i}` }));
    assert.equal(mockStepResult({ kind: 'ai_extract', schema: SCHEMA }, many).result.count, 500);
});

test('kb_query: a list or { results }; dataset_query: as is', () => {
    assert.deepEqual(mockStepResult({ kind: 'kb_query' }, [{ title: 'a' }]).result, { results: [{ title: 'a' }], count: 1 });
    assert.deepEqual(mockStepResult({ kind: 'kb_query' }, { results: [] }).result, { results: [], count: 0 });
    assert.equal(mockStepResult({ kind: 'kb_query' }, 'x').ok, false);
    assert.deepEqual(mockStepResult({ kind: 'dataset_query' }, { rows: [1] }).result, { rows: [1] });
});

test('$error makes any mockable step fail, with code and retryable when given; the text is capped', () => {
    assert.deepEqual(mockStepResult({ kind: 'ai_generate' }, { $error: 'The model timed out', $code: 'ai_timeout', $retryable: true }),
        { ok: false, error: 'The model timed out', code: 'ai_timeout', retryable: true });
    assert.equal(mockStepResult({ kind: 'kb_query' }, { $error: 'x'.repeat(1000) }).error.length, 300);
    assert.equal(mockStepResult({ kind: 'ai_extract', schema: SCHEMA }, { $error: '' }).error, 'Mocked failure');
});

test('a step kind that is not mockable is refused', () => {
    assert.equal(mockStepResult({ kind: 'create_record' }, {}).ok, false);
});

test('checkMock: keys must be mockable walker paths of the action', () => {
    const action = { kind: 'sequence', steps: [
        { kind: 'toast' },
        { kind: 'loop', source: { kind: 'formula', expr: 'vars.rows' }, steps: [{ kind: 'ai_generate' }] },
    ] };
    assert.deepEqual(mockablePaths(action).map((p) => p.path), ['steps[1].steps[0]']);
    assert.deepEqual(checkMock({ 'steps[1].steps[0]': 'x' }, action), { mock: { 'steps[1].steps[0]': 'x' } });
    assert.deepEqual(checkMock(undefined, action), { mock: {} });
    const bad = checkMock({ 'steps[0]': 'x' }, action);
    assert.match(bad.error, /not an AI or read step/);
    assert.match(bad._fixHint, /steps\[1\]\.steps\[0\] \(ai_generate\)/);
    const tooMany = Object.fromEntries(Array.from({ length: MAX_MOCKS + 1 }, (_, i) => [`k${i}`, 1]));
    assert.match(checkMock(tooMany, action).error, /at most 50/);
    assert.match(checkMock({ 'steps[1].steps[0]': 'x'.repeat(70 * 1024) }, action).error, /larger than 64 KB/);
    assert.match(checkMock('x', action).error, /must be an object/);
});
