/**
 * The retention purge of a connector, run against a REAL SQLite database with foreign keys on and
 * the DDL the app store really emits (relation columns REFERENCES their parent, no ON DELETE):
 * the purge must go child-first, in one transaction, and never fail on a row something points at.
 *
 * Run: cd server && node --test appStudio/connectorRetention.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const connectorSync = require('./connectorSync');
const dataModel = require('./dataModel');
const qc = require('./queryCompiler');
const log = require('../telemetry/log');
const { referrersOf, fileIdsFromRows } = require('./connectorRetention.mts');

const app = { id: 'app-1', userId: 'owner-1' };
const OLD = '2026-01-01T00:00:00.000Z';

const CONVERSATIONS = { id: 'tbl_conv00', key: 'conversations', name: 'Conversations', fields: [
    { id: 'fld_c00001', key: 'thread_key', name: 'Thread', type: 'text' },
    { id: 'fld_c00002', key: 'last_message_at', name: 'Last', type: 'datetime', sourcePath: 'lastMessageAt' },
] };
const MESSAGES = { id: 'tbl_msg000', key: 'messages', name: 'Messages', fields: [
    { id: 'fld_m00001', key: 'ticket', name: 'Ticket', type: 'relation', relation: { table: CONVERSATIONS.id } },
    { id: 'fld_m00002', key: 'subject', name: 'Subject', type: 'text' },
] };
const ATTACHMENTS = { id: 'tbl_att000', key: 'attachments', name: 'Attachments', fields: [
    { id: 'fld_a00001', key: 'message', name: 'Message', type: 'relation', relation: { table: MESSAGES.id } },
    { id: 'fld_a00002', key: 'file', name: 'File', type: 'file' },
] };
const NOTES = { id: 'tbl_note00', key: 'notes', name: 'Notes', fields: [
    { id: 'fld_n00001', key: 'message', name: 'Message', type: 'relation', relation: { table: MESSAGES.id } },
] };
const MODEL = { modelVersion: 1, tables: [CONVERSATIONS, MESSAGES, ATTACHMENTS, NOTES], roles: [], roleMapping: { default: 'app', byGroup: {} } };

const CONNECTOR = {
    id: 'conn_ab12cd', kind: 'mailbox', name: 'Desk', groupIntoThreads: true,
    sync: {
        tableId: CONVERSATIONS.id, mode: 'upsert', keyField: 'thread_key', retentionDays: 30,
        incremental: { field: 'lastMessageAt', format: 'iso' },
        children: [
            { tableId: MESSAGES.id, level: 1, parentLevel: 0, relationField: 'ticket', mode: 'upsert', keyField: 'subject', retentionCascade: true },
            { tableId: ATTACHMENTS.id, level: 2, parentLevel: 1, relationField: 'message', mode: 'upsert', keyField: 'file', retentionCascade: true },
        ],
    },
};

function openDb(model = MODEL) {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    const tableKeyById = new Map(model.tables.map((t) => [t.id, t.key]));
    for (const t of model.tables) db.exec(dataModel.ddlForTable(t, { tableKeyById, dialect: 'sqlite' }));
    return db;
}

const ins = (db, table, row) => {
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(row));
};
const ids = (db, table) => db.prepare(`SELECT id FROM "${table}" ORDER BY id`).all().map((r) => r.id);
const desc = (fileId) => JSON.stringify({ kind: 'studio_attachment', fileId });

/** Deps over the real database: the real compilers, batch in one real transaction. */
function depsOver(db, extra = {}) {
    const batchCalls = [];
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
        batch: async (_o, _a, statements) => {
            batchCalls.push(statements);
            return db.transaction(() => statements.map((s) => {
                const stmt = db.prepare(s.sql);
                return stmt.readonly ? { rows: stmt.all(...s.params) } : { changes: stmt.run(...s.params).changes };
            }))();
        },
        listAttachments: async () => [],
        deleteAttachment: async () => true,
        deleteFile: async () => {},
        buildAttachmentKey: (o, a, sha) => `${o}/${a}/${sha}`,
        ...extra,
    };
    return { deps, batchCalls };
}

