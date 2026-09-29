'use strict';

/**
 * Delivering an approval card into Nextcloud.
 *
 * What must hold:
 *   • the card TELLS THE TRUTH about what a reaction can do — 👍 approves,
 *     👎 cannot decline (a rejection needs a reason), and a request carrying
 *     approver questions cannot be answered by an emoji at all. A capability
 *     the reader discovers by having it fail is a bug report;
 *   • every attempt lands in the delivery ledger, success or failure, because
 *     the ledger row is BOTH the evidence a card was sent and the only way an
 *     inbound reaction can be routed back to the approval;
 *   • a Talk card is posted ONCE into a conversation, not once per approver;
 *   • the user-identity fallback passes the Nextcloud scope guard — posting
 *     into a room the owner excluded is a write they asked us not to make.
 *
 *   • nothing personal leaves for Nextcloud (BFSF-441): the card and the bell
 *     carry the routine name, the event, the role and the link, never the
 *     prompt, details, questions, answers, attachments or context.
 *
 * Run: cd server && node --test automation/approvalDelivery.test.js
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

// ── Test doubles ────────────────────────────────────────────────────────────
const rec = { ledger: [], botPosts: [], botReactions: [], chatPosts: [], notifications: [], scopeDenied: false };

let storedAutomation = null;
mock(path.join(SERVER, 'stores/automationStore'), {
    recordApprovalDelivery: async (row) => { rec.ledger.push(row); return { id: `dlv_${rec.ledger.length}`, ...row }; },
    getApprovalDeliveries: async () => [],
    getPendingTalkDeliveries: async () => [],
    getAutomation: async (id) => (storedAutomation && storedAutomation.id === id ? storedAutomation : null),
});
const inAppBells = [];
mock(path.join(SERVER, 'stores/notificationStore'), {
    createNotification: async (n) => { inAppBells.push(n); return { id: `n${inAppBells.length}` }; },
});
let orgRoom = null;
mock(path.join(SERVER, 'stores/configStore'), {
    getConfig: async (key) => (key === 'nc_approvals_talk_room_org1' ? orgRoom : null),
    getSecret: async () => null,
});
mock(path.join(SERVER, 'stores/userStore'), {
    getUser: async (id) => ({ id, nc_uid: id === 'nobody' ? null : `nc-${id}` }),
});
mock(path.join(SERVER, 'core/automationRunner/engine'), {
    resolveUserSession: async () => ({ user: { id: 'owner' } }),
});
let ncFetchImpl = async () => ({ ok: true, status: 201, json: async () => ({ ocs: { data: { id: 4242 } } }) });
let noUserIdentity = false;
mock(path.join(SERVER, 'integrations/nextcloudClient'), {
    resolveAuth: async () => {
        if (noUserIdentity) throw new Error('Nextcloud not connected.');
        return {
            baseUrl: 'https://cloud.example',
            fetch: (url, opts) => { rec.chatPosts.push({ url, opts }); return ncFetchImpl(url, opts); },
        };
    },
    getBaseUrl: async () => 'https://org-configured.example',
});
mock(path.join(SERVER, 'core/integrations/ncScopeGuard'), {
    checkToolCall: async () => (rec.scopeDenied ? { nc_scope_denied: true } : null),
});
let botSecret = null;
let botPostResult = { ok: true, status: 201, referenceId: 'ref-1' };
let foundMessageId = '1567';
mock(path.join(SERVER, 'integrations/nextcloudTalkBot'), {
    TALK_V1: '/ocs/v2.php/apps/spreed/api/v1',
    MAX_MESSAGE_CHARS: 30_000,
    getBotSecret: async () => botSecret,
    postBotMessage: async (args) => { rec.botPosts.push(args); return botPostResult; },
    postBotReaction: async (args) => { rec.botReactions.push(args); return { ok: true, status: 201 }; },
    // Mirrors the real one: the id lookup is a READ, so it needs a
    // user/connector identity and answers null without one.
    findMessageIdByReference: async ({ ncFetch }) => (typeof ncFetch === 'function' ? foundMessageId : null),
    listMessageReactions: async () => [],
});
let notifyResult = { ok: true, apiVersion: 'v3', status: 200 };
mock(path.join(SERVER, 'integrations/nextcloudAdminNotify'), {
    sendAdminNotification: async (args) => { rec.notifications.push(args); return notifyResult; },
});

const delivery = require('./approvalDelivery');

function reset() {
    rec.ledger = []; rec.botPosts = []; rec.botReactions = [];
    rec.chatPosts = []; rec.notifications = []; rec.scopeDenied = false;
    orgRoom = null; botSecret = null;
    botPostResult = { ok: true, status: 201, referenceId: 'ref-1' };
    foundMessageId = '1567';
    notifyResult = { ok: true, apiVersion: 'v3', status: 200 };
    noUserIdentity = false;
    ncFetchImpl = async () => ({ ok: true, status: 201, json: async () => ({ ocs: { data: { id: 4242 } } }) });
}

const STAGES = [
    { key: 's1', name: 'Cost-centre check', approvers: [{ userId: 'lead' }], rule: 'first' },
    { key: 's2', name: 'Finance sign-off', description: 'Financial control releases it.', approvers: [{ userId: 'fin' }], rule: 'first' },
    { key: 's3', name: 'CFO', approvers: [{ userId: 'cfo' }], rule: 'first' },
];

function approval(over = {}) {
    return {
        id: 'apr_1', status: 'pending', organizationId: 'org1', ownerId: 'owner',
        automationTitle: 'Invoices', prompt: 'Pay invoice INV-2026-0142 (€4,210.00)?',
        fields: null, runId: null, stepId: null, stages: null, stage: null,
        context: null, ...over,
    };
}

// ── The card ────────────────────────────────────────────────────────────────

test('the card states what 👍 does AND that declining has to happen in the app', () => {
    const card = delivery.buildApprovalCard({
        approval: approval(), automationTitle: 'Invoices', url: 'https://app.example/app/studio/approvals/apr_1',
    });
    assert.match(card, /Invoices needs an approval/);
    assert.match(card, /React 👍 to approve/);
    // The asymmetry has to read as a property of declining, not as a gap.
    assert.match(card, /declining needs a reason/i);
    assert.ok(card.endsWith('👉 https://app.example/app/studio/approvals/apr_1'), 'the deep link is the last line');
});

test('the card uses no dash as punctuation', () => {
    for (const a of [approval(), approval({ fields: [{ key: 'q', type: 'text', label: 'Why?' }] })]) {
        const card = delivery.buildApprovalCard({ approval: a, url: 'https://app.example/x' });
        assert.ok(!/[–—]/.test(card), card);
    }
});

test('the emoji the card asks for is the emoji the ingest counts', () => {
    // Two modules, one contract. A card that says "React 👍" while the ingest
    // only accepts ✅ is a feature that looks like it works and never does.
    const { classifyReaction } = require('./approvalReactionIngest');
    assert.equal(classifyReaction(delivery.APPROVE_EMOJI), 'approve');
    assert.equal(classifyReaction(delivery.REJECT_EMOJI), 'reject');
});

test('the card names the stage and its place in the chain, but not the stage description', () => {
    const a = approval({ stages: STAGES, stage: 's2' });
    const approvalService = require('./approvalService');
    const stage = approvalService.currentStage(a);
    const { stagePosition } = require('./approvalStages');
    const card = delivery.buildApprovalCard({
        approval: a, url: 'https://app.example/x', stage, position: stagePosition(a.stages, 's2'),
    });
    assert.match(card, /Step 2 of 3: Finance sign-off/);
    assert.ok(!card.includes('Financial control releases it'), 'a description is free text; it stays in Bee Flow');
});

test('a request with approver questions never offers the 👍 shortcut', () => {
    const card = delivery.buildApprovalCard({
        approval: approval({ fields: [{ key: 'cost_centre', type: 'text', label: 'Cost centre' }] }),
        url: 'https://app.example/x',
    });
    assert.ok(!/React 👍/.test(card), 'an emoji cannot carry answers, so it must not be offered');
    assert.match(card, /asks a few questions/);
    assert.ok(!card.includes('Cost centre'), 'the questions themselves stay in Bee Flow');
});

test('an oversized prompt changes nothing: the card never carries it', () => {
    const card = delivery.buildApprovalCard({
        approval: approval({ prompt: 'x'.repeat(40_000) }), url: 'https://app.example/x',
    });
    assert.ok(card.length < 1_000, `card was ${card.length} chars`);
    assert.ok(!card.includes('xxxx'));
    assert.ok(card.endsWith('👉 https://app.example/x'));
});

test('an oversized routine or stage name is capped to one line', () => {
    const a = approval({ stages: [{ key: 's1', name: 'n\n'.repeat(500), approvers: [{ userId: 'x' }], rule: 'first' }], stage: 's1' });
    const approvalService = require('./approvalService');
    const card = delivery.buildApprovalCard({
        approval: a, automationTitle: 't'.repeat(5_000), url: 'https://app.example/x',
        stage: approvalService.currentStage(a), position: { index: 1, total: 1 },
    });
    assert.ok(card.length < 1_000, `card was ${card.length} chars`);
    assert.ok(card.endsWith('👉 https://app.example/x'));
});

// ── Which conversation ──────────────────────────────────────────────────────

test('the room comes from the automation, then the request, then the org default', async () => {
    reset();
    orgRoom = 'org-room';
    assert.equal(await delivery.resolveTalkRoom({ orgId: 'org1' }), 'org-room');
    assert.equal(await delivery.resolveTalkRoom({
        orgId: 'org1', approval: approval({ context: { ncTalkRoom: 'ctx-room' } }),
    }), 'ctx-room');
    assert.equal(await delivery.resolveTalkRoom({
        orgId: 'org1',
        approval: approval({ context: { ncTalkRoom: 'ctx-room' } }),
        automation: { definition: { notificationSettings: { onApproval: { ncTalkRoom: 'auto-room' } } } },
    }), 'auto-room');
});

test('no configured room means no Talk delivery — never an invented one', async () => {
    reset();
    assert.equal(await delivery.resolveTalkRoom({ orgId: 'org1' }), null);
    const report = await delivery.deliverApprovalToNextcloud({
        approval: approval(), channels: ['inapp', 'nc_talk'],
    });
    assert.equal(report.talk.ok, false);
    assert.equal(rec.botPosts.length, 0);
    assert.equal(rec.chatPosts.length, 0);
});

// ── Posting ─────────────────────────────────────────────────────────────────

test('with a bot secret the card is posted AS THE BOT and its id recovered afterwards', async () => {
    reset();
    orgRoom = 'room1';
    botSecret = 'S'.repeat(64);
    const report = await delivery.deliverApprovalToNextcloud({
        approval: approval(), automation: { id: 'a1', title: 'Invoices', userId: 'owner' },
        channels: ['inapp', 'nc_talk'],
    });
    assert.equal(report.talk.ok, true);
    assert.equal(report.talk.via, 'bot');
    assert.equal(rec.botPosts.length, 1);
    assert.equal(rec.chatPosts.length, 0, 'the bot path must not also post as a user');

    // The ledger row is what makes the reaction routable.
    const row = rec.ledger.find(r => r.channel === 'nc_talk');
    assert.equal(row.status, 'sent');
    assert.equal(row.approvalId, 'apr_1');
    assert.equal(row.externalRef.roomToken, 'room1');
    assert.equal(row.externalRef.messageId, '1567');
    assert.equal(row.externalRef.via, 'bot');
});

test('a bot card whose id cannot be recovered is still a delivery, minus the reactions', async () => {
    reset();
    orgRoom = 'room1';
    botSecret = 'S'.repeat(64);
    foundMessageId = null;                       // no read auth / message out of window
    await delivery.deliverApprovalToNextcloud({ approval: approval(), channels: ['nc_talk'] });
    const row = rec.ledger.find(r => r.channel === 'nc_talk');
    assert.equal(row.status, 'sent');
    assert.equal(row.externalRef.messageId, undefined,
        'no message id means no reaction routing — the row must say so rather than invent one');
    assert.equal(rec.botReactions.length, 0, 'nothing to seed a 👍 on');
});

test('the bot seeds the 👍 so approving is one tap', async () => {
    reset();
    orgRoom = 'room1';
    botSecret = 'S'.repeat(64);
    await delivery.deliverApprovalToNextcloud({ approval: approval(), channels: ['nc_talk'] });
    assert.equal(rec.botReactions.length, 1);
    assert.equal(rec.botReactions[0].reaction, '👍');
    assert.equal(rec.botReactions[0].messageId, '1567');
});

test('a question-carrying request gets no seeded 👍 — it would be a lie', async () => {
    reset();
    orgRoom = 'room1';
    botSecret = 'S'.repeat(64);
    await delivery.deliverApprovalToNextcloud({
        approval: approval({ fields: [{ key: 'q', type: 'text', label: 'Why?' }] }),
        channels: ['nc_talk'],
    });
    assert.equal(rec.botReactions.length, 0);
});

test('without a bot secret the card is posted as the owner and the id read from the 201', async () => {
    reset();
    orgRoom = 'room1';
    const report = await delivery.deliverApprovalToNextcloud({ approval: approval(), channels: ['nc_talk'] });
    assert.equal(report.talk.ok, true);
    assert.equal(report.talk.via, 'user');
    assert.equal(rec.botPosts.length, 0);
    assert.equal(rec.chatPosts.length, 1);
    assert.match(rec.chatPosts[0].url, /\/apps\/spreed\/api\/v1\/chat\/room1/);
    const row = rec.ledger.find(r => r.channel === 'nc_talk');
    assert.equal(row.externalRef.messageId, '4242');
    assert.equal(row.externalRef.via, 'user');
});

test('the bot posts with no user identity at all — a URL and a secret is the whole requirement', async () => {
    reset();
    orgRoom = 'room1';
    botSecret = 'S'.repeat(64);
    noUserIdentity = true;                       // nobody has connected a personal account
    const report = await delivery.deliverApprovalToNextcloud({ approval: approval(), channels: ['nc_talk'] });
    assert.equal(report.talk.ok, true);
    assert.equal(report.talk.via, 'bot');
    assert.equal(rec.botPosts[0].baseUrl, 'https://org-configured.example');
    // No read auth means no id lookup — delivered, not reactable, and the
    // ledger says so rather than pretending otherwise.
    const row = rec.ledger.find(r => r.channel === 'nc_talk');
    assert.equal(row.status, 'sent');
    assert.equal(row.externalRef.messageId, undefined);
});

test('with no bot and no user identity there is nothing to post with', async () => {
    reset();
    orgRoom = 'room1';
    noUserIdentity = true;
    const report = await delivery.deliverApprovalToNextcloud({ approval: approval(), channels: ['nc_talk'] });
    assert.equal(report.talk.ok, false);
    assert.match(report.talk.error, /no Nextcloud identity/);
});

test('the user-identity post obeys the Nextcloud access scope', async () => {
    reset();
    orgRoom = 'room1';
    rec.scopeDenied = true;
    const report = await delivery.deliverApprovalToNextcloud({ approval: approval(), channels: ['nc_talk'] });
    assert.equal(report.talk.ok, false);
    assert.match(report.talk.error, /access scope/);
    assert.equal(rec.chatPosts.length, 0, 'the excluded room must not be written to');
    const row = rec.ledger.find(r => r.channel === 'nc_talk');
    assert.equal(row.status, 'failed', 'a refused delivery is still a recorded attempt');
});

test('a failed Talk post is recorded as failed, with its reason', async () => {
    reset();
    orgRoom = 'room1';
    botSecret = 'S'.repeat(64);
    botPostResult = { ok: false, status: 401, error: 'the Bee Flow bot is not enabled in this conversation' };
    ncFetchImpl = async () => ({ ok: false, status: 403, json: async () => null });
    const report = await delivery.deliverApprovalToNextcloud({ approval: approval(), channels: ['nc_talk'] });
    assert.equal(report.talk.ok, false);
    const row = rec.ledger.find(r => r.channel === 'nc_talk');
    assert.equal(row.status, 'failed');
    assert.ok(row.error, 'the ledger is the only trace a card was meant to exist');
});

// ── The passive bell ────────────────────────────────────────────────────────

test('the bell goes to every recipient who has a Nextcloud account, once each', async () => {
    reset();
    await delivery.deliverApprovalToNextcloud({
        approval: approval(), channels: ['nc_notification'], recipientIds: ['lead', 'fin', 'nobody'],
    });
    assert.equal(rec.notifications.length, 2, 'a user with no nc_uid has no bell to ring');
    assert.deepEqual(rec.notifications.map(n => n.ncUid), ['nc-lead', 'nc-fin']);
    // Every bell carries the deep link — it is the only affordance a Nextcloud
    // notification can have.
    for (const n of rec.notifications) assert.match(n.link, /\/app\/studio\/approvals\/apr_1$/);
    assert.equal(rec.ledger.filter(r => r.channel === 'nc_notification').length, 2);
});

test('a bell Nextcloud refuses (not an admin) is recorded, not swallowed', async () => {
    reset();
    notifyResult = { ok: false, apiVersion: 'v3', status: 403, error: 'admin_notifications requires a Nextcloud admin account.' };
    await delivery.deliverApprovalToNextcloud({
        approval: approval(), channels: ['nc_notification'], recipientIds: ['lead'],
    });
    const row = rec.ledger.find(r => r.channel === 'nc_notification');
    assert.equal(row.status, 'failed');
    assert.match(row.error, /admin/);
});

// ── The policy gate ─────────────────────────────────────────────────────────

test('channels nobody selected do nothing at all', async () => {
    reset();
    orgRoom = 'room1';
    const report = await delivery.deliverApprovalToNextcloud({
        approval: approval(), channels: ['inapp', 'email'], recipientIds: ['lead'],
    });
    assert.deepEqual(report, { talk: null, notifications: [] });
    assert.equal(rec.ledger.length, 0);
    assert.equal(rec.botPosts.length + rec.chatPosts.length + rec.notifications.length, 0);
});

test('a staged approval stamps the ledger with the stage the card announced', async () => {
    reset();
    orgRoom = 'room1';
    await delivery.deliverApprovalToNextcloud({
        approval: approval({ stages: STAGES, stage: 's2' }), channels: ['nc_talk'],
    });
    const row = rec.ledger.find(r => r.channel === 'nc_talk');
    assert.equal(row.stage, 's2', 'a 👍 must be counted against the stage it was asked for');
});

// ── BFSF-441: personal data leaves Bee Flow by e-mail only ─────────────────

const SECRETS = [
    'PROMPT-SECRET jan@example.nl', 'DETAILS-SECRET', 'FIELD-LABEL-SECRET', 'FIELD-VALUE-SECRET',
    'ANSWER-SECRET', 'ATTACHMENT-SECRET', 'CONTEXT-SECRET', 'STAGE-DESC-SECRET', 'REQUESTER-SECRET',
];

function sensitiveApproval(over = {}) {
    return approval({
        prompt: 'Pay PROMPT-SECRET jan@example.nl for INV-7?',
        detailsMd: 'DETAILS-SECRET: IBAN NL91ABNA0417164300',
        attachments: [{ fileId: 'f1', name: 'ATTACHMENT-SECRET.pdf', store: 'run' }],
        answers: { cc: 'ANSWER-SECRET' },
        context: { customer: 'CONTEXT-SECRET' },
        requestedBy: 'REQUESTER-SECRET',
        assigneeUserId: 'lead',
        stages: [
            { key: 's1', name: 'Finance sign-off', description: 'STAGE-DESC-SECRET', approvers: [{ userId: 'lead' }], rule: 'first' },
        ],
        stage: 's1',
        ...over,
    });
}
const WITH_QUESTIONS = { fields: [{ key: 'cc', type: 'text', label: 'FIELD-LABEL-SECRET', default: 'FIELD-VALUE-SECRET' }] };

/** Everything that went out to Nextcloud in this test, as one string. */
function outbound() {
    return JSON.stringify({
        bot: rec.botPosts.map(p => p.message),
        chat: rec.chatPosts.map(p => p.opts?.body || null),
        bell: rec.notifications.map(n => ({ subject: n.subject, message: n.message, link: n.link })),
    });
}
function assertNothingPersonal(label) {
    const out = outbound();
    for (const secret of SECRETS) assert.ok(!out.includes(secret), `${label}: "${secret}" reached Nextcloud: ${out}`);
    assert.ok(!out.includes('INV-7'), `${label}: prompt text reached Nextcloud`);
}

