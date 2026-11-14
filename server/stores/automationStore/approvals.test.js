// @typecheck
/**
 * The approvals store's visibility rules — the scope WHERE and the row mapper,
 * which together decide WHO SEES WHAT — on a real Postgres (the boot ladder's
 * schema on PGlite, testUtils/pgliteTemplate.js ladderPglite, behind db.js's
 * pool): rows are seeded and listApprovals / getApprovalFacets say which ones
 * a viewer or an organisation gets back.
 *
 * Run: node --test stores/automationStore/approvals.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../../testUtils/pglitePool');
const { ladderPglite } = require('../../testUtils/pgliteTemplate');

const { pg, close } = usePglitePool(ladderPglite());
const { _approvalsTest, APPROVAL_STATUSES, listApprovals, getApprovalFacets } = require('./approvals');
const { rowToApproval, encodeApprovalCursor, decodeApprovalCursor } = _approvalsTest;

test.after(close);
test.beforeEach(() => pg.exec('DELETE FROM automation_approvals'));

let seq = 0;
/** @param {Record<string, unknown>} over */
async function approval(over) {
    seq += 1;
    const r = { id: `apr_${seq}`, step_id: 's1', owner_id: 'someone', organization_id: 'org1', status: 'pending',
        created_at: new Date(Date.UTC(2026, 7, 1, 0, seq)).toISOString(), ...over };
    for (const k of ['approvers', 'stage_participants']) if (r[k] !== undefined) r[k] = JSON.stringify(r[k]);
    const cols = Object.keys(r);
    await pg.query(`INSERT INTO automation_approvals (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(r));
    return r.id;
}

/** @param {Parameters<typeof listApprovals>[0]} filter */
const ids = async (filter) => (await listApprovals(filter)).approvals.map(a => a.id).sort();
const U1 = { userId: 'u1', groupIds: ['g1', 'g2'] };
const U1_SOLO = { userId: 'u1', groupIds: [] };

test('the mine scope is owner OR assignee OR requester OR group member', async () => {
    const want = [
        await approval({ owner_id: 'u1' }),
        await approval({ assignee_user_id: 'u1' }),
        await approval({ requested_by: 'u1' }),
        await approval({ assignee_group_id: 'g2' }),
    ];
    await approval({ assignee_group_id: 'g9' });
    await approval({ owner_id: 'u2', assignee_user_id: 'u3' });
    assert.deepStrictEqual(await ids({ viewer: U1 }), want.sort());
});

test('a viewer with no groups still sees owned and assigned rows, and no group rows', async () => {
    const want = [await approval({ owner_id: 'u1' }), await approval({ assignee_user_id: 'u1' })];
    await approval({ assignee_group_id: 'g1' });
    assert.deepStrictEqual(await ids({ viewer: U1_SOLO }), want.sort());
});

test('the org scope filters on organization_id alone', async () => {
    const want = [await approval({ organization_id: 'org1', owner_id: 'u2' }), await approval({ organization_id: 'org1', owner_id: 'u3' })];
    await approval({ organization_id: 'org2', owner_id: 'u2' });
    assert.deepStrictEqual(await ids({ org: { orgId: 'org1' } }), want.sort(), 'org scope must not also narrow to a person');
});

test('no scope at all fails CLOSED', async () => {
    // A filter that scopes to nobody must return nothing, never everything.
    await approval({ owner_id: 'u1' });
    assert.deepStrictEqual(await ids({}), []);
    assert.deepStrictEqual(await getApprovalFacets({}), { status: {} });
});

test('a filter with NO scope still fails closed, filters or not', async () => {
    await approval({ owner_id: 'u1', studio_app_id: 'app_7', prompt: 'quote' });
    assert.deepStrictEqual(await ids(/** @type {any} */ ({ appId: 'app_7', q: 'quote' })), []);
});

test('unknown statuses are dropped rather than passed to SQL', async () => {
    const pending = await approval({ owner_id: 'u1', status: 'pending' });
    await approval({ owner_id: 'u1', status: 'approved' });
    assert.deepStrictEqual(await ids({ viewer: U1_SOLO, status: ['pending', 'nonsense'] }), [pending]);
    assert.strictEqual((await ids({ viewer: U1_SOLO, status: ['nonsense'] })).length, 2, 'nothing valid left: no status filter');
});

test('appId/automationId narrow but never replace the scope', async () => {
    const want = await approval({ owner_id: 'u1', studio_app_id: 'app_7', automation_id: 'a1' });
    await approval({ owner_id: 'u2', studio_app_id: 'app_7', automation_id: 'a1' });   // same app, not theirs
    await approval({ owner_id: 'u1', studio_app_id: 'app_8', automation_id: 'a1' });
    await approval({ owner_id: 'u1', studio_app_id: 'app_7', automation_id: 'a2' });
    assert.deepStrictEqual(await ids({ viewer: U1_SOLO, appId: 'app_7', automationId: 'a1' }), [want]);
});

test('the q search matches prompt OR title, with LIKE metacharacters escaped', async () => {
    const inPrompt = await approval({ owner_id: 'u1', prompt: 'Get 50%_off now' });
    const inTitle = await approval({ owner_id: 'u1', automation_title: 'Deal 50%_OFF' });
    await approval({ owner_id: 'u1', prompt: 'Get 50 percent off' });   // % as a wildcard would match
    await approval({ owner_id: 'u1', prompt: '50%xoff' });              // _ as a wildcard would match
    assert.deepStrictEqual(await ids({ viewer: U1_SOLO, q: '50%_off' }), [inPrompt, inTitle].sort());
});

test('the escalation target reaches the list only once escalated_at is stamped', async () => {
    const userEsc = await approval({ escalate_to_user_id: 'u1', escalated_at: '2026-08-02T00:00:00Z' });
    const groupEsc = await approval({ escalate_to_group_id: 'g1', escalated_at: '2026-08-02T00:00:00Z' });
    await approval({ escalate_to_user_id: 'u1' });
    await approval({ escalate_to_group_id: 'g1' });
    assert.deepStrictEqual(await ids({ viewer: U1 }), [userEsc, groupEsc].sort());
    assert.deepStrictEqual(await ids({ viewer: U1_SOLO }), [userEsc]);
});

test('panel seats, stage participants and the final approver reach the viewer scope', async () => {
    const seatUser = await approval({ approvers: [{ userId: 'x' }, { userId: 'u1' }] });
    const seatGroup = await approval({ approvers: [{ groupId: 'g1' }] });
    const stageUser = await approval({ stage_participants: [{ userId: 'u1' }] });
    const stageGroup = await approval({ stage_participants: [{ groupId: 'g2' }] });
    const finalUser = await approval({ final_approver_user_id: 'u1' });
    const finalGroup = await approval({ final_approver_group_id: 'g1' });
    await approval({ approvers: [{ userId: 'x' }, { groupId: 'g9' }] });
    assert.deepStrictEqual(await ids({ viewer: U1 }), [seatUser, seatGroup, stageUser, stageGroup, finalUser, finalGroup].sort());
    assert.deepStrictEqual(await ids({ viewer: U1_SOLO }), [seatUser, stageUser, finalUser].sort(), 'no group clause without groups');
});

test('the list pages newest first by cursor, and the facets count the same scope', async () => {
    const made = [];
    for (let i = 0; i < 5; i++) made.push(await approval({ owner_id: 'u1', status: i < 3 ? 'pending' : 'approved' }));
    await approval({ owner_id: 'u2' });
    const first = await listApprovals({ viewer: U1_SOLO, limit: 2 });
    assert.deepStrictEqual(first.approvals.map(a => a.id), [made[4], made[3]]);
    const second = await listApprovals({ viewer: U1_SOLO, limit: 2, cursor: first.nextCursor });
    assert.deepStrictEqual(second.approvals.map(a => a.id), [made[2], made[1]]);
    const third = await listApprovals({ viewer: U1_SOLO, limit: 2, cursor: second.nextCursor });
    assert.deepStrictEqual(third.approvals.map(a => a.id), [made[0]]);
    assert.strictEqual(third.nextCursor, null);
    assert.deepStrictEqual(await getApprovalFacets({ viewer: U1_SOLO }), { status: { pending: 3, approved: 2 } });
});

test('every advertised status is a real one', () => {
    assert.deepStrictEqual(
        [...APPROVAL_STATUSES].sort(),
        ['approved', 'cancelled', 'expired', 'pending', 'rejected'],
    );
});

test('the cursor round-trips', () => {
    const c = decodeApprovalCursor(encodeApprovalCursor({ createdAt: '2026-08-22T10:00:00Z', id: 'apr_x' }));
    assert.deepStrictEqual(c, { createdAt: '2026-08-22T10:00:00Z', id: 'apr_x' });
    assert.strictEqual(decodeApprovalCursor('garbage'), null);
});

test('rowToApproval maps every column an API consumer relies on', () => {
    const row = rowToApproval({
        id: 'apr_1', organization_id: 'org1', automation_id: 'a1', automation_title: 'T',
        run_id: 'r1', root_run_id: 'r0', step_id: 's1', owner_id: 'u1',
        assignee_user_id: null, assignee_group_id: 'g1', status: 'pending',
        prompt: 'Q?', details_md: '**why**', fields: [{ name: 'po' }],
        attachments: [{ fileId: 'f1' }], answers: null,
        decided_by: null, decided_by_name: null, decision_reason: null, decided_at: null,
        expires_at: 'X', created_at: 'C', updated_at: 'U',
    });
    assert.strictEqual(row.assigneeGroupId, 'g1');
    assert.strictEqual(row.detailsMd, '**why**');
    assert.deepStrictEqual(row.fields, [{ name: 'po' }]);
    assert.deepStrictEqual(row.attachments, [{ fileId: 'f1' }]);
    assert.strictEqual(row.rootRunId, 'r0');
});

// ── v2: the source-agnostic record ───────────────────────────────────────

test('v2 columns map through, and a legacy row defaults to source "run"', () => {
    const legacy = rowToApproval({ id: 'apr_1', owner_id: 'u1', status: 'pending' });
    assert.strictEqual(legacy.source, 'run');
    assert.strictEqual(legacy.studioAppId, null);
    assert.strictEqual(legacy.stepId, null);

    const app = rowToApproval({
        id: 'apr_2', owner_id: 'u1', status: 'pending', source: 'app',
        requested_by: 'anon:ab12', studio_app_id: 'app_7', action_id: 'act_1',
        context: { recordId: 'rec_9' }, on_decided: { tableId: 't1' },
        remind_at: 'R', reminder_sent_at: null, escalate_at: 'E', escalated_at: null,
    });
    assert.strictEqual(app.source, 'app');
    assert.strictEqual(app.requestedBy, 'anon:ab12');
    assert.strictEqual(app.studioAppId, 'app_7');
    assert.strictEqual(app.actionId, 'act_1');
    assert.deepStrictEqual(app.context, { recordId: 'rec_9' });
    assert.deepStrictEqual(app.onDecided, { tableId: 't1' });
    assert.strictEqual(app.remindAt, 'R');
    assert.strictEqual(app.escalateAt, 'E');
});

test('v2 clock columns round-trip through the mapper', () => {
    const row = rowToApproval({
        id: 'apr_1', owner_id: 'u1', status: 'pending',
        remind_at: 'R', escalate_at: 'E', escalated_at: null,
        escalate_to_user_id: 'u9', escalate_to_group_id: null,
    });
    assert.strictEqual(row.escalateToUserId, 'u9');
    assert.strictEqual(row.escalateToGroupId, null);
    assert.strictEqual(row.remindAt, 'R');
});

test('panel columns round-trip through the mapper', () => {
    const row = rowToApproval({
        id: 'apr_1', owner_id: 'u1', status: 'pending',
        approvers: [{ userId: 'a' }, { groupId: 'g1' }], approval_rule: 'quorum',
        quorum_count: 2, stage: 'panel', final_approver_user_id: 'cfo', final_approver_group_id: null,
    });
    assert.deepStrictEqual(row.approvers, [{ userId: 'a' }, { groupId: 'g1' }]);
    assert.strictEqual(row.approvalRule, 'quorum');
    assert.strictEqual(row.quorumCount, 2);
    assert.strictEqual(row.stage, 'panel');
    assert.strictEqual(row.finalApproverUserId, 'cfo');
    // Legacy rows: everything null, so nothing anywhere flips into panel mode.
    const legacy = rowToApproval({ id: 'apr_2', owner_id: 'u1', status: 'pending' });
    assert.strictEqual(legacy.approvers, null);
    assert.strictEqual(legacy.stage, null);
});
