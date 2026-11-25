// @typecheck
/**
 * The questions of a cowork on a desk, on the REAL automation engine and the real stores (PGlite behind db.js): its
 * owner chose the desk role "invoices" for them.
 *
 *   - while the holder is away the question goes to the stand-in; otherwise to the holder, and it moves to the
 *     stand-in after one working day (./deskQuestions.mts, read from the real desk store);
 *   - the stand-in cannot decide before the question moved, and can after the engine's escalation sweep;
 *   - a former holder cannot decide it, though the approval row still names them (./planQuestionDecider.mts through
 *     the runner port that automation/approvalService.js asks).
 *
 * The owner has no user row while the run starts: a row with an organisation would make the engine ask the
 * organisation's licence for automations, which this server does not have (planQuestions.engine.pg.test.js has the
 * same limit). So the approval row is given the route the way a run that started with the people in place writes it
 * (./plan/planIndependence.mts puts the route on the question, deskQuestions.test.js proves that part, and
 * core/automationRunner/approvalRouting.mts turns it into the row's columns).
 *
 * Run: cd server && node --test core/cowork/deskQuestions.engine.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const engine = require('./coworkEngine.testkit');

const { pg, store } = engine.coworkOnEngine();

const automationStore = require('../../stores/automationStore');
const { decide, canDecide } = require('../../automation/approvalService');
const { coworkDesks, initDB: initDesks } = require('../../stores/coworkDesks.mts');
const { setPauseDepsForTests } = require('../automationRunner/dryPause.mts');
const { questionRouteOf } = require('./deskQuestions.mts');
const followUp = require('./planRunFollowUp.mts');

const ORG = 'org-desk-q';
const OWNER = 'dq-owner';
const PEOPLE = ['dq-holder', 'dq-stand-in', 'dq-new-holder'];
const literal = (/** @type {unknown} */ value) => ({ kind: 'literal', value });

/** collect → mail the supplier: a run that asks before sending stops before the mail. */
function definition() {
    const steps = [
        { id: 'facts', type: 'set', label: 'Collect the figures', fields: { what: literal('three invoices') } },
        { id: 'send', type: 'integration_action', label: 'Mail the supplier', tool: 'outlook_compose', inputs: { to: literal('orders@supplier.example'), subject: literal('Invoices'), body: literal('Three invoices are paid.') } },
    ];
    const ids = ['trg', ...steps.map((s) => s.id)];
    return { schemaVersion: 1, trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} }, steps, edges: ids.slice(1).map((to, i) => ({ from: ids[i], to })), vars: {} };
}

before(async () => {
    await store.initDB();
    await require('../../stores/userStore').getUser(OWNER); // the user store's schema
    await initDesks();
    for (const id of PEOPLE) await pg.query(`INSERT INTO users (id, username, "organizationId", status) VALUES ($1, $1, $2, 'active') ON CONFLICT (id) DO NOTHING`, [id, ORG]);
    setPauseDepsForTests({ hasCapability: async (/** @type {string} */ capId) => capId === 'approvals' });
    followUp.start();
});

after(() => {
    followUp.stop();
    setPauseDepsForTests(null);
});

/** The owner's cowork on a desk whose role "invoices" decides its questions; its run waits at the question. */
async function waitingOnDesk() {
    const { itemId, approval, run } = await engine.waitingQuestion(store, { owner: OWNER, title: 'Payment check', definition: definition() });
    // Now the people are there: the owner joins the organisation, and the cowork the desk.
    await pg.query(`INSERT INTO users (id, username, "organizationId", status) VALUES ($1, $1, $2, 'active') ON CONFLICT (id) DO NOTHING`, [OWNER, ORG]);
    const desk = await coworkDesks().createDesk({ organizationId: ORG, ownerId: OWNER, name: 'Invoices' });
    await coworkDesks().addMember({ deskId: desk.id, scheduleId: itemId, addedBy: OWNER, accepted: true });
    await coworkDesks().setDeskRole(desk.id, itemId, 'invoices');
    return { itemId, deskId: desk.id, approval, run };
}

/** The approval row as the engine writes it for this route (approvalRouting.mts configuredSeatColumns). */
async function routed(/** @type {string} */ approvalId, /** @type {any} */ route) {
    await pg.query(
        `UPDATE automation_approvals SET assignee_user_id = $2, escalate_to_user_id = $3, escalate_at = NOW() + make_interval(hours => $4::int) WHERE id = $1`,
        [approvalId, route.userId, route.escalateTo ?? null, route.escalateAfterHours ?? 0],
    );
    return /** @type {any} */ (await automationStore.getApproval(approvalId));
}

test('a question for a role: to the stand-in while the holder is away; else to the holder, moving to the stand-in after a working day; a former holder cannot decide it', async () => {
    const { itemId, deskId, approval, run } = await waitingOnDesk();
    const roles = (/** @type {string} */ holderId, /** @type {string | null} */ awayUntil) => coworkDesks().setRoles(deskId, [{ role: 'invoices', holderId, standInId: 'dq-stand-in', awayUntil }]);

    await roles('dq-holder', new Date(Date.now() + 3 * 86_400_000).toISOString());
    const away = /** @type {any} */ (await questionRouteOf(itemId));
    assert.deepStrictEqual([away.userId, away.escalateTo ?? null], ['dq-stand-in', null], 'the holder is away: the stand-in is asked');
    assert.match(away.note, /is away until .*went to their stand-in/);

    await roles('dq-holder', null);
    const route = /** @type {any} */ (await questionRouteOf(itemId));
    assert.deepStrictEqual([route.userId, route.escalateTo], ['dq-holder', 'dq-stand-in']);
    assert.ok(route.escalateAfterHours >= 24, 'it moves on after one working day');

    let row = await routed(approval.id, route);
    assert.strictEqual(canDecide(row, { userId: 'dq-stand-in', groupIds: [] }), false, 'before it moved, the stand-in is not asked');
    await pg.query(`UPDATE automation_approvals SET escalate_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [approval.id]);
    await automationStore.markDueApprovalEscalations();
    row = await automationStore.getApproval(approval.id);
    assert.ok(row.escalatedAt, 'the engine moved the question on');
    assert.strictEqual(canDecide(row, { userId: 'dq-stand-in', groupIds: [] }), true, 'now the stand-in may decide');

    await roles('dq-new-holder', null);
    const refused = await decide({ approval: row, run, deciderId: 'dq-holder', decision: 'approve', source: 'studio' });
    assert.deepStrictEqual([refused.code, refused.body.error], [403, 'You cannot decide this approval.'], 'the former holder is refused, though the row names them');
    assert.strictEqual((await automationStore.getApproval(approval.id))?.status, 'pending');

    const decided = await decide({ approval: row, run, deciderId: 'dq-stand-in', decision: 'reject', reason: 'Not this week.', source: 'studio' });
    assert.strictEqual(decided.code, 200, JSON.stringify(decided).slice(0, 300));
});
