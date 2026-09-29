/**
 * createApprovalOnPause with a STAGE CHAIN — the run half of sequential
 * approvals, and the mirror image of appStudio's app half.
 *
 * The engine has already resolved the chain (names interpolated, conditions
 * decided) by the time it gets here; what this file pins is what the lifecycle
 * adds on top: the org gate on every seat of every stage, the fallback that
 * keeps a stage in the chain rather than deleting a required approval, and the
 * three columns that make the row navigable — the chain, the participant index
 * and the key of the stage that is waiting.
 *
 * Run: node --test core/automationRunner/approvalLifecycle.stages.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const automationStore = require('../../stores/automationStore');
const userStore = require('../../stores/userStore');
const approvalEvents = require('../../automation/approvalEvents');
const { createApprovalOnPause, validateStages } = require('./approvalLifecycle');

const AUTOMATION = { id: 'aut_1', userId: 'owner', title: 'Invoice payment', organizationId: 'org1' };
const RUN = { id: 'run_1', rootRunId: 'run_1', triggerPayload: {} };

async function withPatched({ inOrg = ['u1', 'u2', 'u3', 'owner'], groups = ['g-fin'] } = {}, fn) {
    const rec = { created: [], audits: [] };
    const saved = {
        createApproval: automationStore.createApproval,
        appendApprovalAudit: automationStore.appendApprovalAudit,
        getRunsInChain: automationStore.getRunsInChain,
        listGeneratedFilesForRuns: automationStore.listGeneratedFilesForRuns,
    };
    const savedUser = { getUser: userStore.getUser, getAllGroups: userStore.getAllGroups };
    const savedDispatch = approvalEvents.dispatchApprovalRequested;

    automationStore.createApproval = async (row) => { rec.created.push(row); return { id: 'apr_1', ...row }; };
    automationStore.appendApprovalAudit = async (ev) => { rec.audits.push(ev); };
    automationStore.getRunsInChain = async () => [RUN];
    automationStore.listGeneratedFilesForRuns = async () => [];
    userStore.getUser = async (id) => (inOrg.includes(id) ? { id, organizationId: 'org1', groups: '[]' } : { id, organizationId: 'other' });
    userStore.getAllGroups = async () => groups.map(id => ({ id, organizationId: 'org1' }));
    approvalEvents.dispatchApprovalRequested = () => {};

    try { await fn(rec); } finally {
        for (const [k, v] of Object.entries(saved)) automationStore[k] = v;
        for (const [k, v] of Object.entries(savedUser)) userStore[k] = v;
        approvalEvents.dispatchApprovalRequested = savedDispatch;
    }
}

const chain = [
    { key: 'lead', name: 'Team lead', description: 'Did we order this?', approvers: [{ userId: 'u1' }], rule: 'first', quorum: null },
    { key: 'finance', name: 'Finance', approvers: [{ groupId: 'g-fin' }], rule: 'first', quorum: null },
    { key: 'director', name: 'Director', approvers: [{ userId: 'u2' }], rule: 'first', quorum: null, skipped: true },
];

test('the chain, the participant index and the waiting stage all land on the row', async () => {
    await withPatched({}, async (rec) => {
        await createApprovalOnPause({
            automation: AUTOMATION, run: RUN,
            err: { stepId: 's1', prompt: 'Pay this?', stages: chain },
        });
        const row = rec.created[0];
        assert.deepStrictEqual(row.stages.map(s => s.key), ['lead', 'finance', 'director']);
        assert.strictEqual(row.stageKey, 'lead');
        // The skipped director is in the chain (audit) and out of the index
        // (nobody was ever asked, so nobody gets to watch through that seat).
        assert.deepStrictEqual(row.stageParticipants, [{ userId: 'u1' }, { groupId: 'g-fin' }]);
        // Panel-era mirrors point at the stage that is waiting.
        assert.deepStrictEqual(row.approvers, [{ userId: 'u1' }]);
        assert.strictEqual(row.approvalRule, 'first');
        assert.strictEqual(row.assigneeUserId, null, 'a chain has no single assignee');
        assert.strictEqual(row.finalApproverUserId, null, 'the final sign-off is just the chain\'s last stage now');
        assert.strictEqual(rec.audits[0].decision, 'requested');
    });
});

test('a stage that loses every seat to the org gate keeps its place, held by the owner', async () => {
    await withPatched({ inOrg: ['u1', 'owner'] }, async (rec) => {
        await createApprovalOnPause({
            automation: AUTOMATION, run: RUN,
            err: {
                stepId: 's1', prompt: 'q',
                stages: [
                    { key: 'lead', name: 'Team lead', approvers: [{ userId: 'u1' }], rule: 'first' },
                    { key: 'finance', name: 'Finance', approvers: [{ userId: 'outsider' }], rule: 'all' },
                ],
            },
        });
        const row = rec.created[0];
        assert.strictEqual(row.stages.length, 2, 'the chain never gets silently shorter');
        assert.deepStrictEqual(row.stages[1].approvers, [{ userId: 'owner' }]);
        assert.strictEqual(row.stages[1].rule, 'first');
    });
});

test('escalation stays a single-assignee feature — a chain is its own takeover mechanism', async () => {
    await withPatched({}, async (rec) => {
        await createApprovalOnPause({
            automation: AUTOMATION, run: RUN,
            err: {
                stepId: 's1', prompt: 'q', stages: chain,
                escalateTo: { userId: 'u3' }, escalateAfterHours: 4,
            },
        });
        const row = rec.created[0];
        assert.strictEqual(row.escalateAt, null);
        assert.strictEqual(row.escalateToUserId, null);
    });
});

test('validateStages: a chain with nothing left to ask is no chain at all', async () => {
    await withPatched({ inOrg: [] }, async () => {
        const only = [{ key: 'a', name: 'A', approvers: [{ userId: 'x' }], rule: 'all', skipped: true }];
        assert.strictEqual(await validateStages(only, 'org1', 'owner'), null,
            'every stage skipped means nobody would ever be asked — the caller must fall back to its owner path');
        assert.strictEqual(await validateStages(null, 'org1', 'owner'), null);
        assert.strictEqual(await validateStages([], 'org1', 'owner'), null);
    });
});

test('without a chain the row is byte-for-byte the pre-stages shape', async () => {
    await withPatched({}, async (rec) => {
        await createApprovalOnPause({
            automation: AUTOMATION, run: RUN,
            err: { stepId: 's1', prompt: 'q', assignee: { userId: 'u1' } },
        });
        const row = rec.created[0];
        assert.strictEqual(row.stages, null);
        assert.strictEqual(row.stageParticipants, null);
        assert.strictEqual(row.stageKey, null);
        assert.strictEqual(row.assigneeUserId, 'u1');
        assert.strictEqual(row.approvers, null);
    });
});

// ── the reminder sweep ──────────────────────────────────────────────────

test('a reminder on stage three nudges stage three — not the people who decided in stage one', async () => {
    const automationStore = require('../../stores/automationStore');
    const notificationStore = require('../../stores/notificationStore');
    const { remindAndEscalateDueApprovals } = require('./approvalLifecycle');

    const row = {
        id: 'apr_9', ownerId: 'owner', automationTitle: 'Invoice payment', prompt: 'Pay this?',
        // The row is on its THIRD stage. Its panel-era `approvers` column
        // mirrors that stage, which is what makes the pre-stages readers work.
        stage: 's3',
        approvers: [{ userId: 'u3' }, { userId: 'u4' }],
        stages: [
            { key: 's1', name: 'Team lead', approvers: [{ userId: 'u1' }], rule: 'first' },
            { key: 's2', name: 'Finance', approvers: [{ userId: 'u2' }], rule: 'first' },
            { key: 's3', name: 'Director', approvers: [{ userId: 'u3' }, { userId: 'u4' }], rule: 'all' },
        ],
    };
    const saved = {
        markDueApprovalReminders: automationStore.markDueApprovalReminders,
        markDueApprovalEscalations: automationStore.markDueApprovalEscalations,
        getApprovalVotes: automationStore.getApprovalVotes,
        appendApprovalAudit: automationStore.appendApprovalAudit,
    };
    const savedNotify = notificationStore.createNotification;
    const bells = [];
    automationStore.markDueApprovalReminders = async () => [row];
    automationStore.markDueApprovalEscalations = async () => [];
    automationStore.appendApprovalAudit = async () => {};
    automationStore.getApprovalVotes = async () => ([
        { stage: 's1', voterId: 'u1', decision: 'approve' },
        { stage: 's2', voterId: 'u2', decision: 'approve' },
        { stage: 's3', voterId: 'u3', decision: 'approve' },   // u3 already voted in THIS stage
    ]);
    notificationStore.createNotification = async (n) => { bells.push(n); };

    try {
        await remindAndEscalateDueApprovals();
    } finally {
        for (const [k, v] of Object.entries(saved)) automationStore[k] = v;
        notificationStore.createNotification = savedNotify;
    }

    assert.deepStrictEqual(bells.map(b => b.userId), ['u4'],
        'only the seat still owing a decision in the CURRENT stage is nudged');
});