/** Run the sync (no new rows) so only the retention purge acts; capture the log output. */
async function purge(db, extra, model = MODEL, connector = CONNECTOR) {
    const { deps, batchCalls } = depsOver(db, extra);
    const logged = { warn: [], error: [], info: [] };
    const orig = { warn: log.warn, error: log.error, info: log.info };
    for (const k of Object.keys(logged)) log[k] = (m) => { logged[k].push(String(m)); };
    try {
        const res = await connectorSync.syncConnector(app, model, connector, { _deps: deps });
        return { res, logged, batchCalls };
    } finally { Object.assign(log, orig); }
}

function seed(db) {
    const young = new Date().toISOString();
    ins(db, 'conversations', { id: 'c_old', thread_key: 'a', last_message_at: OLD });
    ins(db, 'conversations', { id: 'c_new', thread_key: 'b', last_message_at: young });
    ins(db, 'messages', { id: 'm_old1', ticket: 'c_old', subject: 'x' });
    ins(db, 'messages', { id: 'm_old2', ticket: 'c_old', subject: 'y' });
    ins(db, 'messages', { id: 'm_new1', ticket: 'c_new', subject: 'z' });
    ins(db, 'attachments', { id: 'a_old1', message: 'm_old1', file: desc('f_old1') });
    ins(db, 'attachments', { id: 'a_old2', message: 'm_old2', file: desc('f_old2') });
    ins(db, 'attachments', { id: 'a_new1', message: 'm_new1', file: desc('f_new1') });
}

test('an expired conversation goes with its messages and attachments, a young one is untouched', async () => {
    const db = openDb();
    seed(db);
    const { res, logged, batchCalls } = await purge(db);

    assert.deepEqual(ids(db, 'conversations'), ['c_new']);
    assert.deepEqual(ids(db, 'messages'), ['m_new1']);
    assert.deepEqual(ids(db, 'attachments'), ['a_new1']);
    assert.equal(res.purged, 5, '1 conversation + 2 messages + 2 attachments');
    assert.deepEqual(logged.warn, [], 'no FOREIGN KEY failure, nothing kept');
    assert.equal(logged.error.length, 0);
    assert.equal(batchCalls.length, 1, 'one transaction');
    const deletes = batchCalls[0].filter((s) => /^DELETE/.test(s.sql)).map((s) => s.sql.match(/FROM "(\w+)"/)[1]);
    assert.deepEqual(deletes, ['attachments', 'messages', 'conversations'], 'bottom-up');
});

test('a message the app itself references stays, so does its conversation; the rest expires', async () => {
    const db = openDb();
    seed(db);
    ins(db, 'notes', { id: 'n1', message: 'm_old1' });
    const { res, logged } = await purge(db);

    assert.deepEqual(ids(db, 'conversations'), ['c_new', 'c_old'], 'c_old still has the referenced message');
    assert.deepEqual(ids(db, 'messages'), ['m_new1', 'm_old1']);
    assert.deepEqual(ids(db, 'attachments'), ['a_new1'], 'its attachment is doomed and nothing points at it');
    assert.deepEqual(ids(db, 'notes'), ['n1']);
    assert.equal(res.purged, 3, 'a_old1, a_old2 and m_old2');
    assert.ok(logged.warn.some((m) => /kept 1 row\(s\) of messages.*notes\.message/.test(m)), logged.warn.join('\n'));
    assert.ok(logged.warn.some((m) => /kept 1 row\(s\) of conversations.*messages\.ticket/.test(m)), logged.warn.join('\n'));
    assert.ok(!logged.warn.some((m) => /FOREIGN KEY|failed/.test(m)));
    assert.equal(logged.error.length, 0);
});

test('the files of deleted rows reach purgeAttachments, double-encoded descriptors included', async () => {
    const db = openDb();
    seed(db);
    ins(db, 'attachments', { id: 'a_old3', message: 'm_old2', file: JSON.stringify(desc('f_old3')) });
    const purged = [];
    await purge(db, {
        listAttachments: async () => ['f_old1', 'f_old2', 'f_old3', 'f_new1'].map((id) => ({ id, sha256: `sha-${id}` })),
        deleteAttachment: async (id) => { purged.push(id); return true; },
    });

    assert.deepEqual(purged.sort(), ['f_old1', 'f_old2', 'f_old3']);
});

