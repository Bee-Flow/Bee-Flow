/**
 * An iteration cap that cuts a list must show up on the run, not only inside
 * the step output (#213). Run: node --test core/automationRunner/truncations.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { noteTruncation, truncationSummary } = require('./truncations');
const { runSummary } = require('./runFinalize');
const { registerRunnerPorts } = require('./featurePorts');

registerRunnerPorts({ summarise: { summariseDefinition: () => ({ summary: 'Runs.' }) } });

test('noteTruncation records the cut on the run and in its warnings', () => {
    const ctx = { _truncations: [] };
    const rs = { _templateWarnings: [] };
    noteTruncation({ step: { id: 's1' }, ctx, runState: rs, processed: 100, total: 250 });
    assert.strictEqual(ctx._truncations.length, 1);
    assert.match(rs._templateWarnings[0], /s1 processed 100 of 250 items/);
    assert.match(truncationSummary(ctx._truncations), /1 step stopped at an iteration cap: s1 processed 100 of 250 items/);
});

test('truncationSummary is empty without a cut', () => {
    assert.strictEqual(truncationSummary([]), '');
    assert.strictEqual(truncationSummary(undefined), '');
});

test('the run summary of a green run names the cut', () => {
    const summary = runSummary({
        automation: { definition: {} }, ctx: { _truncations: [{ stepId: 'lp', processed: 100, total: 250, unit: 'items', implicit: true }] },
        firstRunNeedsConfirm: false, runStatus: 'success', runErrorMsg: null, handledErrorCount: 0,
    });
    assert.match(summary, /lp processed 100 of 250 items/);
});

test('a step capped on every iteration is one entry', () => {
    const ctx = { _truncations: [] };
    noteTruncation({ step: { id: 's1' }, ctx, processed: 100, total: 250 });
    noteTruncation({ step: { id: 's1' }, ctx, processed: 100, total: 300 });
    assert.strictEqual(ctx._truncations.length, 1);
    assert.match(truncationSummary(ctx._truncations), /1 step stopped/);
});