test('the announcement is an allow-list: exactly these keys, whatever the row carries', () => {
    const { approvalAnnouncement, ANNOUNCEMENT_FIELDS } = require('./approvalAnnouncement');
    const a = approvalAnnouncement({
        approval: sensitiveApproval({ ...WITH_QUESTIONS, someColumnAddedNextYear: 'NEW-COLUMN-SECRET' }),
        automationTitle: 'Invoices', url: 'https://app.example/x',
    });
    assert.deepEqual(Object.keys(a).sort(), [...ANNOUNCEMENT_FIELDS].sort());
    assert.ok(Object.isFrozen(a));
    const flat = JSON.stringify(a);
    for (const secret of [...SECRETS, 'NEW-COLUMN-SECRET']) assert.ok(!flat.includes(secret), secret);
    assert.equal(a.event, 'approval_needed');
    assert.equal(a.routineName, 'Invoices');
    assert.equal(a.role, 'Asked of the assigned approver');
    assert.equal(a.answerInApp, true);
    assert.equal(a.link, 'https://app.example/x');
});

test('the role wording names the kind of assignee, never a person', () => {
    const { approvalAnnouncement } = require('./approvalAnnouncement');
    const role = (over) => approvalAnnouncement({ approval: approval(over) }).role;
    assert.equal(role({ approvers: [{ userId: 'u1' }] }), 'Asked of the approval panel');
    assert.equal(role({ assigneeGroupId: 'g1' }), 'Asked of the assigned group');
    assert.equal(role({ assigneeUserId: 'u1' }), 'Asked of the assigned approver');
    assert.equal(role({}), 'Asked of the routine owner');
});

