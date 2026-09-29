/**
 * Approvals reaching the project feed.
 *
 * approvalEvents already fans out to the trigger bus so an automation can
 * subscribe to `approval.decided`. It now also writes into the feed of the
 * project the approval was stamped with, so a decision shows up live on the
 * project page. The rules:
 *
 *   1. THE TWO FAN-OUTS ARE INDEPENDENT. The trigger bus is an
 *      automation-facing integration surface; the feed is a human-facing one.
 *      Neither failing may affect the other, or the decision that produced them.
 *   2. NO PROJECT, NO FEED ENTRY — which is most approvals.
 *   3. A DECISION IS EMITTED ONCE. dispatchApprovalDecided has two dispatch
 *      exits (votes in hand, or votes fetched first); the feed entry sits on
 *      the shared path and must not be duplicated by the panel branch.
 *
 * Run: cd server && node --test automation/approvalEvents.project.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const feedPath = require.resolve('../core/projectFeed');
const dispatchPath = require.resolve('./triggerBus/dispatch');
const storePath = require.resolve('../stores/automationStore');

const emitted = [];
const dispatched = [];
let feedError = null;
let dispatchError = null;

require.cache[feedPath] = {
    id: feedPath, filename: feedPath, loaded: true,
    exports: {
        emitProjectEvent: async (projectId, event, opts) => {
            if (feedError) throw feedError;
            emitted.push({ projectId, event, opts });
        },
    },
};
require.cache[dispatchPath] = {
    id: dispatchPath, filename: dispatchPath, loaded: true,
    exports: {
        dispatchEvent: async (a) => { if (dispatchError) throw dispatchError; dispatched.push(a); },
        dispatchOrgScopedEvent: async (provider, event, payload, orgId) => {
            if (dispatchError) throw dispatchError;
            dispatched.push({ provider, event, payload, orgId });
        },
    },
};
require.cache[storePath] = {
    id: storePath, filename: storePath, loaded: true,
    exports: { getApprovalVotes: async () => [{ voterId: 'u2', decision: 'approved', stage: 'panel' }] },
};

const { dispatchApprovalRequested, dispatchApprovalDecided } = require('./approvalEvents');

const IN_PROJECT = {
    id: 'apr1', ownerId: 'alice', organizationId: 'org1', status: 'pending',
    projectId: 'p1', projectTitle: 'Onboarding',
    prompt: 'Ship it?', automationId: 'a1', automationTitle: 'Release', source: 'run',
};
const STANDALONE = { ...IN_PROJECT, projectId: null, projectTitle: '' };

const settle = () => new Promise(r => setImmediate(r));
function reset() { emitted.length = 0; dispatched.length = 0; feedError = null; dispatchError = null; }

test('a requested approval lands in its project feed', async () => {
    reset();
    dispatchApprovalRequested({ ...IN_PROJECT, expiresAt: '2026-09-01T00:00:00Z' });
    await settle();

    assert.strictEqual(emitted.length, 1);
    const { projectId, event } = emitted[0];
    assert.strictEqual(projectId, 'p1');
    assert.strictEqual(event.kind, 'approval.requested');
    assert.strictEqual(event.targetType, 'approval');
    assert.strictEqual(event.targetId, 'apr1');
    assert.strictEqual(event.actorId, null, 'a run pausing is the system asking, not a person');
    assert.strictEqual(event.payload.automationTitle, 'Release');
    assert.strictEqual(event.payload.expiresAt, '2026-09-01T00:00:00Z');
});

test('an approval with no project writes no feed entry', async () => {
    reset();
    dispatchApprovalRequested(STANDALONE);
    await settle();
    assert.strictEqual(emitted.length, 0);
    assert.strictEqual(dispatched.length, 1, 'but the trigger bus still hears about it');
});

test('a decision names its decider', async () => {
    reset();
    dispatchApprovalDecided({ ...IN_PROJECT, status: 'approved', decidedBy: 'bob', decidedByName: 'Bob' });
    await settle();

    assert.strictEqual(emitted.length, 1);
    assert.strictEqual(emitted[0].event.kind, 'approval.decided');
    assert.strictEqual(emitted[0].event.actorId, 'bob');
    assert.strictEqual(emitted[0].event.payload.decision, 'approved');
    assert.strictEqual(emitted[0].event.payload.decidedByName, 'Bob');
});

test('a still-pending row is not a decision', async () => {
    reset();
    dispatchApprovalDecided({ ...IN_PROJECT, status: 'pending' });
    await settle();
    assert.strictEqual(emitted.length, 0);
});

test('a panel decision is fed once, not once per dispatch exit', async () => {
    reset();
    // No votes in hand + approvers present takes the fetch-then-dispatch branch,
    // which returns early. The feed entry sits above that split.
    dispatchApprovalDecided({
        ...IN_PROJECT, status: 'approved', decidedBy: 'bob',
        approvers: [{ userId: 'u1' }, { userId: 'u2' }],
    });
    await settle();
    await settle();

    assert.strictEqual(emitted.length, 1, 'exactly one feed entry per decision');
});

test('a failing feed never disturbs the trigger dispatch', async () => {
    reset();
    feedError = new Error('feed down');
    assert.doesNotThrow(() => dispatchApprovalRequested(IN_PROJECT));
    await settle();
    assert.strictEqual(dispatched.length, 1, 'the automation-facing fan-out is unaffected');
});

test('a failing trigger dispatch never disturbs the feed', async () => {
    reset();
    dispatchError = new Error('bus down');
    assert.doesNotThrow(() => dispatchApprovalRequested(IN_PROJECT));
    await settle();
    assert.strictEqual(emitted.length, 1, 'the human-facing fan-out is unaffected');
});

test('neither fan-out can fail the decision that produced it', async () => {
    reset();
    feedError = new Error('feed down');
    dispatchError = new Error('bus down');
    assert.doesNotThrow(() => dispatchApprovalDecided({ ...IN_PROJECT, status: 'rejected', decidedBy: 'bob' }));
    await settle();
});

test('the feed carries the FACT, never the CONTENT', async () => {
    reset();
    const sensitive = {
        ...IN_PROJECT,
        status: 'approved',
        decidedBy: 'bob',
        prompt: 'Approve the payment? ref LEAK-CANARY-PROMPT',
        detailsMd: '# Contract\nsigned, ref LEAK-CANARY-DETAILS',
        fields: [{ name: 'account', value: 'LEAK-CANARY-FIELD' }],
        answers: { account: 'LEAK-CANARY-ANSWER' },
        attachments: [{ fileId: 'f1', name: 'LEAK-CANARY-ATTACHMENT.pdf' }],
        context: { recordId: 'LEAK-CANARY-CONTEXT' },
        assigneeUserId: 'LEAK-CANARY-ASSIGNEE',
        assigneeGroupId: 'LEAK-CANARY-GROUP',
    };
    dispatchApprovalDecided(sensitive);
    await settle();

    // project_events is broadcast to EVERY project member over SSE and replayed
    // from the durable row. The approvals listing is viewer-scoped precisely so
    // a question addressed to named people is not readable by the whole project;
    // the feed must not route around that.
    const wire = JSON.stringify(emitted[0]);
    for (const secret of ['LEAK-CANARY-PROMPT', 'LEAK-CANARY-DETAILS', 'LEAK-CANARY-FIELD',
        'LEAK-CANARY-ANSWER', 'LEAK-CANARY-ATTACHMENT', 'LEAK-CANARY-CONTEXT',
        'LEAK-CANARY-ASSIGNEE', 'LEAK-CANARY-GROUP']) {
        assert.ok(!wire.includes(secret), `the feed must not carry ${secret}`);
    }
    const payload = emitted[0].event.payload;
    assert.strictEqual(payload.prompt, undefined);
    assert.strictEqual(payload.detailsMd, undefined);
    assert.strictEqual(payload.fields, undefined);
    assert.strictEqual(payload.answers, undefined);
    assert.strictEqual(payload.attachments, undefined);
    assert.strictEqual(payload.context, undefined);

    // What it DOES carry: enough to say something happened, and to link to it.
    assert.strictEqual(payload.approvalId, 'apr1');
    assert.strictEqual(payload.automationTitle, 'Release');
    assert.strictEqual(payload.decision, 'approved');

    // And the automation-facing trigger bus is unchanged — it is org/owner
    // scoped, and subscribers there legitimately need the content.
    assert.ok(dispatched.length > 0);
    assert.ok(JSON.stringify(dispatched).includes('LEAK-CANARY-PROMPT'));
});
