/**
 * What changes between two versions of a plan (./planChanges.mts), and the one question of a fixed-step offer: did
 * exactly that step change, into a fixed step? Also the replay's comparison of a step whose type changed on purpose
 * (../replay/replayCompare.mts `outputOnly`).
 *
 * Run: cd server && node --test core/cowork/plan/planChanges.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { changesOf, onlyStepMadeFixed } = require('./planChanges.mts');
const { compareReplay } = require('../replay/replayCompare.mts');
const { fakeLookups, planOf, literal } = require('./plan.testkit');

const lookups = fakeLookups();
const BASE = planOf([
    { id: 'orders', type: 'integration_action', label: 'Read the order table', tool: 'drive_search', inputs: { query: literal('orders') }, position: { x: 1, y: 1 } },
    { id: 'sum', type: 'ai_step', label: 'Count the late orders', prompt: 'How many are late?' },
    { id: 'tell', type: 'notification', label: 'Tell me', title: 'Orders', body: '{{steps.sum.output.text}}', channels: ['notification'] },
]);
const swap = (id, step) => ({ ...BASE, steps: BASE.steps.map((s) => (s.id === id ? step : s)) });
const FIXED = swap('sum', { id: 'sum', type: 'set', label: 'Count the late orders', fields: { text: literal('2') } });

test('a changed, a new and a gone step; moving a box is no change', () => {
    assert.deepStrictEqual(changesOf(BASE, swap('orders', { ...BASE.steps[0], position: { x: 9, y: 9 } }), lookups), []);
    assert.deepStrictEqual(changesOf(BASE, FIXED, lookups), [{ id: 'sum', title: 'Count the late orders', kind: 'fixed', change: 'changed' }]);
    const grown = { ...BASE, steps: [...BASE.steps.filter((s) => s.id !== 'tell'), { id: 'log', type: 'set', label: 'Keep a note', fields: {} }] };
    assert.deepStrictEqual(changesOf(BASE, grown, lookups).map((c) => [c.id, c.change]), [['log', 'added'], ['tell', 'removed']]);
});

test('a fixed-step offer is exactly that step, made fixed, with the same wiring', () => {
    assert.strictEqual(onlyStepMadeFixed(BASE, FIXED, 'sum', lookups), true);
    assert.strictEqual(onlyStepMadeFixed(BASE, FIXED, 'orders', lookups), false, 'another step');
    assert.strictEqual(onlyStepMadeFixed(BASE, swap('sum', { ...BASE.steps[1], prompt: 'Count them.' }), 'sum', lookups), false, 'still AI');
    const alsoElsewhere = { ...FIXED, steps: FIXED.steps.map((s) => (s.id === 'tell' ? { ...s, title: 'Changed' } : s)) };
    assert.strictEqual(onlyStepMadeFixed(BASE, alsoElsewhere, 'sum', lookups), false, 'and another step');
    assert.strictEqual(onlyStepMadeFixed(BASE, { ...FIXED, edges: FIXED.edges.slice(1) }, 'sum', lookups), false, 'other wiring');
});

test('the replay compares a step whose type changed on purpose on what it hands on', () => {
    const step = (stepType, input, output) => ({ stepType, status: 'success', input, output, usable: true });
    const baseline = new Map([['sum', step('ai_step', { prompt: 'How many?' }, { text: '2' })]]);
    const same = new Map([['sum', step('set', { fields: { text: '2' } }, { text: '2' })]]);
    const other = new Map([['sum', step('set', { fields: { text: '3' } }, { text: '3' })]]);
    assert.strictEqual(compareReplay(baseline, same).verdict, 'differs', 'read as it reads, the input differs');
    assert.strictEqual(compareReplay(baseline, same, new Set(['sum'])).verdict, 'same');
    assert.strictEqual(compareReplay(baseline, other, new Set(['sum'])).verdict, 'differs');
});
