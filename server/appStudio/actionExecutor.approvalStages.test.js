/**
 * request_approval with a STAGE CHAIN — the app half of sequential approvals.
 *
 * The point of these tests is that an app and an automation reach the SAME row.
 * Both desugar through automation/approvalStages.js, both pass every seat
 * through the same org gate, and both stamp the chain, the participant index
 * and the first stage's key. A divergence here is how "the invoice app skipped
 * finance but the automation didn't" happens.
 *
 * Run: node --test appStudio/actionExecutor.approvalStages.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const automationStore = require('../stores/automationStore');
const notificationStore = require('../stores/notificationStore');
const userStore = require('../stores/userStore');
const { executeDataStep } = require('./actionExecutor');
const entitlements = require('../core/entitlements/entitlements');

// The Enterprise `approvals` gate is covered by actionExecutor.approval.test.js;
// here it is simply granted so the chain itself is what is under test.
entitlements.hasCapability = async () => true;

const APP = { id: 'app_inv', userId: 'owner', name: 'Invoice approvals', organizationId: 'org1' };
const MODEL = { tables: [] };
const CTX = {
    viewerId: 'viewer-1', viewerName: 'Sam', role: 'member',
    formValues: { supplier: 'Acme BV', amount: 9000 }, vars: {},
};
const STEP = { kind: 'request_approval', prompt: { kind: 'static', value: 'Pay this invoice?' }, resultVar: 'approval' };

/**
 * The org gate is userStore-backed, so it is stubbed here rather than worked
 * around: `inOrg` is the set of ids that belong to org1. Everyone else is a
 * stranger, which is what the drop rule is about.
 */
async function withPatched({ inOrg = ['u1', 'u2', 'u3', 'owner'], groups = ['g-fin'] } = {}, fn) {
    const rec = { created: [], audits: [], bells: [] };
    const saved = {
        createApproval: automationStore.createApproval,
        countPendingApprovalsForApp: automationStore.countPendingApprovalsForApp,
        appendApprovalAudit: automationStore.appendApprovalAudit,
        getSubscriptionsForProvider: automationStore.getSubscriptionsForProvider,
    };
    const savedUser = { getUser: userStore.getUser, getAllGroups: userStore.getAllGroups, getAllUsers: userStore.getAllUsers };
    const savedNotify = notificationStore.createNotification;

    automationStore.countPendingApprovalsForApp = async () => 0;
    automationStore.createApproval = async (row) => { rec.created.push(row); return { id: 'apr_new', ...row, status: 'pending' }; };
    automationStore.appendApprovalAudit = async (ev) => { rec.audits.push(ev); };
    automationStore.getSubscriptionsForProvider = async () => [];
    userStore.getUser = async (id) => (inOrg.includes(id) ? { id, organizationId: 'org1', groups: '[]' } : { id, organizationId: 'other' });
    userStore.getAllGroups = async () => groups.map(id => ({ id, organizationId: 'org1' }));
    userStore.getAllUsers = async () => inOrg.map(id => ({ id, groups: JSON.stringify(groups) }));
    notificationStore.createNotification = async (n) => { rec.bells.push(n); };

    try { await fn(rec); } finally {
        for (const [k, v] of Object.entries(saved)) automationStore[k] = v;
        for (const [k, v] of Object.entries(savedUser)) userStore[k] = v;
        notificationStore.createNotification = savedNotify;
    }
}

const stages = [
    { key: 'lead', name: 'Team lead', description: 'Did we order this?', approvers: [{ userId: 'u1' }], rule: 'first' },
    { key: 'finance', name: 'Finance', approvers: [{ groupId: 'g-fin' }], rule: 'first' },
    { key: 'director', name: 'Director', approvers: [{ userId: 'u2' }], rule: 'first', when: 'form.amount > 5000' },
];