test('the file of a row that stays is not collected', async () => {
    // An app table pointing AT an attachment keeps that attachment, and with it its message and conversation.
    const refs = { id: 'tbl_ref000', key: 'refs', name: 'Refs', fields: [
        { id: 'fld_r00001', key: 'att', name: 'Att', type: 'relation', relation: { table: ATTACHMENTS.id } },
    ] };
    const model = { ...MODEL, tables: [...MODEL.tables, refs] };
    const db = openDb(model);
    seed(db);
    ins(db, 'refs', { id: 'r1', att: 'a_old1' });
    const purged = [];
    const { res } = await purge(db, {
        listAttachments: async () => [{ id: 'f_old1', sha256: 's1' }, { id: 'f_old2', sha256: 's2' }],
        deleteAttachment: async (id) => { purged.push(id); return true; },
    }, model);

    assert.deepEqual(purged, ['f_old2']);
    assert.deepEqual(ids(db, 'attachments'), ['a_new1', 'a_old1']);
    assert.deepEqual(ids(db, 'messages'), ['m_new1', 'm_old1']);
    assert.deepEqual(ids(db, 'conversations'), ['c_new', 'c_old']);
    assert.equal(res.purged, 2, 'm_old2 and a_old2');
});

test('the whole purge is one transaction: a failing statement rolls everything back and the sync stays ok', async () => {
    const db = openDb();
    seed(db);
    db.exec("CREATE TRIGGER boom BEFORE DELETE ON conversations BEGIN SELECT RAISE(ABORT, 'boom'); END");
    const { res, logged } = await purge(db);

    assert.ok(!res.purged);
    assert.equal(ids(db, 'messages').length, 3, 'children deleted earlier in the batch came back');
    assert.ok(logged.warn.some((m) => /retention purge failed/.test(m) && /boom/.test(m)));
});

test('referrersOf finds every relation column that targets a table, whichever table holds it', () => {
    assert.deepEqual(referrersOf(MODEL, MESSAGES).map((r) => `${r.tableMeta.key}.${r.field}`), ['attachments.message', 'notes.message']);
    assert.deepEqual(referrersOf(MODEL, NOTES), []);
});

test('fileIdsFromRows unwraps double-encoded descriptors and skips pending mailbox pointers', () => {
    const rows = [
        { file: desc('f1') }, { file: JSON.stringify(desc('f2')) },
        { file: JSON.stringify({ kind: 'mailbox_attachment', attachmentId: 'a' }) }, { file: null }, { file: 'not json' },
    ];
    assert.deepEqual(fileIdsFromRows([{ key: 'file' }], rows), ['f1', 'f2']);
});

// ── Dependents: tables the connector does not write but whose lifetime it governs ─────────────

const LINES = { id: 'tbl_line00', key: 'quote_lines', name: 'Lines', fields: [
    { id: 'fld_l00001', key: 'added_at', name: 'Added', type: 'datetime' },
    { id: 'fld_l00002', key: 'drawing', name: 'Drawing', type: 'file' },
] };
const ACTIVITY = { id: 'tbl_act000', key: 'activity', name: 'Activity', fields: [
    { id: 'fld_x00001', key: 'request', name: 'Request', type: 'relation', relation: { table: CONVERSATIONS.id } },
] };
const DEP_MODEL = { ...MODEL, tables: [CONVERSATIONS, MESSAGES, ATTACHMENTS, LINES, ACTIVITY] };
const DEP_CONNECTOR = { ...CONNECTOR, sync: { ...CONNECTOR.sync, dependents: [
    { tableId: LINES.id, retentionField: 'added_at' },
    { tableId: ACTIVITY.id, relationField: 'request', parentTableId: CONVERSATIONS.id, retentionCascade: true },
] } };

