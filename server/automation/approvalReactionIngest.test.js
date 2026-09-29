'use strict';

/**
 * A 👍 in Talk becomes a vote — and only when all four proofs hold.
 *
 * This is an AUTHORIZATION test more than a plumbing one. A chat room is a
 * wide-open surface: anyone in it can react to anything. What keeps that from
 * being an approval bypass is that a reaction is only ever counted when
 *
 *   1. the message is one of OUR cards (delivery-ledger row, exact key),
 *   2. the approval is still pending and belongs to the signing org,
 *   3. the reacting Nextcloud uid maps to a Bee Flow user in that org,
 *   4. that user holds a seat in the approval's CURRENT stage,
 *
 * and the decision itself goes through approvalService.decide — the one place
 * a decision happens — never a second code path.
 *
 * The negative cases matter more than the positive one, so most of this file
 * is "and this must NOT be a vote".
 *
 * Run: cd server && node --test --test-force-exit automation/approvalReactionIngest.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

process.env.PUBLIC_BASE_URL = 'https://app.example';

const SERVER = path.resolve(__dirname, '..');
function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

const rec = { decides: [], replies: [] };
const state = { delivery: null, approval: null, users: {}, deliveriesForPoll: [], reactions: [] };

mock(path.join(SERVER, 'stores/automationStore'), {
    getApprovalDeliveryForTalkMessage: async (roomToken, messageId) => {
        const d = state.delivery;
        if (!d) return null;
        return (String(d.externalRef.roomToken) === String(roomToken)
            && String(d.externalRef.messageId) === String(messageId)) ? d : null;
    },
    getApproval: async (id) => (state.approval && state.approval.id === id ? state.approval : null),
    getRun: async () => null,
    getPendingTalkDeliveries: async () => state.deliveriesForPoll,
    getApprovalDeliveries: async () => state.deliveriesForPoll,
    recordApprovalDelivery: async () => ({}),
});
mock(path.join(SERVER, 'stores/userStore'), {
    getUserByNcUid: async (orgId, ncUid) => state.users[`${orgId}:${ncUid}`] || null,
    getUser: async (id) => ({ id }),
});
mock(path.join(SERVER, 'automation/approvalDelivery'), {
    replyInTalk: async (args) => { rec.replies.push(args); return { ok: true }; },
    _deliveryTest: { resolveNcContext: async () => ({ baseUrl: 'https://cloud.example', fetch: async () => ({}) }) },
});
mock(path.join(SERVER, 'integrations/nextcloudTalkBot'), {
    listMessageReactions: async () => state.reactions,
});

const ingest = require('./approvalReactionIngest');
// The REAL rulebook (hasStages / currentStage / isSeatedInStage / canDecide),
// with only the terminal decision spied on: if the seat arithmetic were stubbed
// this test would prove nothing.
const approvalService = require('./approvalService');
const realDecide = approvalService.decide;
approvalService.decide = async (args) => {
    rec.decides.push(args);
    return { code: 200, body: { accepted: true, decision: 'approve' } };
};
test.after(() => { approvalService.decide = realDecide; });

const STAGES = [
    { key: 's1', name: 'Cost-centre check', approvers: [{ userId: 'u_lead' }], rule: 'first' },
    { key: 's2', name: 'Finance sign-off', approvers: [{ groupId: 'g_fin' }], rule: 'first' },
];

function setup({ approval, delivery, users } = {}) {
    rec.decides = []; rec.replies = [];
    state.approval = approval || {
        id: 'apr_1', status: 'pending', organizationId: 'org1', ownerId: 'owner',
        prompt: 'Pay it?', fields: null, runId: null, stages: STAGES, stage: 's1',
    };
    state.delivery = delivery || {
        id: 'dlv_1', approvalId: 'apr_1', channel: 'nc_talk', organizationId: 'org1',
        stage: 's1', userId: 'owner',
        externalRef: { roomToken: 'room1', messageId: '1567', via: 'bot' },
        status: 'sent',
    };
    state.users = users || {
        'org1:ada': { id: 'u_lead', groups: '[]' },
        'org1:fin-fran': { id: 'u_fran', groups: '["g_fin"]' },
        'org1:bob': { id: 'u_bob', groups: '[]' },
    };
}

function reaction(over = {}) {
    return {
        roomToken: 'room1', messageId: '1567', reaction: '👍',
        removed: false, actorType: 'users', ...over,
    };
}

// ── The happy path ──────────────────────────────────────────────────────────

test('a 👍 from the current stage’s approver is a real vote', async () => {
    setup();
    const res = await ingest.handleTalkReaction({ orgId: 'org1', ncUid: 'ada', payload: reaction() });
    assert.equal(res.counted, true);
    assert.equal(rec.decides.length, 1);
    assert.equal(rec.decides[0].deciderId, 'u_lead');
    assert.equal(rec.decides[0].decision, 'approve');
    assert.equal(rec.decides[0].source, 'nextcloud', 'the audit trail must say where the decision came from');
    assert.equal(rec.decides[0].approval.id, 'apr_1');
});

test('a group seat is filled by whoever in the group reacts', async () => {
    setup({ approval: {
        id: 'apr_1', status: 'pending', organizationId: 'org1', ownerId: 'owner',
        prompt: 'Pay it?', fields: null, runId: null, stages: STAGES, stage: 's2',
    } });
    const res = await ingest.handleTalkReaction({ orgId: 'org1', ncUid: 'fin-fran', payload: reaction() });
    assert.equal(res.counted, true);
    assert.equal(rec.decides[0].deciderId, 'u_fran');
});

test('✅ counts too; 🎉 is not an answer', async () => {
    setup();
    assert.equal((await ingest.handleTalkReaction({ orgId: 'org1', ncUid: 'ada', payload: reaction({ reaction: '✅' }) })).counted, true);
    setup();
    const res = await ingest.handleTalkReaction({ orgId: 'org1', ncUid: 'ada', payload: reaction({ reaction: '🎉' }) });
    assert.equal(res.outcome, 'not_a_decision_emoji');
    assert.equal(rec.decides.length, 0);
});

test('skin tones and variation selectors do not change the vote', () => {
    assert.equal(ingest.classifyReaction('👍🏽'), 'approve');
    assert.equal(ingest.classifyReaction('👍️'), 'approve');
    assert.equal(ingest.classifyReaction('👎🏿'), 'reject');
});

// ── Who may NOT vote ────────────────────────────────────────────────────────

test('someone with no seat in the CURRENT stage is ignored — silently', async () => {
    setup();   // stage s1 belongs to u_lead; u_fran is seated in s2
    const res = await ingest.handleTalkReaction({ orgId: 'org1', ncUid: 'fin-fran', payload: reaction() });
    assert.equal(res.counted, false);
    assert.equal(res.outcome, 'not_seated');
    assert.equal(rec.decides.length, 0);
    assert.equal(rec.replies.length, 0,
        'answering in the room would publish the approver list to everyone in it');
});

test('a bystander in the conversation is not an approver', async () => {
    setup();
    const res = await ingest.handleTalkReaction({ orgId: 'org1', ncUid: 'bob', payload: reaction() });
    assert.equal(res.outcome, 'not_seated');
    assert.equal(rec.decides.length, 0);
});

test('an org admin cannot approve by reacting — the seat is the authority', async () => {
    setup({
        approval: {
            id: 'apr_1', status: 'pending', organizationId: 'org1', ownerId: 'owner',
            prompt: 'Pay it?', fields: null, runId: null,
            stages: null, stage: null, assigneeUserId: 'u_lead',
        },
        users: { 'org1:admin': { id: 'u_admin', groups: '[]', orgRole: 'org_admin' } },
    });
    const res = await ingest.handleTalkReaction({ orgId: 'org1', ncUid: 'admin', payload: reaction() });
    assert.equal(res.outcome, 'not_seated');
    assert.equal(rec.decides.length, 0);
});

test('a Nextcloud uid that maps to nobody is not a person we can hold to a decision', async () => {
    setup();
    const res = await ingest.handleTalkReaction({ orgId: 'org1', ncUid: 'stranger', payload: reaction() });
    assert.equal(res.outcome, 'actor_not_a_beeflow_user');
    assert.equal(rec.decides.length, 0);
});

test('a guest or a bot never votes — including our own seeded 👍', async () => {
    setup();
    for (const actorType of ['guests', 'bots']) {
        const res = await ingest.handleTalkReaction({ orgId: 'org1', ncUid: 'ada', payload: reaction({ actorType }) });
        assert.equal(res.outcome, 'actor_not_a_user');
    }
    assert.equal(rec.decides.length, 0);
});

// ── Which messages count ────────────────────────────────────────────────────

test('a reaction on any other message in the room resolves to nothing', async () => {
    setup();
    const res = await ingest.handleTalkReaction({ orgId: 'org1', ncUid: 'ada', payload: reaction({ messageId: '9999' }) });
    assert.equal(res.outcome, 'not_an_approval_card');
    assert.equal(rec.decides.length, 0);
});

test('the same message id in a different room is a different message', async () => {
    setup();
    const res = await ingest.handleTalkReaction({ orgId: 'org1', ncUid: 'ada', payload: reaction({ roomToken: 'other' }) });
    assert.equal(res.outcome, 'not_an_approval_card');
});

test('one tenant’s connector cannot vote on another tenant’s card', async () => {
    setup();
    const res = await ingest.handleTalkReaction({ orgId: 'org2', ncUid: 'ada', payload: reaction() });
    assert.equal(res.outcome, 'org_mismatch');
    assert.equal(rec.decides.length, 0);
});

test('a decided approval takes no more votes', async () => {
    setup();
    state.approval.status = 'approved';
    const res = await ingest.handleTalkReaction({ orgId: 'org1', ncUid: 'ada', payload: reaction() });
    assert.equal(res.outcome, 'already_decided');
    assert.equal(rec.decides.length, 0);
});

test('removing a 👍 is not an un-vote', async () => {
    setup();
    const res = await ingest.handleTalkReaction({ orgId: 'org1', ncUid: 'ada', payload: reaction({ removed: true }) });
    assert.equal(res.outcome, 'reaction_removed');
    assert.equal(rec.decides.length, 0);
});

// ── The asymmetry ───────────────────────────────────────────────────────────

test('👎 does not decline — it points the approver at the app, where a reason exists', async () => {
    setup();
    const res = await ingest.handleTalkReaction({ orgId: 'org1', ncUid: 'ada', payload: reaction({ reaction: '👎' }) });
    assert.equal(res.counted, false);
    assert.equal(res.outcome, 'reject_needs_reason');
    assert.equal(rec.decides.length, 0, 'a rejection with no reason must never reach the decision path');
    assert.equal(rec.replies.length, 1);
    assert.match(rec.replies[0].message, /reason/i);
    assert.match(rec.replies[0].message, /\/app\/studio\/approvals\/apr_1/);
    assert.equal(rec.replies[0].replyTo, 1567, 'the nudge threads under the card it is about');
});

test('a request with approver questions sends even a 👍 to the app', async () => {
    setup();
    state.approval.fields = [{ key: 'cost_centre', type: 'text', label: 'Cost centre' }];
    const res = await ingest.handleTalkReaction({ orgId: 'org1', ncUid: 'ada', payload: reaction() });
    assert.equal(res.outcome, 'answers_required');
    assert.equal(rec.decides.length, 0);
    assert.equal(rec.replies.length, 1);
    assert.match(rec.replies[0].message, /questions/i);
});

test('a 👎 from a non-approver gets no reply either', async () => {
    setup();
    await ingest.handleTalkReaction({ orgId: 'org1', ncUid: 'bob', payload: reaction({ reaction: '👎' }) });
    assert.equal(rec.replies.length, 0);
});

// ── Outcomes the decision path owns ─────────────────────────────────────────

test('a refusal from the decision path is reported, never re-decided here', async () => {
    setup();
    approvalService.decide = async (args) => {
        rec.decides.push(args);
        return { code: 409, body: { error: 'You already voted in "Cost-centre check".' } };
    };
    const res = await ingest.handleTalkReaction({ orgId: 'org1', ncUid: 'ada', payload: reaction() });
    assert.equal(res.counted, false);
    assert.equal(res.outcome, 'decide_refused');
    assert.equal(res.code, 409);
    approvalService.decide = async (args) => { rec.decides.push(args); return { code: 200, body: { decision: 'approve' } }; };
});

test('nothing here throws — the caller is a webhook ack path', async () => {
    setup();
    state.approval = null;
    assert.equal((await ingest.handleTalkReaction({ orgId: 'org1', ncUid: 'ada', payload: reaction() })).outcome, 'approval_gone');
    assert.equal((await ingest.handleTalkReaction({ orgId: null, ncUid: 'ada', payload: reaction() })).outcome, 'no_org');
    assert.equal((await ingest.handleTalkReaction({ orgId: 'org1', ncUid: 'ada', payload: {} })).outcome, 'not_a_decision_emoji');
    assert.equal((await ingest.handleTalkReaction({ orgId: 'org1', ncUid: 'ada', payload: reaction({ messageId: null }) })).outcome, 'incomplete_payload');
});

// ── The polling fallback (Nextcloud 24–30) ──────────────────────────────────

test('polling feeds reactions through exactly the same four proofs', async () => {
    setup();
    state.deliveriesForPoll = [state.delivery];
    state.reactions = [
        { reaction: '👍', actorType: 'users', actorId: 'ada' },       // seated → counts
        { reaction: '👍', actorType: 'users', actorId: 'bob' },       // no seat → ignored
        { reaction: '👍', actorType: 'bots', actorId: 'bot-1' },      // our own seed → ignored
        { reaction: '🎉', actorType: 'users', actorId: 'ada' },       // not an answer
    ];
    const res = await ingest.pollTalkReactions();
    assert.equal(res.checked, 1);
    assert.equal(res.counted, 1);
    assert.equal(rec.decides.length, 1);
    assert.equal(rec.decides[0].deciderId, 'u_lead');
});

test('polling is a no-op when nothing is waiting', async () => {
    setup();
    state.deliveriesForPoll = [];
    assert.deepEqual(await ingest.pollTalkReactions(), { checked: 0, counted: 0 });
    assert.equal(rec.decides.length, 0);
});
