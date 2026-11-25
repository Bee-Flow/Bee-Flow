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

test('a plan entry says how its try-out of exactly this plan went and whether Cowork can fix its wiring', async () => {
    const tried = (status, current) => ({ status, current, required: true, blocksApproval: status !== 'passed', summary: null, problems: [], rounds: 1 });
    const states = {
        a: state({ tried: tried('passed', true), wiringFixable: false }),
        b: state({ tried: tried('passed', false) }),
        c: state({ draft: { findings: [{ message: 'A step reads a step that runs after it.' }], fingerprint: 'f' }, tried: null, wiringFixable: true }),
    };
    const list = await needsYou('u1', {
        getSchedules: async () => [
            { id: 'a', userId: 'u1', title: 'Tested', planAutomationId: 'auto-1' },
            { id: 'b', userId: 'u1', title: 'Tried an older version', planAutomationId: 'auto-2' },
            { id: 'c', userId: 'u1', title: 'Wrong order', planAutomationId: 'auto-3' },
        ],
        listRunsWaitingForOwner: async () => [],
        planStateOf: async (item) => states[item.id],
    });
    assert.deepStrictEqual(list.map((n) => [n.itemId, n.plan, n.tried, n.fixable]), [
        ['a', 'first', 'passed', false],
        ['b', 'first', null, false],
        ['c', 'blocked', null, true],
    ]);
});

const NOW = new Date('2026-11-24T12:00:00.000Z');
const setup = (over = {}) => ({ steps: 'wanted', cause: null, since: NOW.toISOString(), sendsTo: null, askFirst: null, canUndo: false, ...over });

test('a set-up that failed or was left is an entry that says why, as a class; one on the go, one with steps to check and one the AI does are not', async () => {
    const list = await needsYou('u1', {
        now: () => NOW,
        getSchedules: async () => [
            { id: 'a', userId: 'u1', title: 'Could not be set up', setup: setup({ steps: 'failed', cause: 'no_model' }) },
            { id: 'b', userId: 'u1', title: 'Left half-way', setup: setup({ since: '2026-11-24T11:00:00.000Z' }) },
            { id: 'c', userId: 'u1', title: 'Being set up now', setup: setup() },
            { id: 'd', userId: 'u1', title: 'Has steps to check', planAutomationId: 'auto-1', setup: setup({ since: '2026-11-24T11:00:00.000Z' }) },
            { id: 'e', userId: 'u1', title: 'The AI does it', setup: setup({ steps: 'ai' }) },
        ],
        listRunsWaitingForOwner: async () => [],
        planStateOf: async () => state(),
    });
    assert.deepStrictEqual(list.map((n) => [n.kind, n.itemId, n.cause ?? null, n.plan]), [
        ['setup', 'a', 'no_model', null],
        ['setup', 'b', 'left', null],
        ['plan', 'd', null, 'first'],
    ]);
});

test('every item whose last run failed has an entry, in words: the step, the cause, the app; never the error', async () => {
    const error = 'You no longer have permission to use "fireflies_list_transcripts". Ask your organisation admin to re-enable this integration, or remove the step from the automation.';
    const list = await needsYou('u1', {
        getSchedules: async () => [
            { id: 'a', userId: 'u1', title: 'Friday project digest', lastStatus: 'error', planAutomationId: 'auto-1', planId: 'plan-1' },
            { id: 'b', userId: 'u1', title: 'Failed without a run to read', lastStatus: 'error' },
            { id: 'c', userId: 'u1', title: 'Went well', lastStatus: 'success' },
        ],
        listRunsWaitingForOwner: async () => [],
        planStateOf: async () => state({ approved, upToDate: true, widens: [] }),
        lastRunFailures: async () => [{ itemId: 'a', id: 'r9', status: 'error', error, planId: 'plan-1', outcome: null, since: '2026-11-24T17:56:00.000Z' }],
        wordsOfRun: async (scheduleId, run) => ({ cause: 'permission', step: 'List last week\'s meetings', source: null, app: 'Fireflies', reason: `${scheduleId}:${run.id}` }),
    });
    assert.deepStrictEqual(list.map((n) => [n.kind, n.itemId, n.runId, n.hasSteps]), [['failed', 'a', 'r9', true], ['failed', 'b', null, false]]);
    assert.deepStrictEqual(list[0].failure, { cause: 'permission', step: 'List last week\'s meetings', source: null, app: 'Fireflies' });
    assert.deepStrictEqual(list[1].failure, { cause: 'other', step: null, source: null, app: null }, 'it failed, and that is all that can be said');
    assert.ok(!JSON.stringify(list).includes('fireflies_list_transcripts') && !JSON.stringify(list).includes('automation'), 'no tool name, no engine words');
});

test('a failed last run adds no second entry beside one that already says what is wrong', async () => {
    const failures = [];
    const list = await needsYou('u1', {
        getSchedules: async () => [
            { id: 'a', userId: 'u1', title: 'Steps cannot run', lastStatus: 'error', planAutomationId: 'auto-1' },
            { id: 'b', userId: 'u1', title: 'Found nothing', lastStatus: 'incomplete' },
            { id: 'c', userId: 'u1', title: 'Waits for approval, and its last run failed', lastStatus: 'error', planAutomationId: 'auto-2' },
        ],
        listRunsWaitingForOwner: async () => [],
        planStateOf: async (item) => (item.id === 'a' ? state({ draft: { findings: [{ message: 'No.' }], fingerprint: 'f' } }) : state()),
        lastRunProblems: async () => [{ itemId: 'b', runId: 'r1', kind: 'incomplete', since: null }],
        lastRunFailures: async () => { failures.push(1); return []; },
    });
    assert.deepStrictEqual(list.map((n) => [n.kind, n.itemId]).sort(), [['failed', 'c'], ['incomplete', 'b'], ['plan', 'a'], ['plan', 'c']]);
    assert.strictEqual(failures.length, 1);
});

test('a task that waits for its steps says so with its own card; a start it refused meanwhile is no second entry', async () => {
    const list = await needsYou('u1', {
        getSchedules: async () => [{ id: 'a', userId: 'u1', title: 'Waits for approval', lastStatus: 'error', planAutomationId: 'auto-1', setup: setup() }],
        listRunsWaitingForOwner: async () => [],
        planStateOf: async () => state(),
        lastRunFailures: async () => [{ itemId: 'a', id: 'r1', status: 'error', error: 'This task waits for its owner: its steps are not approved yet.', planId: null, outcome: null, since: null }],
    });
    assert.deepStrictEqual(list.map((n) => [n.kind, n.itemId]), [['plan', 'a']]);
});
