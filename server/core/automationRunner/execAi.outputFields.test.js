/**
 * collectAiStepOutputFields reads picks where it read refs.
 *
 * An ai_step without an outputSchema answers in a schema the runner infers
 * from what later steps read off it (`steps.<id>.output.<field>`), and wraps
 * a prose answer under the FIRST of those fields. "Koppelingen bijwerken"
 * (shared/mapping/upgrade.mjs upgradeDefinition) turns those refs into
 * picks; if this walk saw only refs, the upgrade would change what the model
 * is asked for and where a prose answer lands. So: the same fields, in the
 * same order, before and after the upgrade, a compose part included. An
 * `each` pick is left out, like the `loop.<v>` ref it replaces; the list a
 * repeat runs over counts where the forEach's overRef did. An expr is not
 * upgraded, so a field only an expr reads stays out, as it was.
 *
 * Run: node --test core/automationRunner/execAi.outputFields.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../../testUtils/stubRequire');

// Keep the module load away from the database and the model catalogue.
const restore = installResolveStub({
    '../llm/modelResolver': { async getUserTierMap() { return {}; } },
    '../entitlements/userTiers': { async getPermittedTierKeys() { return null; } },
    '../llm/promptClassifier': { async classifyWithLLM() { return { tier: 'fast' }; } },
    '../aiAgent': { async getProviderForModel() { return null; }, async getAIConfig() { return {}; } },
    '../providers': { getAdapter: () => ({}) },
    './safety': {},
    '../../stores/usageStore': { async logUsage() {} },
    '../../stores/terminationStore': { async logTermination() {} },
});
after(() => restore());

const { collectAiStepOutputFields } = require('./execAi');
const { upgradeDefinition } = require('../../shared/mapping/index.mjs');

const ref = (path) => ({ kind: 'ref', path });
const pick = (path, take = 'one') => ({ kind: 'pick', v: 1, from: { root: 'steps', id: 'ai', path }, take, as: 'native' });

function definition() {
    return {
        trigger: { id: 't', kind: 'manual' },
        steps: [
            { id: 'ai', type: 'ai_step', prompt: 'Read the invoice' },
            {
                id: 'save', type: 'integration_action', tool: 'x',
                inputs: { total: ref('steps.ai.output.total'), vendor: ref('steps.ai.output.vendor'), when: { kind: 'expr', value: 'upper(steps.ai.output.date)' } },
            },
            { id: 'note', type: 'notification', title: 'Invoice {{steps.ai.output.number}}', body: 'x' },
        ],
    };
}

test('the fields, and their order, survive the upgrade of refs to picks', () => {
    const before = collectAiStepOutputFields(definition(), 'ai');
    assert.deepStrictEqual(before, ['total', 'vendor', 'number']);
    // The last run is the evidence the upgrade checks every binding against.
    const lastRun = { trigger: { output: {} }, steps: { ai: { output: { total: 12, vendor: 'Acme', date: '2026-10-01', number: 'F-1' } } } };
    const { definition: upgraded, changed } = upgradeDefinition(definition(), { lastRun });
    assert.deepStrictEqual(changed.map(c => c.field), ['inputs.total', 'inputs.vendor']);
    assert.deepStrictEqual(collectAiStepOutputFields(upgraded, 'ai'), before);
});

test('a pick among refs is read where it stands', () => {
    const def = definition();
    def.steps[1].inputs = { first: pick(['vendor']), second: ref('steps.ai.output.total') };
    assert.deepStrictEqual(collectAiStepOutputFields(def, 'ai'), ['vendor', 'total', 'number']);
});

test('compose parts in a text field, and what is not a field read', () => {
    const def = definition();
    def.steps[1].inputs = {
        other: { kind: 'pick', v: 1, from: { root: 'steps', id: 'save', path: ['total'] }, take: 'one', as: 'native' },
        index: pick([0]),
        quoted: pick(['due date']),
        item: pick(['results', 'output', 'x'], 'each'),
    };
    def.steps[2].title = { kind: 'compose', v: 1, parts: ['Invoice ', { from: { root: 'steps', id: 'ai', path: ['number'] }, take: 'one', as: 'text' }] };
    assert.deepStrictEqual(collectAiStepOutputFields(def, 'ai'), ['number']);
});

test('a forEach over a field of the ai_step, upgraded to a repeat, still asks for that field', () => {
    const def = {
        trigger: { id: 't', kind: 'manual' },
        steps: [
            { id: 'ai', type: 'ai_step', prompt: 'List the people to mail' },
            {
                id: 'b', type: 'integration_action', tool: 'x',
                forEach: { overRef: 'steps.ai.output.items', itemVar: 'item' },
                inputs: { to: ref('loop.item.email') },
            },
            { id: 'c', type: 'integration_action', tool: 'y', inputs: { text: ref('steps.ai.output.summary') } },
        ],
    };
    const before = collectAiStepOutputFields(def, 'ai');
    assert.deepStrictEqual(before, ['items', 'summary']);
    const lastRun = { trigger: { output: {} }, steps: { ai: { output: { items: [{ email: 'a@x.nl' }], summary: 'Two people' } } } };
    const { definition: upgraded, changed } = upgradeDefinition(def, { lastRun });
    assert.ok(upgraded.steps[1].repeat && !upgraded.steps[1].forEach, 'the forEach became a repeat');
    assert.ok(changed.some(c => c.field === 'forEach'));
    assert.deepStrictEqual(collectAiStepOutputFields(upgraded, 'ai'), before);
});

test('an expr reading the ai_step stays an expr, so the fields stay as they were', () => {
    const def = definition();
    def.steps[1].inputs = { x: { kind: 'expr', value: 'first(steps.ai.output.tags)' }, y: ref('steps.ai.output.summary') };
    const before = collectAiStepOutputFields(def, 'ai');
    assert.deepStrictEqual(before, ['summary', 'number']);
    const { evaluate } = require('../../automation/expr');
    const lastRun = { trigger: { output: {} }, steps: { ai: { output: { tags: ['a'], summary: 'S', number: 'F-1' } } } };
    const { definition: upgraded } = upgradeDefinition(def, { lastRun, evaluate });
    assert.equal(upgraded.steps[1].inputs.x.kind, 'expr');
    assert.deepStrictEqual(collectAiStepOutputFields(upgraded, 'ai'), before);
});
