/**
 * App Studio — the send_email step.
 *
 * The mail layer, identity ladder and DLP are stubbed; the record-write and
 * RLS plumbing is real, so the "you may not reply to a message you cannot see"
 * rule is genuinely exercised rather than asserted against a mock.
 *
 * Run: cd server && node --test appStudio/actionExecutor.sendEmail.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// ── Storage plumbing ─────────────────────────────────────────────────────────
let queryRows = [];
// Lets a test model a conversation that holds only OUR OWN messages: the
// inbound lookup comes back empty and the fallback has to find the newest row.
let hideInbound = false;
const execCalls = [];
const batchCalls = [];
let attachment = null;

stub('../stores/studioAppDbStore', {
    exec: async (ownerId, appId, sql, params) => { execCalls.push({ sql, params }); return { changes: 1, lastInsertRowid: 0 }; },
    query: async (_o, _a, sql, params) => {
        queryRows.__lastSql = sql; queryRows.__lastParams = params;
        if (hideInbound && Array.isArray(params) && params.includes('inbound')) return { rows: [] };
        return { rows: queryRows };
    },
    batch: async (_o, _a, statements) => { batchCalls.push(statements); return statements.map(() => ({ changes: 1, lastInsertRowid: 0 })); },
    sizeBytes: async () => 0,
});

const emailLog = [];
stub('../stores/studioAppDataStore', {
    bumpDataVersion: async () => 1,
    bumpRowCount: async () => ({}),
    getRowCounts: async () => ({}),
    getMemberRole: async () => null,
    getAttachment: async () => attachment,
    logEmailSend: async (row) => { emailLog.push(row); },
});
stub('../stores/storageStore', { buildStudioAppAttachmentKey: (o, a, s) => `studio-apps/${o}/${a}/attachments/${s}` });
stub('../utils/tempDownloadUrl', { generateTempDownloadUrl: () => 'https://host/tmp' });
stub('../stores/automationStore', { getAutomation: async () => null, getRunSteps: async () => [] });
stub('../core/automationRunner', { executeAutomation: async () => ({ id: 'r', status: 'success' }) });

// ── Mail layer ───────────────────────────────────────────────────────────────
const sendCalls = [];
let sendThrows = null;
const realSend = require('../services/email/send');
stub('../services/email/send', {
    ...realSend,       // keep the real markdown/sanitise/recipient helpers
    sendMailMessage: async (p) => {
        sendCalls.push(p);
        if (sendThrows) throw sendThrows;
        return { providerMessageId: 'sent-1', providerThreadId: 'th-1', rfc822MessageId: '<new@acme.nl>' };
    },
});

let identity = null;
let identityError = null;
stub('./mailboxIdentity', {
    resolveMailboxIdentity: async () => {
        if (identityError) throw identityError;
        return identity;
    },
    sharedModeFor: () => 'delivered_alias',
});

// ── DLP ──────────────────────────────────────────────────────────────────────
let dlpMode = null;          // null = default (scan + log), 'block' = refuse
let dlpFindings = 0;
let dlpThrows = false;
stub('../stores/configStore', {
    getConfig: async (k) => (k.startsWith('studio_app_email_dlp_') ? dlpMode : null),
    setConfig: async () => {},
});
stub('../core/dlp/dlpRunner', {
    scan: async () => {
        if (dlpThrows) throw new Error('guard down');
        return { findings: Array.from({ length: dlpFindings }, () => ({ type: 'person' })) };
    },
});

const actionExecutor = require('./actionExecutor');
const { DATA_MUTATING_STEP_KINDS } = require('./componentSpecs');

// ── Fixtures ─────────────────────────────────────────────────────────────────
const APP = { id: 'app_1', userId: 'owner1', organizationId: 'orgA' };

const MESSAGES_TABLE = {
    id: 'tbl_msgs',
    key: 'messages',
    name: 'Messages',
    fields: [
        { id: 'fld_aa01', key: 'provider_message_id', name: 'Message id', type: 'text' },
        { id: 'fld_aa02', key: 'provider_thread_id', name: 'Thread id', type: 'text' },
        { id: 'fld_aa03', key: 'thread_key', name: 'Thread', type: 'text' },
        { id: 'fld_aa04', key: 'rfc822_message_id', name: 'RFC id', type: 'text' },
        { id: 'fld_aa05', key: 'in_reply_to', name: 'In reply to', type: 'text' },
        { id: 'fld_aa06', key: 'references', name: 'References', type: 'text' },
        { id: 'fld_aa07', key: 'direction', name: 'Direction', type: 'text' },
        { id: 'fld_aa08', key: 'from_email', name: 'From', type: 'text' },
        { id: 'fld_aa09', key: 'to_emails', name: 'To', type: 'text' },
        { id: 'fld_aa10', key: 'cc_emails', name: 'Cc', type: 'text' },
        { id: 'fld_aa11', key: 'subject', name: 'Subject', type: 'text' },
        { id: 'fld_aa12', key: 'body_text', name: 'Body', type: 'text' },
        { id: 'fld_aa13', key: 'body_html', name: 'Body html', type: 'text' },
        { id: 'fld_aa14', key: 'received_at', name: 'Received', type: 'datetime' },
        { id: 'fld_aa15', key: 'is_read', name: 'Read', type: 'bool' },
        { id: 'fld_aa16', key: 'mailbox_address', name: 'Mailbox', type: 'text' },
        { id: 'fld_aa17', key: 'provider', name: 'Provider', type: 'text' },
    ],
    access: { default: 'app', roles: {}, rowFilters: {} },
};

const MODEL = {
    modelVersion: 1,
    tables: [MESSAGES_TABLE],
    roles: [],
    roleMapping: { default: 'app', byGroup: {} },
    connectors: [{
        id: 'conn_mail01',
        kind: 'mailbox',
        provider: 'gmail',
        mode: 'personal',
        runAs: 'viewer',
        sync: { tableId: 'tbl_msgs', mode: 'upsert', keyField: 'provider_message_id', retentionDays: 90 },
    }],
};

const INBOUND_ROW = {
    id: 'rec_1',
    provider_message_id: 'gm-1',
    provider_thread_id: 'gm-th-1',
    thread_key: 'gmail:gm-th-1',
    rfc822_message_id: '<klant@example.com>',
    references: '<root@example.com>',
    from_email: 'klant@example.com',
    subject: 'Bestelling 123',
};

function step(extra = {}) {
    return {
        kind: 'send_email',
        connectorId: 'conn_mail01',
        body: { kind: 'static', value: 'Je pakket is onderweg.' },
        ...extra,
    };
}

function ctx(extra = {}) {
    return { viewer: { id: 'agent1' }, role: null, formValues: {}, vars: {}, ...extra };
}

test.beforeEach(() => {
    queryRows = [INBOUND_ROW];
    hideInbound = false;
    execCalls.length = 0;
    batchCalls.length = 0;
    sendCalls.length = 0;
    emailLog.length = 0;
    sendThrows = null;
    identityError = null;
    attachment = null;
    dlpMode = null;
    dlpFindings = 0;
    dlpThrows = false;
    identity = {
        userId: 'agent1',
        provider: 'gmail',
        tokens: { accessToken: 'at' },
        onRefresh: async () => {},
        mailbox: { address: 'support@acme.nl', mode: 'personal', sharedMode: 'delivered_alias' },
    };
});

// ── Wiring ───────────────────────────────────────────────────────────────────

test('send_email is a server step', () => {
    // A client-executed variant would mean trusting the browser with the
    // recipient and the mailbox credential.
    assert.ok(DATA_MUTATING_STEP_KINDS.includes('send_email'));
});

// ── Threading ────────────────────────────────────────────────────────────────

test('replying derives recipient, subject and the whole threading header set', async () => {
    const res = await actionExecutor.executeDataStep(APP, MODEL, step({
        replyToRecordId: { kind: 'static', value: 'rec_1' },
    }), ctx());

    assert.strictEqual(res.ok, true, res.error);
    const sent = sendCalls[0];
    assert.deepStrictEqual(sent.to, ['klant@example.com'], 'defaults to who wrote to us');
    assert.strictEqual(sent.subject, 'Re: Bestelling 123');
    assert.strictEqual(sent.inReplyTo, '<klant@example.com>');
    assert.strictEqual(sent.references, '<root@example.com>');
    assert.strictEqual(sent.providerThreadId, 'gm-th-1');
    assert.strictEqual(sent.sourceProviderMessageId, 'gm-1');
    // `reply` needs only Mail.Send; createReply would need Mail.ReadWrite.
    assert.strictEqual(sent.replyStrategy, 'reply');
});

test('an existing Re: is not doubled', async () => {
    queryRows = [{ ...INBOUND_ROW, subject: 'Re: Bestelling 123' }];
    await actionExecutor.executeDataStep(APP, MODEL, step({
        replyToRecordId: { kind: 'static', value: 'rec_1' },
    }), ctx());
    assert.strictEqual(sendCalls[0].subject, 'Re: Bestelling 123');
});

test('a message the viewer cannot see is indistinguishable from one that does not exist', async () => {
    // The RLS filter returns nothing; leaking "exists but forbidden" would let a
    // viewer probe for other people's threads.
    queryRows = [];
    const res = await actionExecutor.executeDataStep(APP, MODEL, step({
        replyToRecordId: { kind: 'static', value: 'rec_1' },
    }), ctx());

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, 'Message not found');
    assert.strictEqual(sendCalls.length, 0, 'nothing may leave the building');
});

// ── Recipients ───────────────────────────────────────────────────────────────

test('a reply with no recipient is refused', async () => {
    const res = await actionExecutor.executeDataStep(APP, MODEL, step(), ctx());
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /no recipient/);
    assert.strictEqual(sendCalls.length, 0);
});

test('the recipient count is capped', async () => {
    const many = Array.from({ length: 11 }, (_, i) => `k${i}@example.com`);
    const res = await actionExecutor.executeDataStep(APP, MODEL, step({
        to: { kind: 'static', value: many },
    }), ctx());

    assert.strictEqual(res.ok, false);
    assert.match(res.error, /at most 10 recipients/);
    assert.strictEqual(sendCalls.length, 0);
});

test('an empty body is refused', async () => {
    const res = await actionExecutor.executeDataStep(APP, MODEL, step({
        to: { kind: 'static', value: 'k@example.com' },
        body: { kind: 'static', value: '   ' },
    }), ctx());
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /no message body/);
});

// ── Body rendering ───────────────────────────────────────────────────────────

test('markdown is rendered to HTML and kept as the text part', async () => {
    await actionExecutor.executeDataStep(APP, MODEL, step({
        to: { kind: 'static', value: 'k@example.com' },
        body: { kind: 'static', value: '**vet** en klaar' },
    }), ctx());

    assert.match(sendCalls[0].htmlBody, /<strong>vet<\/strong>/);
    assert.strictEqual(sendCalls[0].textBody, '**vet** en klaar');
});

test('an html body is sanitised before it leaves', async () => {
    await actionExecutor.executeDataStep(APP, MODEL, step({
        to: { kind: 'static', value: 'k@example.com' },
        bodyFormat: 'html',
        body: { kind: 'static', value: '<p onclick="x()">hoi</p><script>evil()</script>' },
    }), ctx());

    assert.doesNotMatch(sendCalls[0].htmlBody, /<script|onclick/i);
    assert.match(sendCalls[0].htmlBody, /hoi/);
});

// ── Identity ─────────────────────────────────────────────────────────────────

test('a viewer with no connected mailbox gets an actionable 409, not a generic failure', async () => {
    const err = new Error('Connect gmail in Settings → Integrations to use this mailbox.');
    err.status = 409; err.code = 'connection_required'; err.provider = 'gmail';
    identityError = err;

    const res = await actionExecutor.executeDataStep(APP, MODEL, step({
        to: { kind: 'static', value: 'k@example.com' },
    }), ctx());

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'connection_required');
    assert.strictEqual(res.provider, 'gmail');
    assert.strictEqual(sendCalls.length, 0);
});

test('the mailbox identity decides the From address', async () => {
    identity.mailbox.address = 'team@acme.nl';
    await actionExecutor.executeDataStep(APP, MODEL, step({
        to: { kind: 'static', value: 'k@example.com' },
    }), ctx());
    assert.strictEqual(sendCalls[0].mailbox.address, 'team@acme.nl');
});

// ── DLP ──────────────────────────────────────────────────────────────────────

test('DLP blocks only when the org asked for it — and then nothing is sent', async () => {
    dlpFindings = 2;

    dlpMode = null;                    // default: scan + log
    const flagged = await actionExecutor.executeDataStep(APP, MODEL, step({
        to: { kind: 'static', value: 'k@example.com' },
    }), ctx());
    assert.strictEqual(flagged.ok, true, 'the default must not break a support desk');
    assert.strictEqual(emailLog[0].dlpOutcome, 'flagged');

    sendCalls.length = 0;
    dlpMode = 'block';
    const blocked = await actionExecutor.executeDataStep(APP, MODEL, step({
        to: { kind: 'static', value: 'k@example.com' },
    }), ctx());
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.code, 'dlp_blocked');
    assert.strictEqual(sendCalls.length, 0, 'a blocked reply must never reach the provider');
});

test('a scanner outage fails OPEN — it is hygiene, not authorization', async () => {
    dlpThrows = true;
    dlpMode = 'block';
    const res = await actionExecutor.executeDataStep(APP, MODEL, step({
        to: { kind: 'static', value: 'k@example.com' },
    }), ctx());
    assert.strictEqual(res.ok, true);
    assert.strictEqual(emailLog[0].dlpOutcome, 'scan_failed');
});

// ── Ledger ───────────────────────────────────────────────────────────────────

test('the ledger records BOTH identities and masks the recipient', async () => {
    // With a lend grant the sender and the mailbox owner differ; an audit that
    // knows only one of them cannot answer "who sent this".
    identity.userId = 'grantor9';
    await actionExecutor.executeDataStep(APP, MODEL, step({
        to: { kind: 'static', value: 'klant@example.com' },
    }), ctx({ viewer: { id: 'agent1' } }));

    assert.strictEqual(emailLog.length, 1);
    assert.strictEqual(emailLog[0].viewerUserId, 'agent1');
    assert.strictEqual(emailLog[0].effectiveUserId, 'grantor9');
    assert.strictEqual(emailLog[0].toMasked, 'kl***@example.com');
    assert.strictEqual(emailLog[0].providerMessageId, 'sent-1');
});

// ── Recording the outbound message ───────────────────────────────────────────

test('the sent reply is written back into the thread', async () => {
    // Gmail's sent mail never enters INBOX, so without this the agent's own
    // reply is invisible in the app they sent it from.
    const res = await actionExecutor.executeDataStep(APP, MODEL, step({
        replyToRecordId: { kind: 'static', value: 'rec_1' },
    }), ctx());

    assert.strictEqual(res.ok, true);
    const insert = execCalls.find((c) => /INSERT INTO "messages"/.test(c.sql));
    assert.ok(insert, 'an insert was compiled');
    const values = insert.params.join('|');
    assert.match(values, /outbound/);
    assert.match(values, /gmail:gm-th-1/, 'it lands on the same thread');
    assert.ok(res.result.recordId, 'the caller gets the new record id back');
});

test('recordOutbound:false skips the write but still sends', async () => {
    const res = await actionExecutor.executeDataStep(APP, MODEL, step({
        to: { kind: 'static', value: 'k@example.com' },
        recordOutbound: false,
    }), ctx());

    assert.strictEqual(res.ok, true);
    assert.strictEqual(sendCalls.length, 1);
    assert.ok(!execCalls.some((c) => /INSERT INTO "messages"/.test(c.sql)));
});

test('a failed write-back does not tell the agent the mail was not sent', async () => {
    // The message is already gone; reporting failure would make them send twice.
    const brokenModel = JSON.parse(JSON.stringify(MODEL));
    brokenModel.connectors[0].sync.tableId = 'tbl_gone';
    const res = await actionExecutor.executeDataStep(APP, brokenModel, step({
        to: { kind: 'static', value: 'k@example.com' },
    }), ctx());

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.result.sent, true);
    // …but it does not claim the reply is in the conversation either. Swallowing
    // this is how an agent sends the same answer twice.
    assert.strictEqual(res.result.recorded, false);
    assert.ok(res.result.recordError, 'the reason travels with the result');
});

// ── Threading a mailbox that rolls messages up into conversations ────────────
// The support-desk shape: sync.tableId is the CONVERSATION table and
// sync.children[0] holds the individual messages. Every screen there selects a
// conversation, so a reply has a thread key and no message id.

const THREADS_TABLE = {
    id: 'tbl_thr1', key: 'tickets', name: 'Tickets',
    fields: [
        { id: 'fld_bb01', key: 'thread_key', name: 'Conversation', type: 'text' },
        { id: 'fld_bb02', key: 'subject', name: 'Subject', type: 'text' },
        { id: 'fld_bb03', key: 'last_message_at', name: 'Last message', type: 'datetime' },
    ],
    access: { default: 'app', roles: {}, rowFilters: {} },
};

const THREADED_MODEL = {
    modelVersion: 1,
    tables: [
        THREADS_TABLE,
        { ...MESSAGES_TABLE, fields: [...MESSAGES_TABLE.fields, { id: 'fld_aa18', key: 'ticket', name: 'Ticket', type: 'relation', relation: { table: 'tbl_thr1' } }] },
    ],
    roles: [],
    roleMapping: { default: 'app', byGroup: {} },
    connectors: [{
        id: 'conn_mail01', kind: 'mailbox', provider: 'gmail', mode: 'personal', runAs: 'viewer',
        groupIntoThreads: true,
        sync: {
            tableId: 'tbl_thr1', mode: 'upsert', keyField: 'thread_key', retentionDays: 90,
            incremental: { field: 'last_message_at', format: 'iso' },
            children: [{ tableId: 'tbl_msgs', level: 1, relationField: 'ticket', keyField: 'provider_message_id', retentionCascade: true }],
        },
    }],
};

test('replyToThreadKey threads onto the newest INBOUND message of the conversation', async () => {
    queryRows = [{ ...INBOUND_ROW, direction: 'inbound', ticket: 'rec_ticket_1' }];

    const res = await actionExecutor.executeDataStep(APP, THREADED_MODEL, step({
        replyToThreadKey: { kind: 'static', value: 'gmail:gm-th-1' },
    }), ctx());

    assert.strictEqual(res.ok, true, res.error);
    // The lookup is scoped to the conversation AND to incoming mail: threading
    // onto our own previous reply makes some clients start a new conversation.
    assert.ok(/FROM "messages"/.test(queryRows.__lastSql), 'reads the MESSAGE table, not the roll-up');
    assert.ok(queryRows.__lastParams.includes('gmail:gm-th-1'));
    assert.ok(queryRows.__lastParams.includes('inbound'));

    const sent = sendCalls[0];
    assert.deepStrictEqual(sent.to, ['klant@example.com'], 'the recipient comes off the message, not the roll-up');
    assert.strictEqual(sent.subject, 'Re: Bestelling 123');
    assert.strictEqual(sent.inReplyTo, '<klant@example.com>');
    assert.strictEqual(sent.providerThreadId, 'gm-th-1');
});

test('a conversation with NO message at all refuses rather than starting a new one', async () => {
    // Sending anyway produces a detached mail the customer reads out of context,
    // and the next sync files it as a SECOND ticket.
    queryRows = [];
    const res = await actionExecutor.executeDataStep(APP, THREADED_MODEL, step({
        replyToThreadKey: { kind: 'static', value: 'gmail:unknown' },
    }), ctx());

    assert.strictEqual(res.ok, false);
    assert.match(res.error, /no message to reply to/i);
    assert.strictEqual(sendCalls.length, 0, 'nothing left the building');
});

test('the reply is recorded in the MESSAGE table and related to its conversation', async () => {
    // It used to be written to sync.tableId — the conversation roll-up — with
    // message columns that do not exist there. The CompileError was swallowed,
    // so the reply left the building and then existed nowhere in the app.
    queryRows = [{ ...INBOUND_ROW, direction: 'inbound', ticket: 'rec_ticket_1' }];

    const res = await actionExecutor.executeDataStep(APP, THREADED_MODEL, step({
        replyToThreadKey: { kind: 'static', value: 'gmail:gm-th-1' },
    }), ctx());

    assert.strictEqual(res.ok, true, res.error);
    assert.strictEqual(res.result.recorded, true);
    const insert = execCalls.find((c) => /INSERT INTO "messages"/.test(c.sql));
    assert.ok(insert, `expected an insert into messages, got: ${execCalls.map((c) => c.sql).join(' | ')}`);
    assert.ok(!execCalls.some((c) => /INSERT INTO "tickets"/.test(c.sql)), 'never into the roll-up');
    // Without the relation the message exists but the ticket's own message list
    // — filtered on it — never shows the reply.
    assert.ok(insert.params.includes('rec_ticket_1'), 'carries the parent ticket id');
});

// ── Attachments ──────────────────────────────────────────────────────────────

test('only ledger-verified, scanned attachments are attached', async () => {
    attachment = { id: 'att1', sha256: 'abc', name: 'bon.pdf', mimeType: 'application/pdf', scanned: false, quarantined: false };
    await actionExecutor.executeDataStep(APP, MODEL, step({
        to: { kind: 'static', value: 'k@example.com' },
        attachments: { kind: 'static', value: [{ fileId: 'att1' }] },
    }), ctx());
    assert.strictEqual(sendCalls[0].attachments, undefined, 'an unscanned file is dropped');

    sendCalls.length = 0;
    attachment = { ...attachment, scanned: true };
    await actionExecutor.executeDataStep(APP, MODEL, step({
        to: { kind: 'static', value: 'k@example.com' },
        attachments: { kind: 'static', value: [{ fileId: 'att1' }] },
    }), ctx());
    assert.strictEqual(sendCalls[0].attachments.length, 1);
    assert.strictEqual(sendCalls[0].attachments[0].filename, 'bon.pdf');
});

test('a quarantined attachment is dropped', async () => {
    attachment = { id: 'att1', sha256: 'abc', name: 'virus.exe', mimeType: 'application/octet-stream', scanned: true, quarantined: true };
    await actionExecutor.executeDataStep(APP, MODEL, step({
        to: { kind: 'static', value: 'k@example.com' },
        attachments: { kind: 'static', value: [{ fileId: 'att1' }] },
    }), ctx());
    assert.strictEqual(sendCalls[0].attachments, undefined);
});

// ── Misconfiguration ─────────────────────────────────────────────────────────

test('a step pointed at a non-mailbox connector fails clearly', async () => {
    const model = JSON.parse(JSON.stringify(MODEL));
    model.connectors[0].kind = 'rest';
    const res = await actionExecutor.executeDataStep(APP, model, step({
        to: { kind: 'static', value: 'k@example.com' },
    }), ctx());

    assert.strictEqual(res.ok, false);
    assert.match(res.error, /not connected to a mailbox/);
});

test('a thread holding only our own messages still threads — and answers the customer', async () => {
    // A mailbox that got the original by forward, a conversation opened from
    // here, or a sync that read every message as sent: there is no inbound row
    // to hang the reply on. Refusing was over-strict — In-Reply-To pointing at
    // a message WE sent is exactly what replying to your own sent mail does, so
    // the reply stays in the conversation. The trap is the recipient: on our own
    // row the sender is us, and inheriting it mails ourselves.
    hideInbound = true;
    queryRows = [{
        ...INBOUND_ROW,
        direction: 'outbound',
        from_email: 'verkoop@ons.nl',
        to_emails: 'klant@example.com',
    }];

    const res = await actionExecutor.executeDataStep(APP, THREADED_MODEL, step({
        replyToThreadKey: { kind: 'static', value: 'gmail:gm-th-1' },
    }), ctx());

    assert.strictEqual(res.ok, true, res.error);
    const sent = sendCalls[0];
    assert.strictEqual(sent.inReplyTo, '<klant@example.com>', 'threaded, not detached');
    assert.deepStrictEqual(sent.to, ['klant@example.com'], 'answers the counterparty, not ourselves');
});
