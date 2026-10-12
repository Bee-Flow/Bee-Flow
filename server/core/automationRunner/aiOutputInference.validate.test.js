/**
 * The validator shows and checks the same reads the runner infers from
 * (validate/stepRules/stepContext.js uses aiOutputInference.js), so the two
 * fixes there must hold on the validator side too:
 *   - a note (or a code comment) mentioning `steps.<id>.output.<f>` is not a
 *     read: it used to block activation with a false
 *     `ai_step.output_schema_missing`;
 *   - a per-item AI step nested in a loop body is read through its envelope:
 *     `results[*].output.<f>` only warns, a direct `.output.<f>` read is
 *     still refused.
 *
 * Run: cd server && node --test core/automationRunner/aiOutputInference.validate.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateDefinition } = require('../../automation/validate');

const MISSING = 'ai_step.output_schema_missing';
const INFERRED = 'ai_step.output_schema_inferred';
const codes = (list) => (list || []).map(e => e.code);

const perItem = (extraSteps = [], body = '{{ steps.summ.output.results[*].output.summary }}') => ({
    trigger: { id: 'trg', kind: 'manual' },
    steps: [
        { id: 'src', type: 'integration_action', tool: 'nextcloud_list_files', inputs: { path: { kind: 'literal', value: '/' } } },
        { id: 'summ', type: 'ai_step', prompt: 'Summarise', forEach: { overRef: 'steps.src.output.items', itemVar: 'm' } },
        { id: 'n', type: 'notification', title: 'Summary', body },
        ...extraSteps,
    ],
    edges: [{ from: 'trg', to: 'src' }, { from: 'src', to: 'summ' }, { from: 'summ', to: 'n' }],
});

test('a note mentioning a field of a per-item step does not block activation', () => {
    const base = validateDefinition(perItem(), { stage: 'activate' });
    assert.ok(!codes(base.errors).includes(MISSING), 'precondition: the envelope read alone is served');
    for (const extra of [
        { id: 'n1', type: 'note', text: 'TODO: also show steps.summ.output.sentiment once we have it.' },
        { id: 'c1', type: 'code', code: '// later: steps.summ.output.sentiment\nreturn inputs;', inputs: {} },
    ]) {
        const r = validateDefinition(perItem([extra]), { stage: 'activate' });
        assert.ok(!codes(r.errors).includes(MISSING), `${extra.type}: ${JSON.stringify(r.errors)}`);
    }
});

const nested = (body) => ({
    trigger: { id: 'trg', kind: 'manual' },
    steps: [
        { id: 'src', type: 'integration_action', tool: 'nextcloud_list_files', inputs: { path: { kind: 'literal', value: '/' } } },
        { id: 'lp', type: 'loop', overRef: 'steps.src.output.batches', itemVar: 'batch', body: [
            { id: 'summ', type: 'ai_step', prompt: 'Summarise', forEach: { overRef: 'loop.batch.mails', itemVar: 'm' } },
            { id: 'n', type: 'notification', title: 'Summary', body },
        ] },
    ],
    edges: [{ from: 'trg', to: 'src' }, { from: 'src', to: 'lp' }],
});

test('a nested per-item AI step read through its envelope only warns, with the per-answer schema', () => {
    const r = validateDefinition(nested('{{ steps.summ.output.results[*].output.summary }}'), { stage: 'activate' });
    assert.ok(!codes(r.errors).includes(MISSING), JSON.stringify(r.errors));
    const w = (r.warnings || []).find(x => x.code === INFERRED && /summ/.test(x.message));
    assert.ok(w, JSON.stringify(r.warnings));
    assert.ok(!/results/.test(w.message), `the inferred schema is one answer's, not the envelope: ${w.message}`);
});

test('a field read straight off a nested per-item AI step is still refused', () => {
    const r = validateDefinition(nested('{{ steps.summ.output.summary }}'), { stage: 'activate' });
    assert.ok(codes(r.errors).includes(MISSING), JSON.stringify(r.errors));
});
