// @typecheck
/**
 * The order a plan's steps run in (./planOrder.mts): the topological order of the edges, ties by the definition, a
 * loop's body right after the loop, and every step once even when the edges are broken.
 *
 * Run: cd server && node --test core/cowork/plan/planOrder.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { runOrderOf } = require('./planOrder.mts');
const { planOf } = require('./plan.testkit');

/** @param {string} id @param {string} [type] */
const step = (id, type = 'set') => ({ id, type });

test('a plan written in run order keeps its order', () => {
    assert.deepStrictEqual(runOrderOf(planOf([step('a'), step('b'), step('c')])), ['a', 'b', 'c']);
});

test('a step written first that waits for a later one runs after it', () => {
    const plan = planOf([step('sum'), step('read'), step('tell')]);
    plan.edges = [{ from: 'trg', to: 'read' }, { from: 'read', to: 'sum' }, { from: 'sum', to: 'tell' }];
    assert.deepStrictEqual(runOrderOf(plan), ['read', 'sum', 'tell']);
});

test('steps that wait for nothing in between keep the order of the definition', () => {
    const plan = planOf([step('b'), step('a'), step('end')]);
    plan.edges = [{ from: 'trg', to: 'b' }, { from: 'trg', to: 'a' }, { from: 'a', to: 'end' }, { from: 'b', to: 'end' }];
    assert.deepStrictEqual(runOrderOf(plan), ['b', 'a', 'end']);
});

test('the steps inside a loop follow the loop, in the order of its body', () => {
    const plan = planOf([
        step('after', 'notification'),
        { id: 'each', type: 'loop', body: [step('one', 'ai_step'), step('two')] },
    ]);
    plan.edges = [{ from: 'trg', to: 'each' }, { from: 'each', to: 'after' }];
    assert.deepStrictEqual(runOrderOf(plan), ['each', 'one', 'two', 'after']);
});

test('a cycle cannot run, but every step is still listed once', () => {
    const plan = planOf([step('a'), step('b'), step('c')]);
    plan.edges = [{ from: 'trg', to: 'a' }, { from: 'b', to: 'c' }, { from: 'c', to: 'b' }];
    assert.deepStrictEqual(runOrderOf(plan), ['a', 'b', 'c']);
});

test('a note is no step, and nothing to read is an empty order', () => {
    assert.deepStrictEqual(runOrderOf(planOf([step('n', 'note'), step('a')])), ['a']);
    for (const plan of [null, undefined, {}, { steps: 'no' }]) assert.deepStrictEqual(runOrderOf(/** @type {any} */ (plan)), []);
});
