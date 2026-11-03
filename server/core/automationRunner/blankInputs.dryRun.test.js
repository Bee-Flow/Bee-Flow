// @typecheck
/**
 * RM-5: the blank-input preflight in a DRY RUN.
 *
 * A dry run performs every check that has no side effect the way a live run
 * does (./execCode.js header). A write whose binding reads a field of REAL
 * upstream data that is not there fails live, so it fails in the dry run too.
 * A miss on data the dry run made up itself (a step marked synthesised, a
 * synthetic trigger, an approval it auto-approved, a notification it did not
 * send) predicts nothing about the live run and stays a warning.
 *
 * Run: node --test core/automationRunner/blankInputs.dryRun.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { preflightBlankInputs, missesThatFail } = require('./blankInputs');

const BAD = '{{steps.ev.output.event.summary}}';
const notify = (body) => ({ type: 'notification', id: 'n', title: 't', body });
const state = (ev) => ({ steps: { ev }, trigger: { output: {} }, _templateWarnings: [] });

test('a live-data miss fails in a dry run', () => {
    assert.throws(
        () => preflightBlankInputs(notify(BAD), state({ output: { summary: 'Standup' } }), 'dry_run', {}),
        (/** @type {any} */ e) => e.errorClass === 'binding_unresolved' && /steps\.ev\.output\.event\.summary/.test(e.message),
    );
});

test('a miss on a step the dry run synthesised does not fail', () => {
    assert.doesNotThrow(() => preflightBlankInputs(notify(BAD), state({ output: { summary: 'x' }, synthesised: true }), 'dry_run', {}));
});

test('a miss on a simulated answer (auto-approved approval, unsent notification) does not fail', () => {
    assert.doesNotThrow(() => preflightBlankInputs(notify('{{steps.ev.output.answers.reason}}'),
        state({ output: { approved: true, _dryRun: true, answers: {} } }), 'dry_run', {}));
    assert.doesNotThrow(() => preflightBlankInputs(notify('{{steps.ev.output.messageId}}'),
        state({ output: { wouldNotify: { title: 't' } } }), 'dry_run', {}));
});

test('the same simulated miss still fails live (live data never carries the markers)', () => {
    assert.throws(() => preflightBlankInputs(notify(BAD), state({ output: { summary: 'x' } }), 'live', {}));
});

test('a formula that does not parse fails in a dry run whatever it reads', () => {
    const step = { type: 'datatable', id: 'd', op: 'add_row', datatableId: 't', values: { Name: { kind: 'expr', value: '({ a: 1 })' } } };
    assert.throws(() => preflightBlankInputs(step, state({ output: {}, synthesised: true }), 'dry_run', {}),
        (/** @type {any} */ e) => e.errorClass === 'binding_unresolved');
});

test('missesThatFail: live keeps every miss, a dry run drops the simulated ones only', () => {
    const misses = [
        { kind: 'template', reason: 'missing', path: 'steps.sim.output.x' },
        { kind: 'template', reason: 'missing', path: 'steps.real.output.x' },
    ];
    const rs = { steps: { sim: { output: {}, synthesised: true }, real: { output: {} } } };
    assert.equal(missesThatFail(misses, rs, {}, 'live').length, 2);
    assert.deepEqual(missesThatFail(misses, rs, {}, 'dry_run').map(m => m.path), ['steps.real.output.x']);
});
