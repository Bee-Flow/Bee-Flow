/**
 * builder_remove_step reports the steps that still read the removed one.
 *
 * The check used to be a regex over the collected bindings,
 * `\bsteps\.<id>(?![A-Za-z0-9_])` with the id spliced in unescaped. It missed
 * every read in the bracket spelling (`steps["read"]…`, which the canvas
 * writes for an id that needs it) and every read in a field that is not a
 * binding object (a forEach list, a condition's expression, a template text),
 * and an id with a regex character in it matched other ids. The reads are now
 * found with the validator's own surface list and the runner's path reader.
 *
 * Run: cd server && node --test automation/builderTools/stepEditing.danglingRefs.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { applyRemoveStep } = require('./stepEditing');

function graph(consumers) {
    return {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [{ id: 'read', type: 'integration_action', tool: 'nextcloud_read_file', inputs: {} }, ...consumers],
        edges: [{ from: 'trg', to: 'read' }, ...consumers.map(c => ({ from: 'read', to: c.id }))],
    };
}

const dangling = (g) => applyRemoveStep(g, { stepId: 'read' }).danglingRefs || [];

test('a dotted binding read is reported (the case that already worked)', () => {
    const g = graph([{ id: 'n1', type: 'notification', title: 't', body: 'b', inputs: { x: { kind: 'ref', path: 'steps.read.output.text' } } }]);
    assert.deepStrictEqual(dangling(g), ['n1']);
});

test('a bracketed read is reported', () => {
    const g = graph([{ id: 'n1', type: 'notification', title: 't', body: 'b', inputs: { x: { kind: 'ref', path: 'steps["read"].output["content-type"]' } } }]);
    assert.deepStrictEqual(dangling(g), ['n1']);
});

test('reads outside binding objects are reported: a forEach list, a template text, an expression', () => {
    const g = graph([
        { id: 'fe', type: 'notification', title: 't', body: 'b', forEach: { overRef: 'steps.read.output.items', itemVar: 'it' } },
        { id: 'tx', type: 'notification', title: 'Got {{ steps.read.output.name }}', body: 'b' },
        { id: 'cd', type: 'condition', expr: 'steps["read"].output.total > 10' },
    ]);
    assert.deepStrictEqual(dangling(g).sort(), ['cd', 'fe', 'tx']);
});

test('an id that merely starts with the removed one, or a value equal to it, is not a read', () => {
    const g = graph([
        { id: 'n1', type: 'notification', title: 't', body: 'b', inputs: { x: { kind: 'ref', path: 'steps.read_more.output.x' } } },
        { id: 'n2', type: 'notification', title: 't', body: 'b', inputs: { x: { kind: 'expr', value: 'steps.other.output.kind == "read"' } } },
        { id: 'n3', type: 'notification', title: 'mention steps.read in prose, not a placeholder', body: 'b' },
    ]);
    g.steps.push({ id: 'read_more', type: 'integration_action', tool: 't', inputs: {} });
    g.steps.push({ id: 'other', type: 'integration_action', tool: 't', inputs: {} });
    assert.deepStrictEqual(dangling(g), []);
});

test('a read from inside a loop body names the loop that carries it', () => {
    const g = graph([{
        id: 'lp', type: 'loop', overRef: 'steps.other.output.items', itemVar: 'it',
        body: [{ id: 'inner', type: 'notification', title: '{{steps.read.output.name}}', body: 'b' }],
    }]);
    assert.deepStrictEqual(dangling(g), ['lp']);
});
