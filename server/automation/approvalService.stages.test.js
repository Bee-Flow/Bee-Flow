/**
 * The stage CHAIN — sequential approvals end to end.
 *
 * What must hold, and why each matters:
 *   • only the CURRENT stage's people may vote; being asked later is not
 *     being asked now, and being asked earlier is not being asked still;
 *   • a stage that passes HANDS OVER — one conditional advance, one "your
 *     turn" announcement to the incoming stage and nobody else;
 *   • the last stage passing is what finishes the approval — the terminal
 *     machinery (resume / hook / event) fires exactly once, at the end;
 *   • a rejection at ANY stage ends the whole thing immediately;
 *   • the same person may hold seats in several stages and vote in each
 *     (per-stage vote uniqueness) — Microsoft forbids this; we should not.
 *
 * Run: node --test automation/approvalService.stages.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const automationStore = require('../stores/automationStore');
const dispatchMod = require('./triggerBus/dispatch');
const { decide, canDecide, canView, panelProgress } = require('./approvalService');

const STAGES = [
    { key: 's1', name: 'Cost-centre check', description: 'Team lead checks the budget line.',
      approvers: [{ userId: 'lead' }, { userId: 'lead2' }], rule: 'quorum', quorum: 2 },
    { key: 's2', name: 'Finance sign-off', description: 'Financial control releases it.',
      approvers: [{ groupId: 'g_fin' }], rule: 'first' },
    { key: 's3', name: 'CFO', description: null, approvers: [{ userId: 'cfo' }], rule: 'first' },
];

function staged(over = {}) {
    return {
        id: 'apr_chain', source: 'app', status: 'pending', organizationId: 'org1',
        ownerId: 'owner', runId: null, stepId: null, prompt: 'Pay invoice 42?',
        fields: null, expiresAt: null, automationTitle: 'Invoices',
        stages: STAGES, stage: 's1', ...over,
    };
}

function harness({ approval, votes = [], userGroups = {} }) {
    const rec = { votes: [...votes], decided: [], audits: [], advances: [], bells: [], events: [] };
    const saved = {};
    let seq = 0;
    let row = { ...approval };
    const patch = {
        getApprovalVotes: async () => [...rec.votes],
        castApprovalVote: async (v) => {
            // Mirror the two partial-unique indexes exactly.
            if (rec.votes.some(x => x.stage === v.stage && x.voterId === v.voterId)) return null;
            if (v.seatIndex !== null && rec.votes.some(x => x.stage === v.stage && x.seatIndex === v.seatIndex)) return null;
            const saved_ = { id: `v${++seq}`, createdAt: new Date(Date.now() + seq).toISOString(), ...v };
            rec.votes.push(saved_);
            return saved_;
        },
        advanceApprovalStage: async (id, opts) => {
            rec.advances.push({ id, ...opts });
            if (row.stage !== opts.from) return null;          // the conditional UPDATE
            row = { ...row, stage: opts.to };
            return { ...row };
        },
        decideApproval: async (id, p) => { rec.decided.push({ id, ...p }); return { ...row, ...p, decidedAt: 'now' }; },
        appendApprovalAudit: async (ev) => { rec.audits.push(ev); },
        getApproval: async () => ({ ...row }),
        getRun: async () => null,
        updateRun: async () => {},
        getSubscriptionsForProvider: async () => [],
    };
    for (const [k, v] of Object.entries(patch)) { saved[k] = automationStore[k]; automationStore[k] = v; }

    const userStore = require('../stores/userStore');
    saved.__u = userStore.getUser;
    userStore.getUser = async (id) => ({ id, name: id, groups: JSON.stringify(userGroups[id] || []) });
    saved.__all = userStore.getAllUsers;
    userStore.getAllUsers = async () => Object.entries(userGroups).map(([id, gs]) => ({ id, groups: JSON.stringify(gs) }));

    const notificationStore = require('../stores/notificationStore');
    saved.__n = notificationStore.createNotification;
    notificationStore.createNotification = async (n) => { rec.bells.push(n); };

    saved.__o = dispatchMod.dispatchOrgScopedEvent;
    saved.__e = dispatchMod.dispatchEvent;
    dispatchMod.dispatchOrgScopedEvent = (p, event) => { rec.events.push(event); return Promise.resolve([]); };
    dispatchMod.dispatchEvent = ({ event }) => { rec.events.push(event); return Promise.resolve([]); };

    const restore = () => {
        for (const [k, v] of Object.entries(saved)) {
            if (k === '__u') userStore.getUser = v;
            else if (k === '__all') userStore.getAllUsers = v;
            else if (k === '__n') notificationStore.createNotification = v;
            else if (k === '__o') dispatchMod.dispatchOrgScopedEvent = v;
            else if (k === '__e') dispatchMod.dispatchEvent = v;
            else automationStore[k] = v;
        }
    };
    return { rec, restore, current: () => row };
}

// ── Authorization ────────────────────────────────────────────────────────

test('only the CURRENT stage may act — later and earlier seats cannot', () => {
    const a = staged();
    assert.strictEqual(canDecide(a, { userId: 'lead', groupIds: [] }), true);
    assert.strictEqual(canDecide(a, { userId: 'cfo', groupIds: [] }), false, 'stage 3 has no vote during stage 1');
    assert.strictEqual(canDecide(a, { userId: 'member', groupIds: ['g_fin'] }), false, 'stage 2 waits its turn');

    const atS2 = staged({ stage: 's2' });
    assert.strictEqual(canDecide(atS2, { userId: 'member', groupIds: ['g_fin'] }), true);
    assert.strictEqual(canDecide(atS2, { userId: 'lead', groupIds: [] }), false, 'a finished stage does not vote again');
});

test('everyone the chain concerns may WATCH throughout — owner, admin, every seat', () => {
    const a = staged();
    const admin = { userId: 'admin', groupIds: [], isOrgAdminOfOrg: (o) => o === 'org1' };
    for (const v of [{ userId: 'owner', groupIds: [] }, admin,
                     { userId: 'cfo', groupIds: [] }, { userId: 'x', groupIds: ['g_fin'] }]) {
        assert.strictEqual(canView(a, v), true, `${v.userId} should watch`);
    }
    assert.strictEqual(canView(a, { userId: 'stranger', groupIds: [] }), false);
    // Watching is not deciding.
    assert.strictEqual(canDecide(a, { userId: 'owner', groupIds: [] }), false, 'the owner cannot bypass a chain');
    assert.strictEqual(canDecide(a, admin), false, 'nor can an org admin');
});

// ── Walking the chain ────────────────────────────────────────────────────

test('a stage completes, hands over, and announces to the NEXT stage only', async () => {
    const a = staged();
    const h = harness({ approval: a, userGroups: { member: ['g_fin'], lead: [], lead2: [], cfo: [] } });
    try {
        // Quorum of 2: the first vote leaves the stage open.
        const first = await decide({ approval: a, run: null, deciderId: 'lead', decision: 'approve' });
        assert.strictEqual(first.body.decision, 'vote_recorded');
        assert.strictEqual(h.rec.advances.length, 0);
        assert.strictEqual(h.rec.decided.length, 0);

        // The second completes it → advance to s2.
        const second = await decide({ approval: h.current(), run: null, deciderId: 'lead2', decision: 'approve' });
        assert.strictEqual(second.body.decision, 'vote_recorded');
        assert.strictEqual(second.body.stage, 's2');
        assert.deepStrictEqual(h.rec.advances.map(x => [x.from, x.to]), [['s1', 's2']]);
        assert.strictEqual(h.rec.decided.length, 0, 'handing over is not finishing');
        assert.ok(h.rec.audits.some(x => x.decision === 'stage_passed'));
        // Only the incoming stage hears about it.
        const told = h.rec.bells.filter(b => /Your approval is needed/.test(b.title));
        assert.deepStrictEqual(told.map(b => b.userId), ['member']);
        assert.match(told[0].title, /Finance sign-off/);
        assert.match(told[0].message, /step 2 of 3/);
    } finally { h.restore(); }
});

test('the LAST stage passing is what finishes the approval — once', async () => {
    const a = staged({ stage: 's3' });
    const h = harness({ approval: a, votes: [
        { id: 'v0', stage: 's1', seatIndex: 0, voterId: 'lead', decision: 'approve', answers: { po: '1' }, createdAt: '2026-01-01' },
    ] });
    try {
        const res = await decide({ approval: a, run: null, deciderId: 'cfo', decision: 'approve' });
        assert.strictEqual(res.code, 200);
        assert.strictEqual(res.body.decision, 'approve');
        assert.strictEqual(h.rec.decided.length, 1);
        assert.strictEqual(h.rec.decided[0].status, 'approved');
        assert.deepStrictEqual(h.rec.decided[0].answers, { po: '1' }, 'answers merge across the whole chain');
        assert.ok(h.rec.events.includes('approval.decided'), 'the event fires exactly at the end');
        assert.strictEqual(h.rec.advances.length, 0);
    } finally { h.restore(); }
});

test('a rejection at ANY stage ends the whole chain immediately', async () => {
    for (const stage of ['s1', 's2', 's3']) {
        const a = staged({ stage });
        const h = harness({ approval: a, userGroups: { member: ['g_fin'] } });
        const voter = stage === 's1' ? 'lead' : (stage === 's2' ? 'member' : 'cfo');
        try {
            const res = await decide({ approval: a, run: null, deciderId: voter, decision: 'reject', reason: 'No budget' });
            assert.strictEqual(res.body.decision, 'reject', `${stage} reject should be terminal`);
            assert.strictEqual(h.rec.decided[0].status, 'rejected');
            assert.strictEqual(h.rec.decided[0].reason, 'No budget');
            assert.strictEqual(h.rec.advances.length, 0, 'a rejected chain never advances');
        } finally { h.restore(); }
    }
});

test('the same person may sit in several stages and vote in each', async () => {
    const stages = [
        { key: 's1', name: 'Team', approvers: [{ userId: 'dual' }], rule: 'first' },
        { key: 's2', name: 'Board', approvers: [{ userId: 'dual' }], rule: 'first' },
    ];
    const a = staged({ stages, stage: 's1' });
    const h = harness({ approval: a });
    try {
        const one = await decide({ approval: a, run: null, deciderId: 'dual', decision: 'approve' });
        assert.strictEqual(one.body.stage, 's2', 'stage 1 passed');
        const two = await decide({ approval: h.current(), run: null, deciderId: 'dual', decision: 'approve' });
        assert.strictEqual(two.body.decision, 'approve', 'the same person votes again in stage 2');
        assert.strictEqual(h.rec.decided.length, 1);
    } finally { h.restore(); }
});

test('a double vote in one stage 409s; a stranger to the stage 403s', async () => {
    const a = staged();
    const h = harness({ approval: a, votes: [
        { id: 'v0', stage: 's1', seatIndex: 0, voterId: 'lead', decision: 'approve', createdAt: '2026-01-01' },
    ] });
    try {
        const again = await decide({ approval: a, run: null, deciderId: 'lead', decision: 'approve' });
        assert.strictEqual(again.code, 409);
        assert.match(again.body.error, /already voted in "Cost-centre check"/);

        const wrongTurn = await decide({ approval: a, run: null, deciderId: 'cfo', decision: 'approve' });
        assert.strictEqual(wrongTurn.code, 403);
        assert.match(wrongTurn.body.error, /Cost-centre check/, 'the error names the stage that IS waiting');
        assert.strictEqual(h.rec.decided.length, 0);
    } finally { h.restore(); }
});

test('two votes that both complete a stage: exactly one advances', async () => {
    // Both callers read the row at s1 and vote; the conditional UPDATE means
    // the second advance attempt returns null and must not double-announce.
    const a = staged({ stages: [
        { key: 's1', name: 'Pair', approvers: [{ userId: 'a' }, { userId: 'b' }], rule: 'first' },
        { key: 's2', name: 'Next', approvers: [{ userId: 'c' }], rule: 'first' },
    ] });
    const h = harness({ approval: a });
    try {
        const [r1, r2] = await Promise.all([
            decide({ approval: a, run: null, deciderId: 'a', decision: 'approve' }),
            decide({ approval: a, run: null, deciderId: 'b', decision: 'approve' }),
        ]);
        assert.ok([r1.code, r2.code].every(c => c === 200));
        const realAdvances = h.rec.advances.filter(x => x.from === 's1');
        assert.ok(realAdvances.length >= 1);
        // Whatever the interleaving, the row advanced once and only once.
        assert.strictEqual(h.current().stage, 's2');
        const announces = h.rec.bells.filter(b => /Your approval is needed/.test(b.title));
        assert.strictEqual(announces.length, 1, 'the incoming stage is told exactly once');
    } finally { h.restore(); }
});

// ── The timeline the UI renders ──────────────────────────────────────────

test('progress is the whole timeline, with each stage in its own state', () => {
    const a = staged({ stage: 's2' });
    const votes = [
        { stage: 's1', voterId: 'lead', decision: 'approve', createdAt: '1' },
        { stage: 's1', voterId: 'lead2', decision: 'approve', createdAt: '2' },
    ];
    const p = panelProgress(a, votes);
    assert.strictEqual(p.kind, 'stages');
    assert.strictEqual(p.stage, 's2');
    assert.deepStrictEqual(p.position, { index: 2, total: 3 });
    assert.deepStrictEqual(p.stages.map(s => [s.name, s.state]), [
        ['Cost-centre check', 'done'],
        ['Finance sign-off', 'current'],
        ['CFO', 'waiting'],
    ]);
    assert.strictEqual(p.stages[0].approvals, 2);
    assert.strictEqual(p.stages[0].needed, 2);
    assert.strictEqual(p.stages[0].votes.length, 2);
    assert.strictEqual(p.stages[1].description, 'Financial control releases it.');
});

test('a skipped stage reads as skipped, and a stage never reached says so', () => {
    const stages = [
        { key: 's1', name: 'Team', approvers: [{ userId: 'a' }], rule: 'first' },
        { key: 's2', name: 'Big amounts', approvers: [{ userId: 'cfo' }], rule: 'first', skipped: true },
    ];
    const open = panelProgress(staged({ stages, stage: 's1' }), []);
    assert.deepStrictEqual(open.stages.map(s => s.state), ['current', 'skipped']);
    assert.deepStrictEqual(open.position, { index: 1, total: 1 }, 'a skipped stage is not counted in the total');

    const rejected = panelProgress(staged({ stages, stage: 's1', status: 'rejected' }), [
        { stage: 's1', voterId: 'a', decision: 'reject', createdAt: '1' },
    ]);
    assert.deepStrictEqual(rejected.stages.map(s => s.state), ['done', 'skipped']);
});