test('a dependent is purged on its own date, a cascade dependent goes with its conversation', async () => {
    const db = openDb(DEP_MODEL);
    seed(db);
    ins(db, 'quote_lines', { id: 'l_old', added_at: OLD, drawing: desc('f_line_old') });
    ins(db, 'quote_lines', { id: 'l_new', added_at: new Date().toISOString(), drawing: desc('f_line_new') });
    ins(db, 'activity', { id: 'x_old', request: 'c_old' });
    ins(db, 'activity', { id: 'x_new', request: 'c_new' });
    ins(db, 'activity', { id: 'x_none', request: null });
    const purged = [];
    const { res, logged } = await purge(db, {
        listAttachments: async () => ['f_line_old', 'f_line_new'].map((id) => ({ id, sha256: `sha-${id}` })),
        deleteAttachment: async (id) => { purged.push(id); return true; },
    }, DEP_MODEL, DEP_CONNECTOR);

    assert.deepEqual(ids(db, 'quote_lines'), ['l_new']);
    assert.deepEqual(ids(db, 'activity'), ['x_new', 'x_none'], 'sweepNull is off for a dependent: an unlinked row is live data');
    assert.deepEqual(ids(db, 'conversations'), ['c_new']);
    assert.deepEqual(purged, ['f_line_old']);
    assert.equal(res.purged, 5 + 1 + 1, 'the three levels, the old line and the old activity row');
    assert.deepEqual(logged.warn, []);
});

// ── Files: ledger rows and blobs behind deleted rows ──────────────────────────────────────────

/** A purge over the seeded desk whose ledger/bucket are recorded. */
async function purgeFiles(ledger) {
    const db = openDb();
    seed(db);
    let rows = [...ledger];
    const deleted = { ledger: [], blobs: [] };
    const out = await purge(db, {
        listAttachments: async () => rows,
        deleteAttachment: async (id) => { deleted.ledger.push(id); rows = rows.filter((r) => r.id !== id); return true; },
        deleteFile: async (key) => { deleted.blobs.push(key); },
    });
    return { ...out, deleted };
}

test('an expired file loses its ledger row AND its blob', async () => {
    const { deleted } = await purgeFiles([
        { id: 'f_old1', sha256: 'a' }, { id: 'f_old2', sha256: 'b' }, { id: 'f_new1', sha256: 'c' },
    ]);
    assert.deepEqual(deleted.ledger.sort(), ['f_old1', 'f_old2']);
    assert.deepEqual(deleted.blobs.sort(), ['owner-1/app-1/a', 'owner-1/app-1/b']);
});

test('a blob another live row still points at is kept (content-addressed, shared by sha)', async () => {
    const { deleted } = await purgeFiles([
        { id: 'f_old1', sha256: 'shared' }, { id: 'f_new1', sha256: 'shared' }, { id: 'f_old2', sha256: 'b' },
    ]);
    assert.deepEqual(deleted.ledger.sort(), ['f_old1', 'f_old2']);
    assert.deepEqual(deleted.blobs, ['owner-1/app-1/b'], 'the shared bytes stay: f_new1 needs them');
});

test('a blob that cannot be deleted is a warning, not a failed sync, and the rows are gone', async () => {
    const db = openDb();
    seed(db);
    let rows = [{ id: 'f_old1', sha256: 'a' }];
    const { res, logged } = await purge(db, {
        listAttachments: async () => rows,
        deleteAttachment: async () => { rows = []; return true; },
        deleteFile: async () => { throw new Error('bucket down'); },
    });
    assert.ok(logged.warn.some((m) => /retention purge failed/.test(m) && /bucket down/.test(m)));
    assert.equal(res.purged, 5, 'the committed deletes still count');
    assert.deepEqual(ids(db, 'conversations'), ['c_new']);
});

test('a pending mailbox descriptor leaves nothing of ours to delete', async () => {
    const db = openDb();
    ins(db, 'conversations', { id: 'c_old', thread_key: 'a', last_message_at: OLD });
    ins(db, 'messages', { id: 'm_old1', ticket: 'c_old', subject: 'x' });
    ins(db, 'attachments', { id: 'a_old1', message: 'm_old1', file: JSON.stringify({ kind: 'mailbox_attachment', messageId: 'm', attachmentId: 'a' }) });
    const deleted = [];
    await purge(db, {
        listAttachments: async () => [{ id: 'f1', sha256: 'a' }],
        deleteAttachment: async (id) => { deleted.push(id); return true; },
    });
    assert.deepEqual(deleted, []);
    assert.deepEqual(ids(db, 'attachments'), []);
});
