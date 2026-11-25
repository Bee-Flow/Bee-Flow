/**
 * When a repair is worked out (./repairTriggers.mts): the same step of the approved plan failed in the last two runs,
 * or the goal stayed under target three measurements in a row; and when it is not: an open repair, a read-only
 * organisation, a budget used up, a second attempt the same day. What the propose call is handed is the facts only.
 * The stores are handed in (stores/coworkProposals.pg.test.js has the SQL).
 *
 * Run: cd server && node --test core/cowork/repairs/repairTriggers.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');

const { checkAfterRun, start, stop } = require('./repairTriggers.mts');
const { runEnded } = require('../runEnded.mts');
const { OPEN_POLICY } = require('../../entitlements/coworkPolicy.mts');
const { fakeLookups, planOf, literal } = require('../plan/plan.testkit');

after(stop);

const PLAN = planOf([
    { id: 'orders', type: 'integration_action', label: 'Read the order table', tool: 'drive_search', inputs: { query: literal('orders') } },
    { id: 'tell', type: 'notification', label: 'Tell me', title: 'Orders', body: 'x', channels: ['notification'] },
]);
const ITEM = { id: 'cw-1', userId: 'u1', title: 'Order radar', planId: 'p-1', planAutomationId: 'auto-1', isActive: true };
const failing = (runId, planId = 'p-1', stepId = 'orders') => ({ runId, planId, failed: [{ stepId, errorClass: 'IntegrationError' }] });
const result = (met, total = 10) => ({ runId: `g-${met}`, met, total, period: null, ok: true, error: null, measuredAt: null });

function world({ runs = [failing('run-2'), failing('run-1')], results = [], policy = OPEN_POLICY, budget = true, open = null, claims = true } = {}) {
    const seen = { proposed: [], claims: 0 };
    const deps = {
        getSchedule: async (id) => (id === ITEM.id ? ITEM : null),
        getApprovedPlan: async () => ({ id: 'p-1', definition: PLAN }),
        proposals: {
            lastRunFailures: async () => runs,
            openProposalOf: async () => open,
            claimAttempt: async () => { seen.claims += 1; return claims; },
        },
        goals: { getGoal: async () => (results.length ? { approvedDefinition: {}, targetPercent: 95 } : null), listResults: async () => results },
        policyOf: async () => policy,
        spendLeft: async () => { if (!budget) throw Object.assign(new Error('used'), { code: 'cowork_budget_used' }); },
        lookups: fakeLookups(),
        now: () => new Date('2026-11-24T08:00:00Z'),
    };
    const propose = async (item, trigger) => { seen.proposed.push([item.id, trigger]); };
    return { deps, seen, propose };
}

test('the same step failed in the last two runs of the approved plan: a repair with its id, title and error class', async () => {
    const { deps, seen, propose } = world();
    assert.strictEqual(await checkAfterRun(ITEM, 'run-2', propose, deps), 'proposed');
    assert.deepStrictEqual(seen.proposed, [['cw-1', { reasonCode: 'step_failed_twice', runId: 'run-2', stepId: 'orders', stepTitle: 'Read the order table', errorClass: 'IntegrationError', runs: 2 }]]);
});

test('no repair: one failure, two different steps, a run of another plan, a step the plan does not have', async () => {
    for (const runs of [[failing('run-2'), { runId: 'run-1', planId: 'p-1', failed: [] }], [failing('run-2'), failing('run-1', 'p-1', 'tell')], [failing('run-2'), failing('run-1', 'p-0')], [failing('run-2', 'p-1', 'ghost'), failing('run-1', 'p-1', 'ghost')], [failing('run-2')]]) {
        const { deps, seen, propose } = world({ runs });
        assert.strictEqual(await checkAfterRun(ITEM, 'run-2', propose, deps), 'no_trigger', JSON.stringify(runs));
        assert.deepStrictEqual([seen.proposed, seen.claims], [[], 0]);
    }
});

test('the goal under its target in each of the last three measurements: a repair with the numbers', async () => {
    const { deps, seen, propose } = world({ runs: [], results: [result(7), result(8), result(6)] });
    assert.strictEqual(await checkAfterRun(ITEM, 'run-3', propose, deps), 'proposed');
    assert.deepStrictEqual(seen.proposed[0][1], { reasonCode: 'goal_under_target', runId: 'run-3', targetPercent: 95, percents: [60, 80, 70] });
    const once = world({ runs: [], results: [result(7), result(10), result(6)] });
    assert.strictEqual(await checkAfterRun(ITEM, 'run-3', once.propose, once.deps), 'no_trigger', 'once at target breaks the row');
    const two = world({ runs: [], results: [result(7), result(8)] });
    assert.strictEqual(await checkAfterRun(ITEM, 'run-3', two.propose, two.deps), 'no_trigger');
});

test('the limits: an open repair, read-only, a budget used up, already tried today; none uses up the day but the last', async () => {
    const cases = [
        [{ open: { id: 'pr-1' } }, 'open', 0],
        [{ policy: { ...OPEN_POLICY, readOnly: true } }, 'read_only', 0],
        [{ policy: { ...OPEN_POLICY, unreadable: true } }, 'read_only', 0],
        [{ budget: false }, 'budget', 0],
        [{ claims: false }, 'tried_today', 1],
    ];
    for (const [over, outcome, claims] of cases) {
        const { deps, seen, propose } = world(over);
        assert.strictEqual(await checkAfterRun(ITEM, 'run-2', propose, deps), outcome);
        assert.deepStrictEqual([seen.proposed.length, seen.claims], [0, claims], outcome);
    }
    const noPlan = world();
    assert.strictEqual(await checkAfterRun({ ...ITEM, id: 'cw-9' }, 'run-2', noPlan.propose, noPlan.deps), 'no_plan');
});

test('started from boot, it hears the end of a run', async () => {
    const { deps, seen, propose } = world();
    assert.strictEqual(start(propose, deps), true);
    assert.strictEqual(start(propose, deps), false, 'a second start does nothing');
    runEnded(ITEM, 'run-2');
    for (let i = 0; i < 50 && seen.proposed.length === 0; i++) await new Promise((r) => { setTimeout(r, 10); });
    assert.strictEqual(seen.proposed.length, 1);
    stop();
});
