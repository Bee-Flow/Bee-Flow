// @typecheck strict
'use strict';

/**
 * answersFromJourney: the answers of a finished journey, kept for replay.
 * Run: node --test automation/testing/formAnswers.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { answersFromJourney, answersSize, hasAnswers } = require('./formAnswers');

const formTrigger = { id: 'trg_form', kind: 'form', form: { fields: [
    { name: 'topic', type: 'text', label: 'Topic' },
    { name: 'count', type: 'number', label: 'Count' },
    { name: 'intro', type: 'info', label: 'Intro', content: 'Read me' },
] } };

const page = (/** @type {string} */ id, /** @type {unknown[]} */ fields, extra = {}) => ({ id, type: 'form_page', form: { fields }, ...extra });
const row = (/** @type {string} */ stepId, /** @type {unknown} */ output, extra = {}) => ({ runId: 'r2', stepId, parentStepId: null, stepType: 'form_page', attempts: 1, status: 'success', output, ...extra });

test('form-trigger answers are filtered to the declared, non-display fields', () => {
    const definition = { trigger: formTrigger, steps: [] };
    const rootRun = { id: 'r1', rootStepId: null, triggerPayload: { topic: 'alpha', count: 3, intro: 'x', stray: 'y', _meta: 1 } };
    const a = answersFromJourney({ definition, rootRun, steps: [] });
    assert.deepStrictEqual(a.trigger, { topic: 'alpha', count: 3 });
    assert.deepStrictEqual(a.skipped, [{ stepId: null, field: 'intro', reason: 'not_declared' }, { stepId: null, field: 'stray', reason: 'not_declared' }]);
    assert.strictEqual(a.v, 1);
});

test('a secondary form trigger is read when it is the one the run entered', () => {
    const definition = { trigger: { id: 'm', kind: 'manual' }, triggers: [formTrigger], steps: [] };
    const a = answersFromJourney({ definition, rootRun: { rootStepId: 'trg_form', triggerPayload: { topic: 'beta' } }, steps: [] });
    assert.deepStrictEqual(a.trigger, { topic: 'beta' });
    const b = answersFromJourney({ definition, rootRun: { rootStepId: null, triggerPayload: { topic: 'beta' } }, steps: [] });
    assert.strictEqual(b.trigger, null, 'the primary is not a form');
});

test('a non-form trigger gives trigger null', () => {
    const definition = { trigger: { id: 'm', kind: 'manual' }, steps: [] };
    const a = answersFromJourney({ definition, rootRun: { triggerPayload: { topic: 'x' } }, steps: [] });
    assert.strictEqual(a.trigger, null);
    assert.strictEqual(hasAnswers(a), false);
});

test('two pages are kept and a skipped page is left out', () => {
    const definition = { trigger: { id: 'm', kind: 'manual' }, steps: [
        page('p1', [{ name: 'name', type: 'text', label: 'Name' }]),
        page('p2', [{ name: 'note', type: 'textarea', label: 'Note' }]),
        page('p3', [{ name: 'extra', type: 'text', label: 'Extra' }], { when: 'x' }),
        page('end', [], { mode: 'ending' }),
    ] };
    const steps = [
        row('p1', { name: 'Ada' }),
        row('p2', { note: 'hello' }),
        row('p3', { extra: '', _skipped: true }),
        row('end', { shown: true, mode: 'ending' }),
    ];
    const a = answersFromJourney({ definition, rootRun: {}, steps });
    assert.deepStrictEqual(a.pages, { p1: { name: 'Ada' }, p2: { note: 'hello' } });
    assert.strictEqual(hasAnswers(a), true);
});

test('the last successful attempt wins; failed and awaiting rows are ignored', () => {
    const definition = { trigger: { id: 'm', kind: 'manual' }, steps: [page('p1', [{ name: 'name', type: 'text', label: 'Name' }])] };
    const steps = [
        row('p1', { name: 'first' }, { runId: 'r1' }),
        row('p1', { name: 'second' }, { runId: 'r2' }),
        row('p1', { name: 'broken' }, { runId: 'r3', status: 'error' }),
        row('p1', null, { runId: 'r4', status: 'awaiting_form' }),
    ];
    assert.deepStrictEqual(answersFromJourney({ definition, rootRun: {}, steps }).pages, { p1: { name: 'second' } });
});

test('file and app_pick answers go to skipped by field name, never kept', () => {
    const definition = { trigger: { id: 'm', kind: 'manual' }, steps: [page('p1', [
        { name: 'doc', type: 'file', label: 'Document' },
        { name: 'rec', type: 'app_pick', label: 'Record', source: 'nope' },
        { name: 'none', type: 'file', label: 'Nothing' },
        { name: 'name', type: 'text', label: 'Name' },
    ])] };
    const steps = [row('p1', { doc: { kind: 'form_upload', fileId: 'f1' }, rec: { title: 'T' }, none: null, name: 'Ada' })];
    const a = answersFromJourney({ definition, rootRun: {}, steps });
    assert.deepStrictEqual(a.pages.p1, { name: 'Ada' });
    assert.deepStrictEqual(a.skipped, [
        { stepId: 'p1', field: 'doc', reason: 'file' },
        { stepId: 'p1', field: 'rec', reason: 'app_pick' },
    ]);
    assert.ok(!JSON.stringify(a).includes('f1'), 'no file id leaks into the answers');
});

test('undeclared keys go to skipped and underscore keys are dropped', () => {
    const definition = { trigger: { id: 'm', kind: 'manual' }, steps: [page('p1', [{ name: 'name', type: 'text', label: 'Name' }])] };
    const steps = [row('p1', { name: 'Ada', ghost: 'boo', _dryRun: true, _fromScenario: true })];
    const a = answersFromJourney({ definition, rootRun: {}, steps });
    assert.deepStrictEqual(a.pages.p1, { name: 'Ada' });
    assert.deepStrictEqual(a.skipped, [{ stepId: 'p1', field: 'ghost', reason: 'not_declared' }]);
});

test('rows of layers (parentStepId) are not page answers; answersSize counts JSON bytes', () => {
    const definition = { trigger: { id: 'm', kind: 'manual' }, steps: [page('p1', [{ name: 'name', type: 'text', label: 'Name' }])] };
    const steps = [row('p1', { name: 'inner' }, { parentStepId: 'cl1' })];
    const a = answersFromJourney({ definition, rootRun: {}, steps });
    assert.deepStrictEqual(a.pages, {});
    assert.strictEqual(answersSize({ a: 'é' }), Buffer.byteLength('{"a":"é"}'));
});
