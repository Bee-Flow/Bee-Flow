'use strict';

/**
 * A PRODUCTION FORM JOURNEY THAT WAITS ON A PERSON, END TO END (WI-12, D4c;
 * critic gap "form -> approval -> form page"), against a real Postgres
 * (PGlite behind db.js), the real form routes, the real form queue, the real
 * runner and the real approval service. Only the outbound e-mail is recorded
 * instead of sent.
 *
 * The story: a colleague fills in page one; the automation pauses on an
 * approval; the visitor's poll says `waiting_decision` (not "working", which
 * gave up after five minutes); nine hours pass (past the old 8 h session
 * life); the owner approves; the run pauses on page two, and the submitter is
 * told once, by bell and e-mail, with their own /f/<token>?s=<sid> link; that
 * session is still valid, page two is served, answered, and the journey ends.
 *
 * Run: cd server && node --test routes/automation/formPublic/formJourney.e2e.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'form-journey-e2e-session-secret-0123456789abcdef';
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'form-journey-e2e-master-key-0123456789abcdef0123';

// The real db.js, answered by one PGlite connection; before any store loads.
const { usePglitePool } = require('../../../testUtils/pglitePool');
const { pg, close: closePg } = usePglitePool();

const h = require('../../../testUtils/routeHarness');
const { makeSwaps } = require('../../../testUtils/swaps');

h.openGates();

const ORG = 'org-journey';
const OWNER = { id: 'u-journey-owner', username: 'owner', email: 'owner@journey.test', organizationId: ORG, role: 'user', orgRole: 'member', groups: [] };
const VISITOR = { id: 'u-journey-visitor', username: 'visitor', email: 'visitor@journey.test', organizationId: ORG, role: 'user', orgRole: 'member', groups: [] };
const HOUR = 3600_000;

const DEFINITION = {
    trigger: {
        id: 'trg', kind: 'form',
        form: { title: 'Request a quote', fields: [{ name: 'item', type: 'text', label: 'What do you need?', required: true }] },
    },
    steps: [
        { id: 'gate', type: 'approval', prompt: 'Quote for {{trigger.output.item}}?' },
        { id: 'fp2', type: 'form_page', mode: 'input', form: { title: 'Delivery', fields: [{ name: 'address', type: 'text', label: 'Delivery address', required: true }] } },
        { id: 'done', type: 'set', fields: { address: { kind: 'ref', path: 'steps.fp2.output.address' } } },
    ],
    edges: [{ from: 'trg', to: 'gate' }, { from: 'gate', to: 'fp2' }, { from: 'fp2', to: 'done' }],
};

const { swap, restore } = makeSwaps();
const mails = [];
let api;
let automation;
let token;

before(async () => {
    const userStore = require('../../../stores/userStore');
    await userStore.initDB();
    const plan = await userStore.createPlan({ name: 'Journey plan', tier: 'pro', allowed_features: ['automations'] });
    await userStore.createOrganization({ id: ORG, name: 'Journey org' }, { autoGrantTrial: false });
    await userStore.setOrgSubscription(ORG, { plan_id: plan.id, status: 'active' });
    for (const u of [OWNER, VISITOR]) await userStore.createUser({ ...u, passwordHash: 'x' });

    const automationStore = require('../../../stores/automationStore');
    await automationStore.initDB();
    // Boot-ladder migrations the store's own init does not run: who submitted a form run.
    const quiet = swap(console, 'log', () => {});
    try { await require('../../../migrations/automation-form-submitter-2026-09').up(); } finally { quiet(); }
    await require('../../../stores/notificationStore').initDB();

    // The ports boot/featureRegistrations.js fills in the server.
    require('../../../automation/runnerPorts');
    require('../../../integrations/runnerPorts');
    require('../../../services/runnerPorts');

    // The service mailbox: connected, and every mail recorded instead of sent.
    const mail = require('../../../utils/emailService');
    swap(mail, 'getServiceEmailConfig', async () => ({ configured: true }));
    swap(mail, 'sendServiceEmail', async (m) => { mails.push(m); return { success: true }; });

    const created = await automationStore.createAutomation({
        userId: OWNER.id, organizationId: ORG, title: 'Quote requests', definition: DEFINITION, triggerType: 'form',
    });
    await automationStore.updateAutomation(created.id, { isActive: true, isDraft: false }, OWNER.id);
    automation = await automationStore.getAutomation(created.id);
    const page = await automationStore.ensureFormPage(automation.id);
    await automationStore.setFormPageAudience(page.id, automation.id, { audience: 'org', sharedGroups: [], sharedUserIds: [] });
    token = page.id;

    api = h.serve('/api/automation', require('../formPublic'), { user: VISITOR });
}, { timeout: 120_000 });

after(async () => {
    restore();
    if (api) await api.close();
    await closePg();
});

/** Poll the visitor's session until `done(body)` says so (the run is in-process and quick). */
async function pollUntil(sid, done, label) {
    let body = null;
    for (let i = 0; i < 400; i += 1) {
        const res = await api.call('GET', `/api/automation/form/${token}/s/${sid}`);
        assert.strictEqual(res.status, 200, res.text);
        body = res.body;
        if (done(body)) return body;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`${label}: still ${JSON.stringify(body)}`);
}

async function sessionRow(sid) {
    const { rows } = await pg.query('SELECT expires_at FROM automation_form_sessions WHERE id = $1', [sid]);
    return rows[0];
}

