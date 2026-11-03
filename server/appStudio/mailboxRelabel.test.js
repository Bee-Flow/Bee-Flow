/**
 * Mailbox connector: retention without "Only fetch new mail", and a label added
 * to an OLD message reaching its existing row.
 *
 *   • planRetention falls back to the column the mailbox sync itself fills with
 *     the message date (last_message_at / received_at) when neither a
 *     retentionField nor an incremental stamp names one; other kinds unchanged
 *   • the connector-save gate and the purge follow (real SQLite for the purge)
 *   • the 'client' watermark filter never drops a mailbox row
 *   • an old, later-labelled message updates its stored row's labels
 *
 * Run: cd server && node --test appStudio/mailboxRelabel.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const dm = require('./dataModel');
const qc = require('./queryCompiler');
const connectorSync = require('./connectorSync');
const { planRetention } = require('./dataModel/retentionPlan');
const fetchLayer = require('../services/email/fetch');

const app = { id: 'app-1', userId: 'owner-1', organizationId: 'org-1' };

const THREADS = { id: 'tbl_thr000', key: 'threads', name: 'Threads', fields: [
    { id: 'fld_t00001', key: 'thread_key', name: 'Thread', type: 'text', unique: true },
    { id: 'fld_t00002', key: 'last_message_at', name: 'Last', type: 'datetime' },
    { id: 'fld_t00003', key: 'labels', name: 'Labels', type: 'text' },
] };
const MESSAGES = { id: 'tbl_msg000', key: 'messages', name: 'Messages', fields: [
    { id: 'fld_m00001', key: 'provider_message_id', name: 'Id', type: 'text', unique: true },
    { id: 'fld_m00002', key: 'ticket', name: 'Ticket', type: 'relation', relation: { table: THREADS.id } },
    { id: 'fld_m00003', key: 'received_at', name: 'Received', type: 'datetime' },
    { id: 'fld_m00004', key: 'labels', name: 'Labels', type: 'text' },
] };
const model = (...tables) => ({ modelVersion: 1, tables, roles: [], roleMapping: { default: 'app', byGroup: {} } });
const MODEL = model(THREADS, MESSAGES);

const threadConnector = (sync = {}, extra = {}) => ({
    id: 'conn_ab12cd', kind: 'mailbox', name: 'Desk', provider: 'outlook', mode: 'personal', groupIntoThreads: true,
    sync: {
        tableId: THREADS.id, mode: 'upsert', keyField: 'thread_key', retentionDays: 365,
        children: [{ tableId: MESSAGES.id, level: 1, parentLevel: 0, relationField: 'ticket', mode: 'upsert', keyField: 'provider_message_id', retentionCascade: true }],
        ...sync,
    },
    ...extra,
});
const flatConnector = (sync = {}) => ({
    id: 'conn_ab12cd', kind: 'mailbox', name: 'Desk', provider: 'outlook', mode: 'personal',
    sync: { tableId: MESSAGES.id, mode: 'upsert', keyField: 'provider_message_id', retentionDays: 90, ...sync },
});

// ── planRetention ────────────────────────────────────────────────────────────

test('thread mode, incremental off: only the MESSAGES are purged, on received_at; the conversation stays', () => {
    const plan = planRetention(MODEL, threadConnector());
    assert.deepEqual(plan.unreachable, []);
    assert.deepEqual(plan.steps.map((s) => [s.table.key, s.mode, s.column ?? s.relationField]), [
        ['messages', 'column', 'received_at'],
    ]);
});

test('flat mode, incremental off: the message table is purged on received_at', () => {
    const plan = planRetention(MODEL, flatConnector());
    assert.deepEqual(plan.unreachable, []);
    assert.deepEqual(plan.steps.map((s) => [s.table.key, s.column]), [['messages', 'received_at']]);
});

test('a declared retentionField wins over the fallback (flat: on the table, thread: on the message child), and a wrong one is not hidden by it', () => {
    const withExtra = model(THREADS, { ...MESSAGES, fields: [...MESSAGES.fields, { id: 'fld_m00009', key: 'closed_at', name: 'Closed', type: 'datetime' }] });
    const child = (extra) => ({ children: [{ tableId: MESSAGES.id, level: 1, parentLevel: 0, relationField: 'ticket', mode: 'upsert', keyField: 'provider_message_id', ...extra }] });
    assert.equal(planRetention(withExtra, threadConnector(child({ retentionField: 'closed_at' }))).steps[0].column, 'closed_at');
    assert.deepEqual(planRetention(MODEL, threadConnector(child({ retentionField: 'nope' }))).unreachable, ['messages']);
    assert.equal(planRetention(withExtra, flatConnector({ retentionField: 'closed_at' })).steps[0].column, 'closed_at');
    assert.deepEqual(planRetention(MODEL, flatConnector({ retentionField: 'nope' })).unreachable, ['messages']);
});

test('the fallback needs a date column: a text received_at does not count, a conversation without any date does', () => {
    const textual = model(THREADS, { ...MESSAGES, fields: MESSAGES.fields.map((f) => (f.key === 'received_at' ? { ...f, type: 'text' } : f)) });
    assert.deepEqual(planRetention(textual, threadConnector()).unreachable, ['messages']);
    const undated = model({ ...THREADS, fields: THREADS.fields.filter((f) => f.key !== 'last_message_at') }, MESSAGES);
    assert.deepEqual(planRetention(undated, threadConnector()).unreachable, [], 'the conversation is never purged, so it needs no date');
});

test('a mailbox never purges its conversation table or its dependents', () => {
    const lines = { id: 'tbl_line00', key: 'lines', name: 'Lines', fields: [{ id: 'fld_l00001', key: 'added_at', name: 'Added', type: 'datetime' }] };
    const plan = planRetention(model(THREADS, MESSAGES, lines), threadConnector({ dependents: [{ tableId: lines.id, retentionField: 'added_at' }] }));
    assert.deepEqual(plan.steps.map((s) => s.table.key), ['messages']);
    assert.deepEqual(plan.unreachable, []);
});

test('only a MAILBOX connector falls back: any other kind without a date column stays unreachable', () => {
    const other = { ...threadConnector(), kind: 'integration_tool', tool: 'gmail_search' };
    assert.deepEqual(planRetention(MODEL, other).unreachable, ['threads']);
});

// ── connector-save gate ──────────────────────────────────────────────────────

const errsOf = (connector, m = MODEL) => dm.validateDataModel({ ...m, connectors: [connector] }).errors;

test('save: a thread-mode Outlook mailbox with retentionDays 365 and incremental off is accepted', () => {
    const errors = errsOf(threadConnector());
    assert.ok(!errors.some((e) => /retentionDays promises/.test(e)), JSON.stringify(errors));
});

test('save: a thread-mode mailbox whose conversation table has no date column is accepted; one whose message table cannot be dated is refused', () => {
    const undated = model({ ...THREADS, fields: THREADS.fields.filter((f) => f.key !== 'last_message_at') }, MESSAGES);
    assert.ok(!errsOf(threadConnector(), undated).some((e) => /retentionDays promises/.test(e)));
    const noReceived = model(THREADS, { ...MESSAGES, fields: MESSAGES.fields.filter((f) => f.key !== 'received_at') });
    assert.ok(errsOf(threadConnector(), noReceived).some((e) => /nothing would ever delete rows from messages/.test(e)));
});

test('save: a non-mailbox connector without any date column is refused exactly as before', () => {
    const plain = model({ id: 'tbl_aaaaaa', key: 'emails', name: 'Emails', fields: [{ id: 'fld_aaaaaa', key: 'subject', name: 'Subject', type: 'text' }] });
    const errors = errsOf({ id: 'conn_ab12cd', kind: 'integration_tool', name: 'Emails', tool: 'gmail_search',
        sync: { tableId: 'tbl_aaaaaa', mode: 'upsert', keyField: 'id', retentionDays: 365 } }, plain);
    assert.ok(errors.some((e) => /sync\.retentionDays promises data is deleted after 365 days, but nothing would ever delete rows from emails/.test(e)), JSON.stringify(errors));
});

// ── the purge, on a real database ────────────────────────────────────────────

test('the purge deletes expired messages on received_at (real SQLite); the conversation stays', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    const tableKeyById = new Map(MODEL.tables.map((t) => [t.id, t.key]));
    for (const t of MODEL.tables) db.exec(dm.ddlForTable(t, { tableKeyById, dialect: 'sqlite' }));
    const young = new Date().toISOString();
    db.prepare('INSERT INTO threads (id, thread_key, last_message_at) VALUES (?,?,?)').run('c_old', 'a', '2020-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO threads (id, thread_key, last_message_at) VALUES (?,?,?)').run('c_new', 'b', young);
    db.prepare('INSERT INTO messages (id, provider_message_id, ticket, received_at) VALUES (?,?,?,?)').run('m_old', 'x', 'c_old', '2020-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO messages (id, provider_message_id, ticket, received_at) VALUES (?,?,?,?)').run('m_new', 'y', 'c_new', young);

    const deps = {
        runConnector: async () => ({ rows: [] }),
        claimSync: async () => ({ watermark: null }),
        finishSync: async () => {},
        setRowCount: async () => {},
        bumpDataVersion: async () => {},
        ensureLabelColumns: async (_a, m) => m,
        compileDeleteOlderThan: qc.compileDeleteOlderThan,
        compileDoomedUnderParent: qc.compileDoomedUnderParent,
        compileRetentionDelete: qc.compileRetentionDelete,
        exec: async () => { throw new Error('the purge must go through batch'); },
        query: async () => { throw new Error('the purge must go through batch'); },
        batch: async (_o, _a, statements) => db.transaction(() => statements.map((s) => {
            const stmt = db.prepare(s.sql);
            return stmt.readonly ? { rows: stmt.all(...s.params) } : { changes: stmt.run(...s.params).changes };
        }))(),
        listAttachments: async () => [],
        deleteAttachment: async () => true,
        deleteFile: async () => {},
        buildAttachmentKey: (o, a, sha) => `${o}/${a}/${sha}`,
    };
    await connectorSync.syncConnector(app, MODEL, threadConnector({ retentionDays: 30 }), { _deps: deps });
    assert.deepEqual(db.prepare('SELECT id FROM threads ORDER BY id').all().map((r) => r.id), ['c_new', 'c_old'], 'the conversation is an app record');
    assert.deepEqual(db.prepare('SELECT id FROM messages').all().map((r) => r.id), ['m_new']);
});

// ── the 'client' tier and the relabelled old message ─────────────────────────

const EMAILS = { id: 'tbl_aaaaaa', key: 'emails', name: 'Emails', fields: [
    { id: 'fld_000001', key: 'ext_id', name: 'id', type: 'text', unique: true, sourcePath: 'id' },
    { id: 'fld_000002', key: 'labels', name: 'labels', type: 'text', sourcePath: 'labels' },
    { id: 'fld_000003', key: 'received', name: 'receivedAt', type: 'datetime', sourcePath: 'receivedAt' },
] };

function harness(rows, { existing = {}, watermark = '2026-08-01T00:00:00.000Z' } = {}) {
    const log = { inserts: [], updates: [] };
    const store = new Map(Object.entries(existing));
    const _deps = {
        runConnector: async () => ({ rows }),
        claimSync: async () => ({ watermark }),
        finishSync: async () => {},
        compileKeyIndex: (_t, _k, keys) => ({ sql: 'SELECT', params: keys }),
        query: async (_o, _a, _sql, keys) => ({ rows: (keys || []).filter((k) => store.has(String(k))).map((k) => ({ id: store.get(String(k)), k })) }),
        writeRecordBatch: async (_a, _m, _t, written) => { log.inserts.push(...written); return written.map((_, i) => `rec_${i}`); },
        writeRecord: async (_a, _m, _t, values, opts) => { log.updates.push({ values, recordId: opts.recordId }); return { id: opts.recordId, updated: true, changes: 1 }; },
        setRowCount: async () => {},
        bumpDataVersion: async () => {},
        batch: async () => [],
    };
    return { log, _deps };
}

const EMAIL_SYNC = { tableId: EMAILS.id, mode: 'upsert', keyField: 'id', incremental: { field: 'receivedAt', param: null, format: 'iso' } };
const OLD_ROW = { id: 'old', labels: 'Aanvraag', receivedAt: '2026-05-01T10:00:00Z' };

test("a mailbox row received before the watermark is still written: no 'client' tier drop", async () => {
    const h = harness([OLD_ROW]);
    const res = await connectorSync.syncConnector(app, model(EMAILS),
        { id: 'conn_ab12cd', kind: 'mailbox', name: 'Desk', provider: 'outlook', mode: 'personal', sync: EMAIL_SYNC }, { _deps: h._deps });
    assert.equal(res.skipped, 0);
    assert.equal(res.inserted, 1);
});

test("a non-mailbox connector still drops that row in the 'client' tier", async () => {
    const h = harness([OLD_ROW]);
    const res = await connectorSync.syncConnector(app, model(EMAILS),
        { id: 'conn_ab12cd', kind: 'integration_tool', name: 'Emails', tool: 'gmail_search', sync: EMAIL_SYNC }, { _deps: h._deps });
    assert.equal(res.skipped, 1);
    assert.equal(res.inserted, 0);
});

test('an old message that got a category later updates the labels of its stored row', async () => {
    const graph = {
        id: 'old', conversationId: 'conv-1', internetMessageId: '<old@example.com>', subject: 'Aanvraag',
        from: { emailAddress: { address: 'jan@example.com', name: 'Jan' } }, toRecipients: [], ccRecipients: [],
        receivedDateTime: '2026-05-01T10:00:00Z', lastModifiedDateTime: '2026-08-06T09:00:00Z',
        bodyPreview: '', hasAttachments: false, isRead: true, categories: ['Aanvraag'],
    };
    const message = fetchLayer._normalizeGraph(graph, { mailbox: { address: 'ik@acme.nl', mode: 'personal' }, includeBody: false });
    assert.equal(message.labels, 'Aanvraag');

    const h = harness([{ id: message.provider_message_id, labels: message.labels, receivedAt: message.received_at }], { existing: { old: 'rec_existing' } });
    const res = await connectorSync.syncConnector(app, model(EMAILS),
        { id: 'conn_ab12cd', kind: 'mailbox', name: 'Desk', provider: 'outlook', mode: 'personal', sync: EMAIL_SYNC }, { _deps: h._deps });
    assert.equal(res.updated, 1);
    assert.equal(h.log.updates[0].recordId, 'rec_existing');
    assert.equal(h.log.updates[0].values.labels, 'Aanvraag');
});
