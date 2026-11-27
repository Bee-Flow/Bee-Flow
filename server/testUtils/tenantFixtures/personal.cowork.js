// @typecheck strict
/**
 * Tenant-isolation fixtures: a Cowork schedule of a person of org B (the cowork module).
 * What a fixture is and how the matrix drives it is in testUtils/tenantFixtures.js, which
 * finds this file in testUtils/tenantFixtures/ and puts its kinds in the matrix's order.
 */

'use strict';

const { present } = require('./helpers');

/** @type {import('../tenantFixtures').TenantFixture[]} */
const FIXTURES = [
    {
        // A Cowork schedule of user B (routes/cowork.js): the owner's alone.
        kind: 'coworkSchedule',
        mount: '/api/cowork',
        router: () => require('../../routes/cowork'),
        create: async ({ userId, index, outsiderId }) => {
            const schedule = await require('../../stores/coworkStore').createSchedule({
                userId, title: `Schedule ${index}`, prompt: 'Summarise the week.', repeatInterval: 'daily',
                nextRunAt: new Date(Date.now() + 86_400_000).toISOString(),
            });
            const id = present(schedule, 'createSchedule').id;
            // The use case would refuse this (the caller is not a colleague of the owner), so the row goes in by SQL: a
            // share that names an outsider must still give the outsider nothing (stores/coworkShares.mts LIVE_SHARES).
            if (outsiderId) await require('../../db').run(`INSERT INTO cowork_shares (schedule_id, user_id, role, added_by) VALUES ($1, $2, 'approver', $3)`, [id, outsiderId, userId]);
            return id;
        },
        routes: [
            'GET /api/cowork/:id', 'GET /api/cowork/:id/runs', 'GET /api/cowork/:id/stats', 'PUT /api/cowork/:id',
            'POST /api/cowork/:id/run-now', 'POST /api/cowork/:id/toggle', 'POST /api/cowork/:id/runs/:runId/review',
            'GET /api/cowork/:id/plan', 'PUT /api/cowork/:id/plan', 'POST /api/cowork/:id/plan/approve', 'DELETE /api/cowork/:id/plan',
            'POST /api/cowork/:id/plan/try', 'GET /api/cowork/:id/plan/try/:tryId', 'GET /api/cowork/:id/runs/:runId/trace',
            // Cowork fixing the wiring of a plan that is not approved: the owner's only (usecases/coworkPlanWiringRepair.mts).
            'POST /api/cowork/:id/plan/fix-wiring',
            'POST /api/cowork/:id/plan/make',
            'GET /api/cowork/:id/plan/independence', 'PUT /api/cowork/:id/plan/independence',
            'GET /api/cowork/:id/hand-over/colleagues', 'POST /api/cowork/:id/hand-over',
            'GET /api/cowork/:id/start', 'PUT /api/cowork/:id/start',
            'GET /api/cowork/:id/plan/trust', 'PUT /api/cowork/:id/plan/trust',
            'GET /api/cowork/:id/routine', 'GET /api/cowork/:id/plan/try/:tryId/compare',
            // Shared coworks: only the owner manages the shares, and only the owner and the people it is shared with
            // see it; a member of another organisation gets nothing (usecases/coworkShares.mts).
            'GET /api/cowork/:id/shares', 'PUT /api/cowork/:id/shares', 'GET /api/cowork/shared/:id',
            // Run receipts: the owner's only (usecases/coworkReceipts.mts).
            'GET /api/cowork/:id/receipts', 'GET /api/cowork/:id/runs/:runId/receipt',
            // What the task remembers from one run to the next, and clearing it: the owner's only (usecases/coworkMemory.mts).
            'GET /api/cowork/:id/memory', 'POST /api/cowork/:id/memory/clear', 'POST /api/cowork/:id/memory/restore',
            // Replaying a changed plan on the item's past runs: the owner's only (usecases/coworkReplay.mts).
            'POST /api/cowork/:id/plan/replay', 'GET /api/cowork/:id/plan/replay/:replayId',
            // Saving as a template: only the owner saves their item (usecases/coworkTemplates.mts).
            'POST /api/cowork/:id/save-as-template',
            'GET /api/cowork/:id/audit',
            // The goal and its check: the owner's only (usecases/coworkGoals.mts).
            'GET /api/cowork/:id/goal', 'PUT /api/cowork/:id/goal', 'POST /api/cowork/:id/goal/check',
            'POST /api/cowork/:id/goal/approve', 'DELETE /api/cowork/:id/goal',
            // The desk the cowork is on: its owner's only (usecases/coworkDesks.mts).
            'GET /api/cowork/:id/desk',
            // What Cowork proposes to change in a plan, and "Undo": the owner's only (usecases/coworkProposals.mts).
            'GET /api/cowork/:id/proposals', 'POST /api/cowork/:id/proposals', 'POST /api/cowork/:id/proposals/:proposalId/approve',
            'POST /api/cowork/:id/proposals/:proposalId/dismiss', 'POST /api/cowork/:id/plan/restore',
            // Letting the AI work it out every run, and its Undo: the owner's only (usecases/coworkSetup.mts).
            'PUT /api/cowork/:id/setup',
            'DELETE /api/cowork/:id',
        ],
        // The review and plan bodies are validated before the ownership check.
        bodies: {
            'POST /api/cowork/:id/runs/:runId/review': { action: 'not_needed' },
            'PUT /api/cowork/:id/plan': { automationId: 'an-automation-of-the-caller' },
            'POST /api/cowork/:id/plan/approve': { fingerprint: 'a'.repeat(64) },
            'PUT /api/cowork/:id/plan/independence': { level: 'asks_everything' },
            'POST /api/cowork/:id/hand-over': { toUserId: 'a-colleague' },
            'PUT /api/cowork/:id/start': { kind: 'webhook' },
            'PUT /api/cowork/:id/plan/trust': { stepId: 'send', recipient: '*', trusted: false },
            'PUT /api/cowork/:id/shares': { shares: [] },
            'PUT /api/cowork/:id/goal': { sentence: 'Every mail gets an answer within two working days', targetPercent: 95 },
            'POST /api/cowork/:id/goal/approve': { fingerprint: 'a'.repeat(64) },
            'POST /api/cowork/:id/proposals': { instruction: 'Shorten the summary' },
            'POST /api/cowork/:id/proposals/:proposalId/approve': { fingerprint: 'a'.repeat(64) },
            'POST /api/cowork/:id/plan/restore': { version: 1 },
            'POST /api/cowork/:id/memory/restore': { ids: ['a-memory-of-the-owner'] },
            'PUT /api/cowork/:id/setup': { mode: 'ai' },
        },
    },
];

module.exports = { FIXTURES };
