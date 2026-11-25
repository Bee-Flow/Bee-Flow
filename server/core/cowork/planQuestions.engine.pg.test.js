/**
 * The questions of a paused plan run, after the pause, on the REAL automation engine and the real stores (PGlite
 * behind db.js):
 *
 *   - who decides is asked again at the decision: a colleague the owner took off the item no longer decides its
 *     questions, though the approval row still names them (./planQuestionDecider.mts, through the runner port
 *     `approvalDeciders` that automation/approvalService.js asks);
 *
 * The owners here have no user row while their runs start: a row with an organisation would make the engine ask the
 * organisation's licence for automations, which this server does not have. So the rows (the organisation, the
 * colleague) are written once the run waits, and the approval row is given the colleague as its assignee the way a
 * run that started while they decided writes it (./plan/planIndependence.mts; planRun.test.js proves that part).
 *   - the organisation's Cowork policy is applied again when the run continues: an administrator who made Cowork
 *     read-only while the run waited stops it, and the Cowork run closes as failed with that reason
 *     (./planHeldDefinition.mts).
 *
 * Run: cd server && node --test core/cowork/planQuestions.engine.pg.test.js
 */

'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert');

const engine = require('./coworkEngine.testkit');

const { pg, store } = engine.coworkOnEngine();

const automationStore = require('../../stores/automationStore');
const { decide, canDecide, featureLetsDecide } = require('../../automation/approvalService');
const { coworkShares } = require('../../stores/coworkShares.mts');
const { setCoworkPolicy } = require('../entitlements/coworkPolicy.mts');
const { setPauseDepsForTests } = require('../automationRunner/dryPause.mts');
const followUp = require('./planRunFollowUp.mts');

const OWNER = 'u-q-owner';
const COLLEAGUE = 'u-q-colleague';
const ORG = 'org-q';
const RO_OWNER = 'u-q-readonly';
const RO_ORG = 'org-q-readonly';

const literal = (value) => ({ kind: 'literal', value });

/** trigger → collect → mail the supplier → tell the owner: a run that asks before sending stops before the mail. */
function definition() {
    const steps = [
        { id: 'facts', type: 'set', label: 'Collect the figures', fields: { what: literal('three orders') } },
        { id: 'send', type: 'integration_action', label: 'Mail the supplier', tool: 'outlook_compose', inputs: { to: literal('orders@supplier.example'), subject: literal('Overdue'), body: literal('Three orders are overdue.') } },
        { id: 'tell', type: 'notification', label: 'Send me the digest', title: 'Supplier radar', body: 'Done', channels: ['notification'] },
    ];
    const ids = ['trg', ...steps.map((s) => s.id)];
    return { schemaVersion: 1, trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} }, steps, edges: ids.slice(1).map((to, i) => ({ from: ids[i], to })), vars: {} };
}

/** Owner and colleagues as active members of one organisation. @param {string} org @param {string[]} ids */
const members = (org, ids) => Promise.all(ids.map((id) => pg.query(
    `INSERT INTO users (id, username, "organizationId", status) VALUES ($1, $1, $2, 'active') ON CONFLICT (id) DO NOTHING`, [id, org],
)));

before(async () => {
    await store.initDB();
    await require('../../stores/userStore').getUser(OWNER); // the user store's schema
    // Approvals are an Enterprise capability (core/automationRunner/dryPause.mts): this server is licensed for them.
    setPauseDepsForTests({ hasCapability: async (/** @type {string} */ capId) => capId === 'approvals' });
    followUp.start();
});

require('node:test').after(() => {
    followUp.stop();
    setPauseDepsForTests(null);
});

/** An item of `owner` whose run asks before the mail, run until it waits; its question, its run and the item. */
const waitingQuestion = (/** @type {string} */ owner) => engine.waitingQuestion(store, { owner, title: 'Supplier radar', definition: definition() });

/** The item's latest Cowork run once it no longer waits. */
async function closedRun(itemId) {
    let latest = (await store.listRuns(itemId))[0];
    for (let i = 0; i < 100 && latest.status === 'waiting'; i++) {
        await new Promise((resolve) => { setTimeout(resolve, 50); });
        latest = (await store.listRuns(itemId))[0];
    }
    return latest;
}

/** The question of a run that started while `colleague` decided the item's questions. */
async function askedOf(owner, colleague) {
    const asked = await waitingQuestion(owner);
    await members(ORG, [owner, colleague]);
    await coworkShares().setShares(asked.itemId, [{ userId: colleague, role: 'approver' }], owner);
    await pg.query('UPDATE automation_approvals SET assignee_user_id = $2 WHERE id = $1', [asked.approval.id, colleague]);
    return { ...asked, approval: await automationStore.getApproval(asked.approval.id) };
}

test('a colleague the owner took off the item no longer decides its questions; the owner still does', async () => {
    const { itemId, approval, run } = await askedOf(OWNER, COLLEAGUE);
    assert.strictEqual(approval.assigneeUserId, COLLEAGUE, 'the question was put to the colleague');

    await coworkShares().setShares(itemId, [], OWNER);
    assert.ok(canDecide(approval, { userId: COLLEAGUE, groupIds: [] }), 'the row alone still names them');
    assert.strictEqual(await featureLetsDecide(approval, COLLEAGUE), false, 'and no screen offers them a decide button');
    assert.strictEqual(await featureLetsDecide(approval, OWNER), true);
    const refused = await decide({ approval, run, deciderId: COLLEAGUE, decision: 'reject', reason: 'No.', source: 'studio' });
    assert.deepStrictEqual([refused.code, refused.body.error], [403, 'You cannot decide this approval.'], JSON.stringify(refused).slice(0, 300));
    assert.strictEqual((await automationStore.getApproval(approval.id))?.status, 'pending', 'nothing was decided');

    const decided = await decide({ approval, run, deciderId: OWNER, decision: 'reject', reason: 'Not this week.', source: 'studio' });
    assert.strictEqual(decided.code, 200, JSON.stringify(decided).slice(0, 300));
    assert.strictEqual((await closedRun(itemId)).status, 'error', 'the owner\'s rejection ended the run');
});

test('the colleague who decides now may decide a question that waits', async () => {
    const { itemId, approval, run } = await askedOf('u-q-owner-2', 'u-q-colleague-2');
    const decided = await decide({ approval, run, deciderId: 'u-q-colleague-2', decision: 'reject', reason: 'Not now.', source: 'studio' });
    assert.strictEqual(decided.code, 200, JSON.stringify(decided).slice(0, 300));
    assert.strictEqual((await closedRun(itemId)).status, 'error');
});

test('Cowork made read-only while a run waited: the approval does not let it continue, and the run closes as failed with the reason', async () => {
    const { itemId, approval, run } = await waitingQuestion(RO_OWNER);
    await members(RO_ORG, [RO_OWNER]);
    await setCoworkPolicy(RO_ORG, { readOnly: true });
    await decide({ approval, run, deciderId: RO_OWNER, decision: 'approve', source: 'studio' });
    const closed = await closedRun(itemId);
    assert.strictEqual(closed.status, 'error', 'the continuation was refused');
    assert.match(closed.error || '', /made Cowork read-only/);
    const steps = await automationStore.getRunSteps(run.id);
    assert.ok(!steps.some((s) => s.stepId === 'send' && s.status === 'success'), 'the mail did not go');
});