for (const [label, over] of [['plain request', {}], ['request with questions', WITH_QUESTIONS]]) {
    for (const bot of [true, false]) {
        test(`Talk card and Nextcloud bell carry no prompt, details, fields or attachments (${label}, ${bot ? 'bot' : 'user'} post)`, async () => {
            reset();
            orgRoom = 'room1';
            if (bot) botSecret = 'S'.repeat(64);
            const report = await delivery.deliverApprovalToNextcloud({
                approval: sensitiveApproval(over),
                automation: { id: 'a1', title: 'Invoices', userId: 'owner' },
                channels: ['nc_talk', 'nc_notification'], recipientIds: ['lead'],
            });
            assert.equal(report.talk.ok, true);
            assert.equal(rec.notifications.length, 1);
            assertNothingPersonal(label);
            // What it DOES carry: the routine, the event, the role and the link.
            const card = bot ? rec.botPosts[0].message : JSON.parse(rec.chatPosts[0].opts.body).message;
            assert.match(card, /Invoices needs an approval/);
            assert.match(card, /Step 1 of 1: Finance sign-off/);
            assert.match(card, /\/app\/studio\/approvals\/apr_1/);
            const bell = rec.notifications[0];
            assert.equal(bell.subject, 'Invoices needs an approval');
            assert.match(bell.message, /Finance sign-off/);
            assert.match(bell.link, /\/app\/studio\/approvals\/apr_1$/);
        });
    }
}