test('a chain lands whole: stages, participants, and the first stage as the row\'s current one', async () => {
    await withPatched({}, async (rec) => {
        const res = await executeDataStep(APP, MODEL, { ...STEP, stages }, CTX);
        assert.strictEqual(res.ok, true, JSON.stringify(res));
        const row = rec.created[0];

        assert.deepStrictEqual(row.stages.map(s => s.key), ['lead', 'finance', 'director']);
        assert.strictEqual(row.stageKey, 'lead', 'the chain starts at its first stage');
        // The participant index is the flat, de-duped seat list the viewer
        // scope scans — every seat of every active stage, once.
        assert.deepStrictEqual(row.stageParticipants, [{ userId: 'u1' }, { groupId: 'g-fin' }, { userId: 'u2' }]);
        // The panel-era columns mirror the stage that is WAITING, so every
        // pre-stages reader still addresses the right people.
        assert.deepStrictEqual(row.approvers, [{ userId: 'u1' }]);
        assert.strictEqual(row.approvalRule, 'first');
    });
});

test('a stage condition is decided once, at request time, and the stage is kept', async () => {
    await withPatched({}, async (rec) => {
        // €900 — under the director's threshold.
        await executeDataStep(APP, MODEL, { ...STEP, stages }, { ...CTX, formValues: { supplier: 'Acme BV', amount: 900 } });
        const row = rec.created[0];
        const director = row.stages.find(s => s.key === 'director');
        assert.strictEqual(director.skipped, true,
            'the stage is recorded as deliberately skipped — "why did this never reach the director?" is an audit question');
        assert.ok(!row.stageParticipants.some(p => p.userId === 'u2'),
            'a skipped stage puts nobody in the participant index — they cannot watch a request they were never in');
    });
});

test('a seat outside the org is dropped, and a stage that loses every seat falls back to the owner', async () => {
    await withPatched({ inOrg: ['u1', 'owner'] }, async (rec) => {
        await executeDataStep(APP, MODEL, {
            ...STEP,
            stages: [
                { key: 'lead', name: 'Team lead', approvers: [{ userId: 'u1' }, { userId: 'stranger' }], rule: 'all' },
                { key: 'finance', name: 'Finance', approvers: [{ userId: 'outsider' }], rule: 'first' },
            ],
        }, CTX);
        const row = rec.created[0];
        assert.deepStrictEqual(row.stages[0].approvers, [{ userId: 'u1' }], 'the stranger never gets a vote');
        assert.deepStrictEqual(row.stages[1].approvers, [{ userId: 'owner' }],
            'the stage stays in the chain with the owner in it — deleting it would silently remove a required approval');
    });
});

test('an out-of-org seat re-clamps its stage\'s quorum so the stage can still pass', async () => {
    await withPatched({ inOrg: ['u1', 'u2', 'owner'] }, async (rec) => {
        await executeDataStep(APP, MODEL, {
            ...STEP,
            stages: [{ key: 'p', name: 'Panel', approvers: [{ userId: 'u1' }, { userId: 'u2' }, { userId: 'stranger' }], rule: 'quorum', quorum: 3 }],
        }, CTX);
        const st = rec.created[0].stages[0];
        assert.strictEqual(st.approvers.length, 2);
        assert.strictEqual(st.quorum, 2, 'a "3 of 3" that lost a seat must not become an unreachable "3 of 2"');
    });
});

test('stage names and descriptions may be bindings, resolved in the app\'s own idiom', async () => {
    await withPatched({}, async (rec) => {
        await executeDataStep(APP, MODEL, {
            ...STEP,
            stages: [{
                key: 'fin', approvers: [{ userId: 'u1' }], rule: 'first',
                name: { kind: 'formula', expr: '"Finance — " + form.supplier' },
                description: { kind: 'field', name: 'supplier' },
            }],
        }, CTX);
        const st = rec.created[0].stages[0];
        assert.strictEqual(st.name, 'Finance — Acme BV');
        assert.strictEqual(st.description, 'Acme BV');
    });
});

test('with no chain the row keeps its pre-stages shape exactly', async () => {
    await withPatched({}, async (rec) => {
        await executeDataStep(APP, MODEL, { ...STEP, assigneeUserId: 'u1' }, CTX);
        const row = rec.created[0];
        assert.strictEqual(row.stages, null);
        assert.strictEqual(row.stageKey, null);
        assert.strictEqual(row.assigneeUserId, 'u1');
    });
});
