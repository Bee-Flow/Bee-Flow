/**
 * The per-step forEach rules: a list cannot come from the step's own item, a
 * list inside a list names its outer lists correctly (`forEach.parents`), and
 * a field that reads a field the item does not have is flagged.
 *
 * Run: cd server && node --test automation/validate/stepRules/iterationRules.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { validateDefinition } = require('../../validate');
const { forEachBoundVars } = require('./iterationRules');

const TRIGGER = { id: 'trg', type: 'trigger', kind: 'manual' };

function def(step, upstream = []) {
    const steps = [...upstream, step];
    const edges = [{ from: 'trg', to: steps[0].id }];
    for (let i = 1; i < steps.length; i++) edges.push({ from: steps[i - 1].id, to: steps[i].id });
    return { trigger: TRIGGER, steps, edges };
}

const SEARCH = { id: 's1', type: 'integration_action', tool: 'gmail_search', inputs: { query: { kind: 'literal', value: 'x' } } };
const READ = {
    id: 's2', type: 'integration_action', tool: 'gmail_read',
    forEach: { overRef: 'steps.s1.output.results', itemVar: 'result', maxIterations: 100 },
    inputs: { messageId: { kind: 'ref', path: 'loop.result.id' } },
};
const codes = (r, sev) => (sev === 'warning' ? r.warnings : r.errors).map(e => e.code);

test('a forEach whose list is its own item is refused (it is resolved before any item exists)', () => {
    const att = {
        id: 's3', type: 'integration_action', tool: 'gmail_read_attachment',
        forEach: { overRef: 'loop.mail.attachments', itemVar: 'mail', maxIterations: 100 },
        inputs: { messageId: { kind: 'ref', path: 'loop.mail.messageId' }, attachmentId: { kind: 'ref', path: 'loop.mail.attachmentId' } },
    };
    const r = validateDefinition(def(att, [SEARCH, READ]));
    assert.ok(codes(r).includes('foreach.overRef_self'), JSON.stringify(r.errors));
    // A Loop's variable above the step is a fine source.
    const inLoop = {
        id: 'lp', type: 'loop', overRef: 'steps.s1.output.results', itemVar: 'mail', maxIterations: 100,
        body: [{ ...att, forEach: { overRef: 'loop.mail.attachments', itemVar: 'attachment' }, inputs: { attachmentId: { kind: 'ref', path: 'loop.attachment.attachmentId' } } }],
    };
    const r2 = validateDefinition(def(inLoop, [SEARCH]));
    assert.ok(!codes(r2).includes('foreach.overRef_self'), JSON.stringify(r2.errors));
    // …also when the step names its own item like the Loop's: the list is read first.
    const shadow = { ...inLoop, body: [{ ...inLoop.body[0], forEach: { overRef: 'loop.mail.attachments', itemVar: 'mail' }, inputs: { attachmentId: { kind: 'ref', path: 'loop.mail.attachmentId' } } }] };
    assert.ok(!codes(validateDefinition(def(shadow, [SEARCH]))).includes('foreach.overRef_self'));
});

test('forEach.parents must be outer parts of the overRef, with names of their own', () => {
    const base = {
        id: 's3', type: 'integration_action', tool: 'gmail_read_attachment',
        inputs: { messageId: { kind: 'ref', path: 'loop.result.id' }, attachmentId: { kind: 'ref', path: 'loop.attachment.attachmentId' } },
    };
    const good = { ...base, forEach: { overRef: 'steps.s2.output.results[*].output.attachments', itemVar: 'attachment', parents: [{ itemVar: 'result', overRef: 'steps.s2.output.results[*].output' }] } };
    const r = validateDefinition(def(good, [SEARCH, READ]));
    assert.ok(!codes(r).includes('foreach.parents_invalid'), JSON.stringify(r.errors));

    for (const parents of [
        'result',
        [{ itemVar: 'result' }],
        [{ itemVar: 'result', overRef: 'steps.s1.output.results' }],
        [{ itemVar: 'attachment', overRef: 'steps.s2.output.results[*].output' }],
    ]) {
        const bad = { ...base, forEach: { ...good.forEach, parents } };
        assert.ok(codes(validateDefinition(def(bad, [SEARCH, READ]))).includes('foreach.parents_invalid'), JSON.stringify(parents));
    }
});

test('forEachBoundVars: the item and every valid parent', () => {
    assert.deepStrictEqual(forEachBoundVars({ itemVar: 'line_item', overRef: 'steps.s.output.orders[*].line_items', parents: [{ itemVar: 'order', overRef: 'steps.s.output.orders' }] }), ['line_item', 'order']);
    assert.deepStrictEqual(forEachBoundVars({ itemVar: 'x', overRef: 'steps.s.output.a', parents: [{ itemVar: 'y', overRef: 'steps.t.output.a' }] }), ['x']);
    assert.deepStrictEqual(forEachBoundVars(null), []);
});

test('a field the item does not have is flagged: attachments have no `id`', () => {
    // The list was switched from the search results to the attachments; the
    // item name stayed `result`, so messageId still reads loop.result.id.
    const att = {
        id: 's3', type: 'integration_action', tool: 'gmail_read_attachment',
        forEach: { overRef: 'steps.s2.output.results[*].output.attachments', itemVar: 'result', maxIterations: 100 },
        inputs: { messageId: { kind: 'ref', path: 'loop.result.id' }, attachmentId: { kind: 'ref', path: 'loop.result.attachmentId' } },
    };
    const r = validateDefinition(def(att, [SEARCH, READ]));
    const w = r.warnings.filter(x => x.code === 'foreach.item_field_missing');
    assert.strictEqual(w.length, 1, JSON.stringify(r.warnings));
    assert.match(w[0].message, /input "messageId" reads loop\.result\.id/);
    assert.match(w[0].message, /no "id" \(it has: attachmentId/);
    // A direct list of an earlier step is checked the same way.
    const plain = {
        id: 's3', type: 'integration_action', tool: 'gmail_read',
        forEach: { overRef: 'steps.s1.output.results', itemVar: 'result', maxIterations: 100 },
        inputs: { messageId: { kind: 'ref', path: 'loop.result.nope' } },
    };
    const r2 = validateDefinition(def(plain, [SEARCH]));
    const w2 = r2.warnings.filter(x => x.code === 'foreach.item_field_missing');
    assert.strictEqual(w2.length, 1, JSON.stringify(r2.warnings));
    assert.match(w2[0].message, /loop\.result\.nope/);
    assert.match(w2[0].message, /messageId/);
    // An item whose shape nobody describes stays quiet rather than flagging valid fields.
    const unknown = { ...plain, id: 's4', forEach: { overRef: 'steps.s1.output.whatever', itemVar: 'result' } };
    assert.ok(!validateDefinition(def(unknown, [SEARCH])).warnings.some(x => x.code === 'foreach.item_field_missing'));
});

test('the outer item a deepened step keeps is a bound variable for its fields', () => {
    const att = {
        id: 's3', type: 'integration_action', tool: 'gmail_read_attachment',
        forEach: { overRef: 'steps.s2.output.results[*].output.attachments', itemVar: 'attachment', parents: [{ itemVar: 'result', overRef: 'steps.s2.output.results[*].output' }] },
        inputs: { messageId: { kind: 'ref', path: 'loop.result.id' }, attachmentId: { kind: 'ref', path: 'loop.attachment.attachmentId' } },
    };
    const r = validateDefinition(def(att, [SEARCH, READ]));
    assert.ok(!codes(r).includes('ref.loop_unbound'), JSON.stringify(r.errors));
});