test('a reminder (scheduled or "Send reminder") keeps the prompt in the Bee Flow bell and out of Talk', async () => {
    reset();
    inAppBells.length = 0;
    orgRoom = 'room1';
    botSecret = 'S'.repeat(64);
    storedAutomation = {
        id: 'a1', title: 'Invoices', userId: 'owner', organizationId: 'org1',
        definition: { notificationSettings: { onApproval: { enabled: true, channels: ['bell', 'talk'], recipients: [{ type: 'approver' }], urgency: 'normal' } } },
    };
    try {
        const { sendApprovalReminder } = require('../core/automationRunner/approvalLifecycle');
        const recipients = await sendApprovalReminder(sensitiveApproval({ automationId: 'a1', stages: null, stage: null }));
        assert.deepEqual(recipients, ['lead']);
        assert.equal(rec.botPosts.length, 1, 'the policy names Talk, so the reminder posts the card');
        assertNothingPersonal('reminder');
        // Inside Bee Flow the prompt is allowed, and useful.
        assert.equal(inAppBells.length, 1);
        assert.match(inAppBells[0].message, /PROMPT-SECRET/);
        assert.ok(!/[–—]/.test(inAppBells[0].message), 'no dash as punctuation in the reminder');
    } finally {
        storedAutomation = null;
    }
});

