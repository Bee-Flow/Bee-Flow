/**
 * "Needs you" (./coworkNeedsYou.mts): one list of what waits for the owner, most urgent first. The store reads and
 * the plan state are handed in, so nothing is mocked.
 *
 * Run: cd server && node --test usecases/coworkNeedsYou.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { needsYou, planNeedOf } = require('./coworkNeedsYou.mts');

const state = (over = {}) => ({ automationId: 'auto-1', draft: { findings: [], fingerprint: 'f' }, approved: null, widens: ['This plan has not been approved yet.'], upToDate: false, ...over });
const approved = { version: 1, fingerprint: 'f', approvedAt: null, permissions: {} };

test('where a plan needs its owner: never approved, changed to do more, cannot run, gone; an approved or harmless change needs nobody', () => {
    assert.strictEqual(planNeedOf(state()), 'first');
    assert.strictEqual(planNeedOf(state({ approved, widens: ['It can now send to other people.'] })), 'changed');
    assert.strictEqual(planNeedOf(state({ approved, widens: [] })), null, 'a change that does not do more waits for nobody');
    assert.strictEqual(planNeedOf(state({ approved, upToDate: true, widens: [] })), null);
    assert.strictEqual(planNeedOf(state({ draft: { findings: [{ message: 'No.' }] } })), 'blocked');
    assert.strictEqual(planNeedOf(state({ approved, draft: { findings: [{ message: 'No.' }] } })), null, 'the approved version still runs');
    assert.strictEqual(planNeedOf(state({ draft: null })), 'gone');
    assert.strictEqual(planNeedOf(state({ automationId: null, draft: null })), null);
});

test('one list: decisions, then reviews, then sign-ins, then plans; titles and reasons only', async () => {
    const asked = [];
    const list = await needsYou('u1', {
        getSchedules: async (userId) => { asked.push(userId); return [
            { id: 'a', userId: 'u1', title: 'Open quotes', lastStatus: 'needs_reauth', isActive: false },
            { id: 'b', userId: 'u1', title: 'Supplier radar', lastStatus: 'success', planAutomationId: 'auto-1' },
            { id: 'c', userId: 'u1', title: 'Quiet one', lastStatus: 'success' },
        ]; },
        listRunsWaitingForOwner: async () => [
            { runId: 'r1', itemId: 'd', title: 'Invoice intake', status: 'needs_review', since: '2026-11-23T08:00:00.000Z', reason: 'Two invoices look the same.' },
            { runId: 'r2', itemId: 'b', title: 'Supplier radar', status: 'waiting', since: '2026-11-23T07:31:00.000Z', reason: null },
        ],
        planStateOf: async () => state({ approved, widens: ['It can now send to other people.'] }),
    });
    assert.deepStrictEqual(asked, ['u1']);
    assert.deepStrictEqual(list.map((n) => [n.kind, n.itemId, n.plan]), [['decision', 'b', null], ['review', 'd', null], ['sign_in', 'a', null], ['plan', 'b', 'changed']]);
    assert.strictEqual(list[1].reason, 'Two invoices look the same.');
    assert.strictEqual(list[3].reason, 'It can now send to other people.');
});

test('a plan that cannot be read costs its own entry, never the list', async () => {
    const list = await needsYou('u1', {
        getSchedules: async () => [{ id: 'b', userId: 'u1', title: 'Supplier radar', planAutomationId: 'auto-1' }],
        listRunsWaitingForOwner: async () => [],
        planStateOf: async () => { throw new Error('automation store down'); },
    });
    assert.deepStrictEqual(list, []);
});
