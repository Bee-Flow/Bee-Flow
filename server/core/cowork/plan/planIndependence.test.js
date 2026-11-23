// @typecheck
/**
 * The levels of independence (./planIndependence.mts): which steps a run asks about at each level, and the copy with
 * the questions in it, wired so that whatever led to a step now leads to its question.
 *
 * Run: cd server && node --test core/cowork/plan/planIndependence.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { askTargets, withAsks, isIndependence, ASK_PREFIX } = require('./planIndependence.mts');
const { fakeLookups, planOf, supplierRadar, literal } = require('./plan.testkit');
const { planViewOf } = require('./planView.mts');

const lookups = fakeLookups();
/** A plan that also sends a mail to someone else. */
const sending = () => {
    const plan = supplierRadar();
    plan.steps.splice(6, 0, { id: 'send', type: 'integration_action', label: 'Mail the supplier', tool: 'outlook_compose', inputs: { to: literal('orders@hoekstra-staal.example') } });
    return planOf(plan.steps);
};

test('each level asks about its own kind of step; a result for the owner never waits', () => {
    const effects = Object.fromEntries(planViewOf(sending(), lookups).steps.map((s) => [s.id, s.effect]));
    assert.strictEqual(effects.send, 'sends', 'the test needs a step that sends');
    assert.deepStrictEqual(askTargets(sending(), 'on_its_own', lookups), []);
    assert.deepStrictEqual(askTargets(sending(), 'asks_before_sending', lookups).map((t) => t.id), ['send']);
    const everything = askTargets(sending(), 'asks_everything', lookups).map((t) => t.id);
    assert.ok(everything.includes('send') && everything.includes('table'), 'a change inside Bee Flow is asked about too');
    assert.ok(!everything.includes('digest') && !everything.includes('mail'), 'the result and what only reads are not');
});

test('the copy puts the question in front of its step and leaves every other step and edge alone', () => {
    const plan = sending();
    const copy = /** @type {any} */ (withAsks(plan, 'asks_before_sending', lookups));
    const ask = `${ASK_PREFIX}send`;
    assert.deepStrictEqual(copy.steps.map((/** @type {any} */ s) => s.id), ['mail', 'orders', 'overdue', 'table', 'reply', 'draft', ask, 'send', 'digest']);
    assert.strictEqual(copy.steps[6].type, 'approval');
    assert.match(copy.steps[6].label, /Before it sends: Mail the supplier/);
    assert.ok(copy.edges.some((/** @type {any} */ e) => e.from === 'draft' && e.to === ask));
    assert.ok(copy.edges.some((/** @type {any} */ e) => e.from === ask && e.to === 'send'));
    assert.ok(!copy.edges.some((/** @type {any} */ e) => e.from === 'draft' && e.to === 'send'), 'nothing reaches the step past its question');
    // The original is untouched, and a plan that asks nothing is returned as it is.
    assert.strictEqual(plan.steps.length, 8);
    assert.strictEqual(withAsks(plan, 'on_its_own', lookups), plan);
});

test('a step inside a loop is asked about once, in front of the loop; a branch label stays on its edge', () => {
    const plan = planOf([
        { id: 'mail', type: 'integration_action', tool: 'outlook_search', inputs: {} },
        { id: 'each', type: 'loop', items: '{{steps.mail.output.messages}}', body: [
            { id: 'answer', type: 'integration_action', label: 'Answer it', tool: 'outlook_reply_in_thread', inputs: {} },
        ] },
    ]);
    plan.edges[1] = { ...plan.edges[1], label: 'on_success' };
    const targets = askTargets(plan, 'asks_before_sending', lookups);
    assert.deepStrictEqual(targets, [{ id: 'each', title: 'Answer it', effect: 'sends', steps: ['answer'] }]);
    const copy = /** @type {any} */ (withAsks(plan, 'asks_before_sending', lookups));
    assert.deepStrictEqual(copy.edges.find((/** @type {any} */ e) => e.from === 'mail'), { from: 'mail', to: `${ASK_PREFIX}each`, label: 'on_success' });
    assert.strictEqual(copy.steps.find((/** @type {any} */ s) => s.id === 'each').body.length, 1, 'the loop itself is not changed');
});

test('only the three words are levels', () => {
    assert.ok(['asks_everything', 'asks_before_sending', 'on_its_own'].every(isIndependence));
    assert.ok(![null, '', 'never_asks', 3].some(isIndependence));
});
