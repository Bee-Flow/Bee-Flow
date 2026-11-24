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

test('a repair that is ready is one entry, after sign-ins and before plans; only while it fits the approved plan', async () => {
    const asked = [];
    const repair = { proposalId: 'pr-1', reasonCode: 'step_failed_twice', stepTitle: 'Read the order table' };
    const list = await needsYou('u1', {
        getSchedules: async () => [
            { id: 'b', userId: 'u1', title: 'Order radar', planAutomationId: 'auto-1' },
            { id: 'c', userId: 'u1', title: 'Not approved yet', planAutomationId: 'auto-2' },
        ],
        listRunsWaitingForOwner: async () => [],
        planStateOf: async (item) => (item.id === 'b' ? state({ approved, upToDate: true, widens: [] }) : state()),
        openRepairOf: async (item, fingerprint) => { asked.push([item.id, fingerprint]); return repair; },
    });
    assert.deepStrictEqual(list.map((n) => [n.kind, n.itemId]), [['repair', 'b'], ['plan', 'c']]);
    assert.deepStrictEqual(list[0].repair, repair);
    assert.deepStrictEqual(asked, [['b', 'f']], 'an item without an approved plan has no repair to ask about');
});

test('an item whose last run did not do its work is an entry; a repair that is ready for it says so instead', async () => {
    const list = await needsYou('u1', {
        getSchedules: async () => [
            { id: 'a', userId: 'u1', title: 'Meeting overview' },
            { id: 'b', userId: 'u1', title: 'Order radar', planAutomationId: 'auto-1' },
            { id: 'c', userId: 'u1', title: 'Inbox digest' },
        ],
        listRunsWaitingForOwner: async () => [],
        planStateOf: async () => state({ approved, upToDate: true, widens: [] }),
        openRepairOf: async () => ({ proposalId: 'pr-1', reasonCode: 'reference_unresolved', stepTitle: 'Get summaries' }),
        lastRunProblems: async () => [
            { itemId: 'a', runId: 'r1', kind: 'incomplete', since: '2026-11-24T08:00:00.000Z' },
            { itemId: 'b', runId: 'r2', kind: 'incomplete', since: '2026-11-24T08:00:00.000Z' },
            { itemId: 'c', runId: 'r3', kind: 'ai_failed', since: '2026-11-24T07:00:00.000Z' },
            { itemId: 'someone-else', runId: 'r4', kind: 'incomplete', since: null },
        ],
    });
    assert.deepStrictEqual(list.map((n) => [n.kind, n.itemId, n.runId]), [['repair', 'b', null], ['incomplete', 'a', 'r1'], ['ai_failed', 'c', 'r3']]);
    assert.ok(list.every((n) => n.reason === null), 'no text a run produced');
});