test('the onApproval run notification: Talk and the Nextcloud bell carry no prompt, e-mail may', async () => {
    reset();
    botSecret = 'S'.repeat(64);
    const sent = { nc: [], mail: [], inApp: [] };
    const { makeRunNotifier } = require('../core/automationRunner/runNotifications');
    const notifier = makeRunNotifier({
        now: () => Date.parse('2026-09-28T10:00:00Z'),
        getAutomation: async () => null,
        getUser: async (id) => ({ id, organizationId: 'org1', email: `${id}@example.test`, nc_uid: `nc-${id}` }),
        listUsers: async () => [],
        events: { countRecentMessages: async () => 0, recordNotificationEvents: async () => {} },
        createBell: async (n) => { sent.inApp.push(n); },
        emailConfig: async () => ({ configured: true }),
        sendEmail: async (m) => { sent.mail.push(m); },
        resolveNcContext: async () => ({ baseUrl: 'https://cloud.example', fetch: async () => ({ ok: true }) }),
        sendNcNotification: async (n) => { sent.nc.push(n); return { ok: true }; },
        resolveTalkRoom: async () => 'room1',
        postTalk: async () => { throw new Error('an approval posts its card, not a plain line'); },
        deliverApprovalCard: (o) => delivery.deliverApprovalToNextcloud(o),
        absoluteUrl: (p) => `https://app.example${p}`,
        appPaths: require('../utils/appPaths'),
    });
    const ap = sensitiveApproval({ stages: null, stage: null });
    const automation = {
        id: 'a1', title: 'Invoices', userId: 'owner', organizationId: 'org1',
        definition: { notificationSettings: { onApproval: { enabled: true, channels: ['bell', 'email', 'talk'], recipients: [{ type: 'approver' }], urgency: 'normal' } } },
    };
    await notifier.notifyRunEvent(automation, 'onApproval', {
        title: 'Approval needed: Invoices', message: ap.prompt, approval: ap, runId: 'run1', userIds: ['lead'],
    });
    assert.equal(rec.botPosts.length, 1);
    assert.equal(sent.nc.length, 1);
    assertNothingPersonal('run notification: Talk');
    const ncOut = JSON.stringify(sent.nc.map(n => ({ subject: n.subject, message: n.message, link: n.link })));
    for (const secret of SECRETS) assert.ok(!ncOut.includes(secret), `Nextcloud bell carried "${secret}"`);
    assert.equal(sent.mail.length, 1);
    assert.match(sent.mail[0].text, /PROMPT-SECRET/, 'e-mail goes to the person themselves and may keep the prompt');
});
