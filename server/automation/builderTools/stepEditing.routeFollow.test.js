/**
 * builder_update_step on a list switch's cases: the edges and the steps that
 * read the outputs follow the same rule as on the canvas and the phone
 * (shared/expr/routeFollow.mjs switchCaseChanges). A reorder or a removed
 * case once re-pointed the readers by position while the edges kept their
 * names, so a step hung off one output and read another.
 *
 * Run: cd server && node --test automation/builderTools/stepEditing.routeFollow.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { applyToolCall } = require('../builderTools');

const MESSAGES = 'steps.rm.output.messages';
const cases = (...names) => names.map(name => ({ name, expr: `equals(fileType(item), "${name}")` }));
const reader = (id, name) => ({
    id, type: 'notification', title: 't', label: id,
    forEach: { overRef: `steps.sw.output.matchesByCase.${name}`, itemVar: 'x' },
});

function wrap(names) {
    return {
        userId: 'u_test',
        def: {
            trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
            steps: [
                { id: 'rm', type: 'integration_action', tool: 'gmail_read_many', label: 'Read many', inputs: {} },
                { id: 'sw', type: 'switch', label: 'Condition', arrayRef: MESSAGES, routeStyle: 'rules', cases: cases(...names), defaultBranch: names[0] },
                ...names.map(n => reader(`r_${n}`, n)),
            ],
            edges: [
                { from: 'trg', to: 'rm' }, { from: 'rm', to: 'sw' },
                ...names.map(n => ({ from: 'sw', to: `r_${n}`, label: `case:${n}`, caseName: n })),
            ],
        },
    };
}

const readsOf = def => Object.fromEntries(def.steps.filter(s => s.forEach).map(s => [s.id, s.forEach.overRef.split('.').pop()]));
const edgesOf = def => def.edges.filter(e => e.from === 'sw').map(e => `${e.caseName}→${e.to}`);
const swOf = def => def.steps.find(s => s.id === 'sw');

test('reordering the cases moves neither an edge nor a reader', async () => {
    const dw = wrap(['pdf', 'word']);
    const r = await applyToolCall('builder_update_step', { stepId: 'sw', patch: { cases: cases('word', 'pdf') } }, dw);
    assert.ok(!r.error, r.error);
    assert.deepStrictEqual(readsOf(dw.def), { r_pdf: 'pdf', r_word: 'word' });
    assert.deepStrictEqual(edgesOf(dw.def), ['pdf→r_pdf', 'word→r_word']);
    assert.ok(!(r._warnings || []).some(w => /Re-pointed/.test(w)), 'nothing tells the model its refs moved');
});

test('removing the first case keeps every other reader on its own output and drops the removed edge', async () => {
    const dw = wrap(['pdf', 'word', 'excel']);
    const r = await applyToolCall('builder_update_step', { stepId: 'sw', patch: { cases: cases('word', 'excel') } }, dw);
    assert.ok(!r.error, r.error);
    assert.deepStrictEqual(readsOf(dw.def), { r_pdf: 'pdf', r_word: 'word', r_excel: 'excel' });
    assert.deepStrictEqual(edgesOf(dw.def), ['word→r_word', 'excel→r_excel']);
    assert.strictEqual(swOf(dw.def).defaultBranch, null);
});

test('renaming a case in place moves its edge, its defaultBranch and its reader together', async () => {
    const dw = wrap(['pdf', 'word']);
    const r = await applyToolCall('builder_update_step', { stepId: 'sw', patch: { cases: cases('invoices', 'word') } }, dw);
    assert.ok(!r.error, r.error);
    assert.deepStrictEqual(readsOf(dw.def), { r_pdf: 'invoices', r_word: 'word' });
    assert.deepStrictEqual(edgesOf(dw.def), ['invoices→r_pdf', 'word→r_word']);
    assert.strictEqual(swOf(dw.def).defaultBranch, 'invoices');
    assert.ok(r._warnings.some(w => /Moved the connections of output "pdf" of sw to its new name "invoices"/.test(w)), r._warnings);
});

test('turning the list switch back to the whole run points the readers at the list again', async () => {
    const dw = wrap(['pdf', 'word']);
    const r = await applyToolCall('builder_update_step', { stepId: 'sw', patch: { arrayRef: null } }, dw);
    assert.ok(!r.error, r.error);
    assert.deepStrictEqual(readsOf(dw.def), { r_pdf: 'messages', r_word: 'messages' });
});
