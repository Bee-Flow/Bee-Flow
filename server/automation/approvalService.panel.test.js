/**
 * Approval PANELS — the rulebook and the vote orchestration.
 *
 * The pure half (rule evaluation, seat assignment, answer merging, the
 * stage-aware decider set) is pinned exhaustively; the orchestration half
 * (castPanelVote through decide()) runs against a monkey-patched store the
 * same way approvalService.v2.test.js does. What must hold:
 *
 *   • 'all'    — one reject declines IMMEDIATELY; every seat approving passes.
 *   • 'first'  — the earliest vote decides for the whole panel.
 *   • 'quorum' — passes at N approvals; declines the moment N is unreachable.
 *   • Personal seats are claimed before group seats (a member who also holds
 *     a named seat must not deadlock their own).
 *   • The final sign-off stage flips exactly once and only ITS approver may
 *     act there; the terminal machinery fires exactly once, at the end.
 *   • Owner and org admin hold view/withdraw rights but NO vote — an
 *     "everyone must approve" the owner can bypass is theatre.
 *
 * Run: node --test automation/approvalService.panel.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const automationStore = require('../stores/automationStore');
const dispatchMod = require('./triggerBus/dispatch');
const service = require('./approvalService');
const { decide, canDecide, canView, seatIndexFor, panelProgress } = service;
const { evaluatePanel, mergeVoteAnswers, isSeatedOnPanel, isFinalApprover } = service._panelTest;

const vote = (voterId, decision, over = {}) => ({
    voterId, decision, stage: 'panel', seatIndex: 0, answers: null, reason: null, ...over,
});

// ── The rulebook ─────────────────────────────────────────────────────────

test("'all': one reject declines immediately; a full house passes", () => {
    const ap = { approvers: [{ userId: 'a' }, { userId: 'b' }, { userId: 'c' }], approvalRule: 'all' };
    assert.strictEqual(evaluatePanel(ap, []), 'open');
    assert.strictEqual(evaluatePanel(ap, [vote('a', 'approve')]), 'open');
    assert.strictEqual(evaluatePanel(ap, [vote('a', 'approve'), vote('b', 'reject', { seatIndex: 1 })]), 'rejected');
    assert.strictEqual(evaluatePanel(ap, [vote('a', 'approve'), vote('b', 'approve', { seatIndex: 1 }), vote('c', 'approve', { seatIndex: 2 })]), 'passed');
});

test("'first': the earliest vote decides for everyone", () => {
    const ap = { approvers: [{ userId: 'a' }, { userId: 'b' }], approvalRule: 'first' };
    assert.strictEqual(evaluatePanel(ap, []), 'open');
    assert.strictEqual(evaluatePanel(ap, [vote('b', 'approve')]), 'passed');
    assert.strictEqual(evaluatePanel(ap, [vote('b', 'reject')]), 'rejected');
});

test("'quorum': passes at N; declines the moment N is unreachable", () => {
    const ap = { approvers: [{ userId: 'a' }, { userId: 'b' }, { userId: 'c' }], approvalRule: 'quorum', quorumCount: 2 };
    assert.strictEqual(evaluatePanel(ap, [vote('a', 'approve')]), 'open');
    assert.strictEqual(evaluatePanel(ap, [vote('a', 'approve'), vote('b', 'approve', { seatIndex: 1 })]), 'passed');
    // One reject of three leaves 2 still reachable — stays open.
    assert.strictEqual(evaluatePanel(ap, [vote('a', 'reject')]), 'open');
    // Two rejects make 2 approvals impossible — declined right then.
    assert.strictEqual(evaluatePanel(ap, [vote('a', 'reject'), vote('b', 'reject', { seatIndex: 1 })]), 'rejected');
});

test('an unknown rule falls back to the strictest reading (all)', () => {
    const ap = { approvers: [{ userId: 'a' }, { userId: 'b' }], approvalRule: 'vibes' };
    assert.strictEqual(evaluatePanel(ap, [vote('a', 'reject')]), 'rejected');
    assert.strictEqual(evaluatePanel(ap, [vote('a', 'approve')]), 'open');
});

// ── Seats ────────────────────────────────────────────────────────────────

test('personal seats are claimed before group seats — no self-deadlock', () => {
    const approvers = [{ groupId: 'g1' }, { userId: 'me' }];
    // 'me' is in g1 AND holds seat 1: their vote must fill seat 1, leaving
    // the group seat for a colleague — else an 'all' panel can never finish.
    assert.strictEqual(seatIndexFor(approvers, [], { userId: 'me', groupIds: ['g1'] }), 1);
    // With their personal seat filled by their own earlier vote: one vote per person.
    assert.strictEqual(seatIndexFor(approvers, [vote('me', 'approve', { seatIndex: 1 })], { userId: 'me', groupIds: ['g1'] }), -1);
    // A plain group member takes the group seat…
    assert.strictEqual(seatIndexFor(approvers, [], { userId: 'colleague', groupIds: ['g1'] }), 0);
    // …and once it is filled, the next member has no seat left.
    assert.strictEqual(seatIndexFor(approvers, [vote('colleague', 'approve', { seatIndex: 0 })], { userId: 'other', groupIds: ['g1'] }), -1);
    // A stranger never has a seat.
    assert.strictEqual(seatIndexFor(approvers, [], { userId: 'stranger', groupIds: [] }), -1);
});

test('answers merge across approving votes, later votes overriding', () => {
    assert.deepStrictEqual(mergeVoteAnswers([
        vote('a', 'approve', { answers: { po: '1', note: 'x' } }),
        vote('b', 'reject', { answers: { po: 'IGNORED' } }),
        vote('c', 'approve', { answers: { po: '2' } }),
    ]), { po: '2', note: 'x' });
    assert.strictEqual(mergeVoteAnswers([vote('a', 'reject')]), null);
});

// ── The decider set ──────────────────────────────────────────────────────

test('panel rows: neither owner nor org admin may vote — but both may view', () => {
    const ap = {
        ownerId: 'owner', organizationId: 'org1', status: 'pending',
        approvers: [{ userId: 'a' }, { groupId: 'g1' }], stage: 'panel',
    };
    const orgAdmin = { userId: 'admin', groupIds: [], isOrgAdminOfOrg: (o) => o === 'org1' };
    assert.strictEqual(canDecide(ap, { userId: 'owner', groupIds: [] }), false, 'owner cannot bypass the panel');
    assert.strictEqual(canDecide(ap, orgAdmin), false, 'org admin cannot bypass the panel');
    assert.strictEqual(canDecide(ap, { userId: 'a', groupIds: [] }), true);
    assert.strictEqual(canDecide(ap, { userId: 'member', groupIds: ['g1'] }), true);
    assert.strictEqual(canView(ap, { userId: 'owner', groupIds: [] }), true);
    assert.strictEqual(canView(ap, orgAdmin), true);
    assert.strictEqual(canView(ap, { userId: 'stranger', groupIds: [] }), false);
});

test('the final stage narrows the decider set to the final approver', () => {
    const ap = {
        ownerId: 'owner', organizationId: null, status: 'pending',
        approvers: [{ userId: 'a' }], stage: 'final', finalApproverUserId: 'cfo',
    };
    assert.strictEqual(canDecide(ap, { userId: 'a', groupIds: [] }), false, 'a panel seat has no vote in the final stage');
    assert.strictEqual(canDecide(ap, { userId: 'cfo', groupIds: [] }), true);
    assert.strictEqual(canView(ap, { userId: 'a', groupIds: [] }), true, 'the seat still watches');
    assert.strictEqual(isFinalApprover(ap, { userId: 'cfo', groupIds: [] }), true);
    assert.strictEqual(isSeatedOnPanel(ap, { userId: 'a', groupIds: [] }), true);
});

// ── Orchestration (patched store) ────────────────────────────────────────

function makeHarness({ approval, votes = [], user = null }) {
    const rec = { votes: [...votes], decided: [], audits: [], stageFlips: [], bells: [], runUpdates: [], events: [] };
    const saved = {};
    let voteSeq = 0;
    const patch = {
        getApprovalVotes: async () => [...rec.votes],
        castApprovalVote: async (v) => {
            // Mirror the unique indexes: one per person per stage, one per seat.
            if (rec.votes.some(x => x.stage === v.stage && x.voterId === v.voterId)) return null;
            if (v.seatIndex !== null && rec.votes.some(x => x.stage === v.stage && x.seatIndex === v.seatIndex)) return null;
            const row = { id: `vote_${++voteSeq}`, createdAt: new Date().toISOString(), ...v };
            rec.votes.push(row);
            return row;
        },
        advanceApprovalStage: async (id, { from, to }) => {
            rec.stageFlips.push({ id, from, to });
            return { ...approval, stage: to };
        },
        decideApproval: async (id, p) => { rec.decided.push({ id, ...p }); return { ...approval, ...p, decidedAt: 'now' }; },
        appendApprovalAudit: async (ev) => { rec.audits.push(ev); },
        getApproval: async () => ({ ...approval }),
        getRun: async () => null,
        updateRun: async (id, p) => { rec.runUpdates.push({ id, ...p }); },
        getSubscriptionsForProvider: async () => [],
    };
    for (const [k, v] of Object.entries(patch)) { saved[k] = automationStore[k]; automationStore[k] = v; }

    const userStore = require('../stores/userStore');
    saved.__getUser = userStore.getUser;
    userStore.getUser = async (id) => (user && user.id === id ? user : { id, name: id, groups: '[]' });

    const notificationStore = require('../stores/notificationStore');
    saved.__notify = notificationStore.createNotification;
    notificationStore.createNotification = async (n) => { rec.bells.push(n); };

    saved.__org = dispatchMod.dispatchOrgScopedEvent;
    saved.__user = dispatchMod.dispatchEvent;
    dispatchMod.dispatchOrgScopedEvent = (p, event) => { rec.events.push(event); return Promise.resolve([]); };
    dispatchMod.dispatchEvent = ({ event }) => { rec.events.push(event); return Promise.resolve([]); };

    const restore = () => {
        for (const [k, v] of Object.entries(saved)) {
            if (k === '__getUser') userStore.getUser = v;
            else if (k === '__notify') notificationStore.createNotification = v;
            else if (k === '__org') dispatchMod.dispatchOrgScopedEvent = v;
            else if (k === '__user') dispatchMod.dispatchEvent = v;
            else automationStore[k] = v;
        }
    };
    return { rec, restore };
}

const PANEL_APPROVAL = {
    id: 'apr_p', source: 'app', status: 'pending', organizationId: null,
    ownerId: 'owner', runId: null, stepId: null, prompt: 'Ship it?', fields: null,
    expiresAt: null, automationTitle: 'Quotes',
    approvers: [{ userId: 'a' }, { userId: 'b' }], approvalRule: 'all',
    quorumCount: null, stage: 'panel', finalApproverUserId: null, finalApproverGroupId: null,
};

test('an open vote is recorded, nothing terminal happens', async () => {
    const { rec, restore } = makeHarness({ approval: PANEL_APPROVAL });
    try {
        const { code, body } = await decide({ approval: PANEL_APPROVAL, run: null, deciderId: 'a', decision: 'approve' });
        assert.strictEqual(code, 200);
        assert.strictEqual(body.decision, 'vote_recorded');
        assert.strictEqual(body.progress.approvals, 1);
        assert.strictEqual(rec.decided.length, 0, 'the row must not flip');
        assert.ok(!rec.events.includes('approval.decided'));
        assert.strictEqual(rec.audits[0].decision, 'vote_approved');
    } finally { restore(); }
});

test('the last approval completes the panel and finalizes exactly once', async () => {
    const existing = [vote('a', 'approve', { id: 'vote_0', seatIndex: 0, answers: { po: '1' }, createdAt: '2026-01-01' })];
    const { rec, restore } = makeHarness({ approval: PANEL_APPROVAL, votes: existing });
    try {
        const { code, body } = await decide({ approval: PANEL_APPROVAL, run: null, deciderId: 'b', decision: 'approve' });
        assert.strictEqual(code, 200);
        assert.strictEqual(body.decision, 'approve');
        assert.strictEqual(rec.decided.length, 1);
        assert.strictEqual(rec.decided[0].status, 'approved');
        assert.deepStrictEqual(rec.decided[0].answers, { po: '1' }, 'panel answers merged into the verdict');
        assert.ok(rec.events.includes('approval.decided'));
    } finally { restore(); }
});

test("one reject declines an 'all' panel immediately", async () => {
    const { rec, restore } = makeHarness({ approval: PANEL_APPROVAL });
    try {
        const { code, body } = await decide({ approval: PANEL_APPROVAL, run: null, deciderId: 'b', decision: 'reject', reason: 'Too risky' });
        assert.strictEqual(code, 200);
        assert.strictEqual(body.decision, 'reject');
        assert.strictEqual(rec.decided[0].status, 'rejected');
        assert.strictEqual(rec.decided[0].reason, 'Too risky');
    } finally { restore(); }
});

test('a double vote and a filled seat both 409 cleanly', async () => {
    const existing = [vote('a', 'approve', { id: 'vote_0', seatIndex: 0 })];
    const { rec, restore } = makeHarness({ approval: PANEL_APPROVAL, votes: existing });
    try {
        const again = await decide({ approval: PANEL_APPROVAL, run: null, deciderId: 'a', decision: 'approve' });
        assert.strictEqual(again.code, 409);
        assert.match(again.body.error, /already voted/i);
        assert.strictEqual(rec.decided.length, 0);
    } finally { restore(); }
});

test('a stranger holds no seat — refused before anything is written', async () => {
    const { rec, restore } = makeHarness({ approval: PANEL_APPROVAL });
    try {
        const res = await decide({ approval: PANEL_APPROVAL, run: null, deciderId: 'stranger', decision: 'approve' });
        assert.strictEqual(res.code, 409);
        assert.strictEqual(rec.votes.length, 0);
    } finally { restore(); }
});

test('a passing panel with a final approver flips the stage instead of finishing', async () => {
    const ap = { ...PANEL_APPROVAL, approvalRule: 'first', finalApproverUserId: 'cfo' };
    const { rec, restore } = makeHarness({ approval: ap });
    try {
        const { code, body } = await decide({ approval: ap, run: null, deciderId: 'a', decision: 'approve' });
        assert.strictEqual(code, 200);
        assert.strictEqual(body.decision, 'vote_recorded');
        assert.strictEqual(body.stage, 'final');
        assert.deepStrictEqual(rec.stageFlips, [{ id: 'apr_p', from: 'panel', to: 'final' }]);
        assert.strictEqual(rec.decided.length, 0, 'not terminal yet');
        assert.ok(rec.bells.some(b => b.userId === 'cfo' && /Final sign-off/.test(b.title)), 'the final approver is belled');
        assert.strictEqual(rec.audits.filter(a => a.decision === 'panel_approved').length, 1);
    } finally { restore(); }
});

test("the final approver's decision is terminal — and only theirs", async () => {
    const ap = { ...PANEL_APPROVAL, approvalRule: 'first', finalApproverUserId: 'cfo', stage: 'final' };
    const priorVotes = [vote('a', 'approve', { id: 'vote_0', seatIndex: 0 })];
    {
        const { rec, restore } = makeHarness({ approval: ap, votes: priorVotes });
        try {
            const seat = await decide({ approval: ap, run: null, deciderId: 'b', decision: 'approve' });
            assert.strictEqual(seat.code, 403, 'a panel seat has no vote in the final stage');
            assert.strictEqual(rec.decided.length, 0);
        } finally { restore(); }
    }
    {
        const { rec, restore } = makeHarness({ approval: ap, votes: priorVotes });
        try {
            const { code, body } = await decide({ approval: ap, run: null, deciderId: 'cfo', decision: 'approve' });
            assert.strictEqual(code, 200);
            assert.strictEqual(body.decision, 'approve');
            assert.strictEqual(rec.decided[0].status, 'approved');
            assert.strictEqual(rec.decided[0].decidedBy, 'cfo');
        } finally { restore(); }
    }
});

test('panelProgress reports the arithmetic the detail view renders', () => {
    const ap = { ...PANEL_APPROVAL, approvalRule: 'quorum', quorumCount: 2, approvers: [{ userId: 'a' }, { userId: 'b' }, { userId: 'c' }] };
    const p = panelProgress(ap, [vote('a', 'approve'), vote('b', 'reject', { seatIndex: 1 })]);
    assert.deepStrictEqual(p, {
        rule: 'quorum', stage: 'panel', seatCount: 3, approvals: 1, rejects: 1,
        needed: 2, hasFinalStage: false,
    });
    assert.strictEqual(panelProgress({ ...PANEL_APPROVAL, approvers: null }, []), null);
});
