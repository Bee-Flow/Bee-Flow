// @typecheck
/**
 * Choosing how a cowork starts (./coworkStart.mts): the rules per start, the webhook token shown once with only its
 * hash kept, and the subscription that follows the start. Every part is handed in.
 *
 * Run: cd server && node --test usecases/coworkStart.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { chooseStart, startOf } = require('./coworkStart.mts');

/** @param {Record<string, any>} [items] */
function world(items = {}) {
    /** @type {any[]} */
    const set = [];
    /** @type {any[]} */
    const synced = [];
    const deps = {
        getSchedule: async (/** @type {string} */ id) => items[id] ?? null,
        setStart: async (/** @type {string} */ id, /** @type {string} */ kind, /** @type {any} */ trigger) => { set.push([id, kind, trigger]); },
        syncSubscription: async (/** @type {any} */ item) => { synced.push(item.triggerKind); },
        canReadTable: async (/** @type {string} */ _u, /** @type {string} */ id) => id === 't-mine',
        clientHost: () => 'https://bee.example',
    };
    return { deps, set, synced };
}
const ITEM = { id: 'w1', userId: 'u1', title: 'Order log', agentId: 'a1', planAutomationId: null, triggerKind: 'schedule', nextRunAt: '2026-11-24T07:30:00Z' };

test('a webhook gets a new token, shown once; only its hash is kept', async () => {
    const w = world();
    const state = await chooseStart({ item: ITEM, choice: { kind: 'webhook' } }, w.deps);
    assert.strictEqual(state.address?.url, 'https://bee.example/api/cowork/hooks');
    const token = String(state.address?.token);
    assert.ok(token.length >= 30);
    assert.deepStrictEqual(w.set, [['w1', 'webhook', { tokenHash: crypto.createHash('sha256').update(token).digest('hex') }]]);
    assert.ok(!JSON.stringify(w.set).includes(token), 'the token itself is not stored');
    assert.deepStrictEqual([state.kind, state.hasAddress, w.synced], ['webhook', true, ['webhook']]);
});

test('after another cowork: one of the owner\'s own, never itself, never one that follows this one', async () => {
    const items = {
        b: { id: 'b', userId: 'u1', title: 'Supplier radar', triggerKind: 'schedule' },
        c: { id: 'c', userId: 'u1', title: 'Follows me', triggerKind: 'after_cowork', trigger: { scheduleId: 'w1' } },
        x: { id: 'x', userId: 'someone-else', title: 'Not mine', triggerKind: 'schedule' },
    };
    const w = world(items);
    const state = await chooseStart({ item: ITEM, choice: { kind: 'after_cowork', scheduleId: 'b' } }, w.deps);
    assert.deepStrictEqual(state.after, { id: 'b', title: 'Supplier radar' });
    await assert.rejects(chooseStart({ item: ITEM, choice: { kind: 'after_cowork', scheduleId: 'x' } }, w.deps), (/** @type {any} */ e) => e.status === 404);
    await assert.rejects(chooseStart({ item: ITEM, choice: { kind: 'after_cowork', scheduleId: 'c' } }, w.deps), (/** @type {any} */ e) => e.status === 409 && /circle/.test(e.message));
    await assert.rejects(chooseStart({ item: ITEM, choice: { kind: 'after_cowork', scheduleId: 'w1' } }, world({ w1: ITEM }).deps), (/** @type {any} */ e) => e.status === 409);
});

test('a table the owner can read; a folder; the clock only with a time; an event never for a prompt alone', async () => {
    const w = world();
    assert.strictEqual((await chooseStart({ item: ITEM, choice: { kind: 'row', datatableId: 't-mine' } }, w.deps)).datatableId, 't-mine');
    await assert.rejects(chooseStart({ item: ITEM, choice: { kind: 'row', datatableId: 't-other' } }, w.deps), (/** @type {any} */ e) => e.status === 404);
    assert.strictEqual((await chooseStart({ item: ITEM, choice: { kind: 'file', inFolder: '/Invoices' } }, w.deps)).inFolder, '/Invoices');
    await assert.rejects(chooseStart({ item: { ...ITEM, nextRunAt: null }, choice: { kind: 'schedule' } }, w.deps), (/** @type {any} */ e) => e.status === 409);
    await assert.rejects(chooseStart({ item: { ...ITEM, agentId: null }, choice: { kind: 'webhook' } }, w.deps), (/** @type {any} */ e) => e.status === 409 && /agent or a plan/.test(e.message));
    assert.deepStrictEqual(w.synced, ['row', 'file'], 'the subscription follows every start that was saved');
    assert.deepStrictEqual((await startOf({ ...ITEM, triggerKind: 'file', trigger: { inFolder: '/A' } }, w.deps)).inFolder, '/A');
});

test('on a desk: an item of another owner on the same desk may be followed; following itself is refused on save', async () => {
    const items = {
        w1: ITEM,
        theirs: { id: 'theirs', userId: 'u2', title: 'Invoice intake', triggerKind: 'schedule' },
        elsewhere: { id: 'elsewhere', userId: 'u3', title: 'Not on the desk', triggerKind: 'schedule' },
    };
    const w = world(items);
    const deps = { ...w.deps, sameDesk: async (/** @type {string} */ a, /** @type {string} */ b) => a === 'w1' && b === 'theirs' };
    const state = await chooseStart({ item: ITEM, choice: { kind: 'after_cowork', scheduleId: 'theirs' } }, deps);
    assert.deepStrictEqual(state.after, { id: 'theirs', title: 'Invoice intake' });
    await assert.rejects(chooseStart({ item: ITEM, choice: { kind: 'after_cowork', scheduleId: 'elsewhere' } }, deps), (/** @type {any} */ e) => e.status === 404);
    await assert.rejects(chooseStart({ item: ITEM, choice: { kind: 'after_cowork', scheduleId: 'w1' } }, deps), (/** @type {any} */ e) => e.status === 409 && /itself/.test(e.message));
    assert.deepStrictEqual(w.set, [['w1', 'after_cowork', { scheduleId: 'theirs' }]], 'only the desk item was saved');
    const left = await startOf({ ...ITEM, triggerKind: 'after_cowork', trigger: { scheduleId: 'theirs' } }, { ...w.deps, sameDesk: async () => false });
    assert.strictEqual(left.after, null, 'once off the desk, the other owner\'s title is not shown');
});