/** Nine hours pass: every clock the journey stored moves back by nine hours. */
async function nineHoursPass() {
    await pg.exec(`
        UPDATE automation_form_sessions SET expires_at = expires_at - INTERVAL '9 hours', updated_at = updated_at - INTERVAL '9 hours', created_at = created_at - INTERVAL '9 hours';
        UPDATE automation_runs SET awaiting_step_expires_at = awaiting_step_expires_at - INTERVAL '9 hours', started_at = started_at - INTERVAL '9 hours';
        UPDATE automation_approvals SET expires_at = expires_at - INTERVAL '9 hours', created_at = created_at - INTERVAL '9 hours';
    `);
}

test('form -> approval -> 9 h -> approve -> page 2 on the same link -> done; the submitter is told once', { timeout: 120_000 }, async () => {
    const automationStore = require('../../../stores/automationStore');

    // ── Page one ─────────────────────────────────────────────────────────
    const form = await api.call('GET', `/api/automation/form/${token}`);
    assert.strictEqual(form.status, 200, form.text);
    const submitted = await api.call('POST', `/api/automation/form/${token}`, {
        body: { item: 'Ten pallets', csrf: form.body.csrf, issuedAt: Date.now() - 10_000, nonce: 'journey-page-one' },
    });
    assert.strictEqual(submitted.status, 202, submitted.text);
    const sid = submitted.body.sessionId;

    // ── The approval: the visitor is told to wait for a person, not "working" ──
    const waiting = await pollUntil(sid, (b) => b.state !== 'working', 'page one');
    assert.deepStrictEqual(waiting, { state: 'waiting_decision', notify: true });
    const root = (await automationStore.getRunsForAutomation(automation.id, { limit: 5 })).find((r) => r.status === 'awaiting_approval')
        || null;
    assert.ok(root, 'the run paused on the approval');
    assert.strictEqual(root.submittedByUserId, VISITOR.id);
    // The session is held to the approval's deadline + 1 h, far past the 8 h idle limit.
    const held = new Date((await sessionRow(sid)).expires_at).getTime();
    assert.ok(held >= Date.parse(root.awaitingStepExpiresAt) + HOUR - 5000, `session ${new Date(held).toISOString()} vs deadline ${root.awaitingStepExpiresAt}`);
    assert.strictEqual(mails.length, 0, 'nobody mails the visitor about an approval they were just told about');

    // ── Nine hours later the session still answers (8 h would have expired it) ──
    await nineHoursPass();
    assert.deepStrictEqual(await pollUntil(sid, () => true, 'after 9 h'), { state: 'waiting_decision', notify: true });

    // ── The owner approves ───────────────────────────────────────────────
    const approval = await automationStore.getApprovalForRunStep(root.id, 'gate', { pendingOnly: true });
    assert.ok(approval, 'the approval row exists');
    const decided = await require('../../../automation/approvalService').decide({
        approval, run: await automationStore.getRun(root.id), deciderId: OWNER.id, decision: 'approve',
    });
    assert.ok([200, 202].includes(decided.code), JSON.stringify(decided.body));

    // ── Page two on the same link ────────────────────────────────────────
    const page2 = await pollUntil(sid, (b) => b.state === 'form', 'after the approval');
    assert.strictEqual(page2.form.title, 'Delivery');
    const leg2 = await automationStore.getLatestRunInChain(root.id);
    assert.strictEqual(leg2.status, 'awaiting_form');
    // A page due after a decision waits days, not the step default of one hour.
    assert.ok(Date.parse(leg2.awaitingStepExpiresAt) - Date.now() > 6 * 24 * HOUR, leg2.awaitingStepExpiresAt);

    // The submitter is told exactly once: one bell, one e-mail, their link and nothing else.
    const link = `/f/${token}?s=${sid}`;
    const { rows: bells } = await pg.query('SELECT user_id, title, message, link FROM notifications WHERE link = $1', [link]);
    assert.deepStrictEqual(bells.map((b) => ({ ...b })), [{
        user_id: VISITOR.id, title: 'Request a quote: the next page is ready', message: 'Open the form to continue where you left off.', link,
    }]);
    assert.strictEqual(mails.length, 1);
    assert.strictEqual(mails[0].to, VISITOR.email);
    assert.strictEqual(mails[0].subject, 'Request a quote: the next page is ready');
    assert.ok(mails[0].text.endsWith(link), mails[0].text);
    assert.ok(!mails[0].text.includes('Ten pallets'), 'no answer travels in the mail');
    const { rows: ledger } = await pg.query(`SELECT channel FROM automation_notification_events WHERE run_id = $1 AND event = 'onFormPageDue' ORDER BY channel`, [leg2.id]);
    assert.deepStrictEqual(ledger.map((r) => r.channel), ['bell', 'email']);

    // ── Page two answered: the journey ends ──────────────────────────────
    const answered = await api.call('POST', `/api/automation/form/${token}/s/${sid}`, {
        body: { address: 'Dock 4', csrf: page2.csrf, issuedAt: Date.now() - 10_000, nonce: 'journey-page-two' },
    });
    assert.strictEqual(answered.status, 202, answered.text);
    const end = await pollUntil(sid, (b) => b.state !== 'working', 'page two');
    assert.strictEqual(end.state, 'done', JSON.stringify(end));
    const last = await automationStore.getLatestRunInChain(root.id);
    const steps = await automationStore.getRunSteps(last.id);
    assert.deepStrictEqual(steps.find((s) => s.stepId === 'done')?.output, { address: 'Dock 4' });
    assert.strictEqual(mails.length, 1, 'still one mail');
});
