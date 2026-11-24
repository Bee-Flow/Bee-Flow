/**
 * Cheaper with age (./stableSteps.mts): which AI steps are steady (no tools, at least ten good runs of the approved
 * plan), and the weekly look per item, which respects the read-only switch, the budgets, an open offer and the week.
 * The stores are handed in (stores/coworkProposals.pg.test.js has the SQL).
 *
 * Run: cd server && node --test core/cowork/cheaper/stableSteps.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');

const { stableAiSteps, lookAtItem, weeklyPass, start, stop, MIN_RUNS } = require('./stableSteps.mts');
const { OPEN_POLICY } = require('../../entitlements/coworkPolicy.mts');
const { fakeLookups, planOf, literal } = require('../plan/plan.testkit');

after(stop);

const lookups = fakeLookups();
const PLAN = planOf([
    { id: 'orders', type: 'integration_action', label: 'Read the order table', tool: 'drive_search', inputs: { query: literal('orders') } },
    { id: 'sum', type: 'ai_step', label: 'Count the late orders', prompt: 'How many are late?' },
    { id: 'look', type: 'ai_step', label: 'Look it up', prompt: 'Search.', tools: ['drive_search'] },
    { id: 'kb', type: 'ai_step', label: 'Ask the handbook', prompt: 'What does it say?', knowledgeBaseIds: ['kb-1'] },
    { id: 'tone', type: 'ai_step', label: 'Write it kindly', prompt: 'Rewrite.' },
]);
const COUNTS = { orders: 30, sum: 12, look: 30, kb: 30, tone: MIN_RUNS - 1 };
const ITEM = { id: 'cw-1', userId: 'u1', planId: 'p-1', isActive: true };

test('a steady step is an AI step without tools that ended well in at least ten runs of the approved plan', () => {
    assert.deepStrictEqual(stableAiSteps(PLAN, COUNTS, lookups), [{ stepId: 'sum', stepTitle: 'Count the late orders', runs: 12 }]);
    assert.deepStrictEqual(stableAiSteps(PLAN, { ...COUNTS, tone: 40 }, lookups).map((s) => s.stepId), ['tone', 'sum'], 'the most runs first');
});

function world({ policy = OPEN_POLICY, budget = true, open = null, claims = true, item = ITEM } = {}) {
    const seen = { offered: [], claims: 0 };
    const deps = {
        proposals: {
            itemsWithApprovedPlan: async (_limit, after) => (after ? [] : ['cw-1', 'cw-gone']),
            stepSuccessCounts: async () => COUNTS,
            openProposalOf: async () => open,
            claimAttempt: async () => { seen.claims += 1; return claims; },
            lastRunFailures: async () => [{ runId: 'run-12', planId: 'p-1', failed: [] }],
        },
        getSchedule: async (id) => (id === 'cw-1' ? item : null),
        getApprovedPlan: async () => ({ id: 'p-1', definition: PLAN }),
        policyOf: async () => policy,
        spendLeft: async () => { if (!budget) throw new Error('used'); },
        lookups,
        now: () => new Date('2026-11-24T08:00:00Z'),
    };
    const offer = async (it, step) => { seen.offered.push([it.id, step]); };
    return { deps, seen, offer };
}

test('the weekly look offers the steady step, booked on the latest run', async () => {
    const { deps, seen, offer } = world();
    assert.strictEqual(await weeklyPass(offer, deps), 1);
    assert.deepStrictEqual(seen.offered, [['cw-1', { stepId: 'sum', stepTitle: 'Count the late orders', runs: 12, bookOn: 'run-12' }]]);
});

test('it respects the read-only switch, the budgets, an open offer and the week', async () => {
    const cases = [
        [{ policy: { ...OPEN_POLICY, readOnly: true } }, 'read_only', 0],
        [{ budget: false }, 'budget', 0],
        [{ open: { id: 'pr-1' } }, 'open', 0],
        [{ claims: false }, 'tried_this_week', 1],
        [{ item: { ...ITEM, isActive: false } }, 'no_plan', 0],
        [{ item: { ...ITEM, planId: null } }, 'no_plan', 0],
    ];
    for (const [over, outcome, claims] of cases) {
        const { deps, seen, offer } = world(over);
        assert.strictEqual(await lookAtItem('cw-1', offer, deps), outcome);
        assert.deepStrictEqual([seen.offered.length, seen.claims], [0, claims], outcome);
    }
});

test('started from boot once', () => {
    const { deps, offer } = world();
    assert.strictEqual(start(offer, deps), true);
    assert.strictEqual(start(offer, deps), false);
    stop();
});
