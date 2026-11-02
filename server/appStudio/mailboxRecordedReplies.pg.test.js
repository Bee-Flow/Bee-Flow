/**
 * A reply recorded under a `local-` key gives its row to the provider's copy,
 * run against a real Postgres (PGlite) through the compiled SQL.
 *
 * Run: cd server && node --test appStudio/mailboxRecordedReplies.pg.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';
require('../testUtils/routeHarness').recordDb();

const engineFlag = require('./engineFlag');
engineFlag._setForTests('pg');

const qc = require('./queryCompiler');
const { ddlForTable } = require('./dataModel');
const { toDollarParams } = require('../stores/lib/pgAppEngine');
const { MAILBOX_TABLE_TEMPLATE } = require('./mailboxTableTemplates');
const { adoptRecordedReplies, REPLY_MATCH_MS } = require('./mailboxRecordedReplies.mts');

const MESSAGES = { id: 'tbl_msg', key: 'messages', fields: MAILBOX_TABLE_TEMPLATE.fields };
const MODEL = { tables: [MESSAGES] };
const THREADED = { kind: 'mailbox', groupIntoThreads: true, sync: { tableId: 'tbl_thr', children: [{ level: 1, tableId: 'tbl_msg' }] } };
const APP = { id: 'app_1', userId: 'owner_1' };
const T0 = Date.parse('2026-11-02T10:00:00.000Z');
const at = (ms) => new Date(T0 + ms).toISOString();

let db = null;
const run = (sql, params = []) => db.query(toDollarParams(sql, params.length), params);
const deps = { query: (_o, _a, sql, params) => run(sql, params), exec: (_o, _a, sql, params) => run(sql, params) };

async function seed(rows) {
    await db.exec('DELETE FROM messages');
    for (const row of rows) {
        const ins = qc.compileInsert(MESSAGES, row, { createdBy: APP.userId, orgId: 'org_1' });
        await run(ins.sql, ins.params);
    }
}
const keys = async () => (await db.query('SELECT provider_message_id FROM messages ORDER BY provider_message_id')).rows
    .map((r) => r.provider_message_id);

const recorded = (over = {}) => ({
    provider_message_id: 'local-1730541600000', thread_key: 'outlook:conv-1', direction: 'outbound',
    subject: 'Re: Offerte krul', received_at: at(0), ...over,
});
const synced = (over = {}) => ({
    provider_message_id: 'AAMk-sent-1', thread_key: 'outlook:conv-1', direction: 'outbound',
    subject: 'RE: Offerte krul', received_at: at(4000), ...over,
});
const grains = (...messages) => [{ level: 0, rows: [] }, { level: 1, rows: messages }];

test.before(async () => {
    const { PGlite } = require('@electric-sql/pglite');
    db = new PGlite();
    await db.exec("SET TIME ZONE 'UTC'");
    await db.exec(ddlForTable(MESSAGES, { tableKeyById: new Map([[MESSAGES.id, MESSAGES.key]]) }));
});
test.after(async () => { if (db) await db.close(); });

test('the provider copy of a sent reply takes over the recorded row, so the upsert updates it', async () => {
    await seed([recorded(), { ...synced({ provider_message_id: 'AAMk-in-1', direction: 'inbound', subject: 'Offerte krul' }) }]);
    const out = await adoptRecordedReplies(APP, MODEL, THREADED, grains(synced()), deps);
    assert.deepStrictEqual(out, { adopted: 1, removed: 0 });
    assert.deepStrictEqual(await keys(), ['AAMk-in-1', 'AAMk-sent-1']);
});

test('a duplicate that is already stored loses its recorded twin', async () => {
    await seed([recorded(), synced()]);
    const out = await adoptRecordedReplies(APP, MODEL, THREADED, grains(synced()), deps);
    assert.deepStrictEqual(out, { adopted: 0, removed: 1 });
    assert.deepStrictEqual(await keys(), ['AAMk-sent-1']);
});

test('another conversation, another subject or a stamp outside the window is left alone', async () => {
    await seed([recorded()]);
    for (const other of [
        synced({ thread_key: 'outlook:conv-2' }),
        synced({ subject: 'RE: Iets anders' }),
        synced({ received_at: at(REPLY_MATCH_MS + 1000) }),
        synced({ direction: 'inbound' }),
    ]) {
        const out = await adoptRecordedReplies(APP, MODEL, THREADED, grains(other), deps);
        assert.deepStrictEqual(out, { adopted: 0, removed: 0 }, JSON.stringify(other));
    }
    assert.deepStrictEqual(await keys(), ['local-1730541600000']);
});

test('two replies in one conversation each claim their nearest copy, once', async () => {
    await seed([recorded(), recorded({ provider_message_id: 'local-2', received_at: at(60_000) })]);
    const out = await adoptRecordedReplies(APP, MODEL, THREADED, grains(
        synced({ provider_message_id: 'AAMk-sent-2', received_at: at(62_000) }),
        synced(),
    ), deps);
    assert.deepStrictEqual(out, { adopted: 2, removed: 0 });
    const rows = (await db.query('SELECT provider_message_id, received_at FROM messages ORDER BY received_at')).rows;
    assert.deepStrictEqual(rows.map((r) => r.provider_message_id), ['AAMk-sent-1', 'AAMk-sent-2']);
});

test('a flat mailbox reads its messages from grain 0, and a missing table is a no-op', async () => {
    await seed([recorded()]);
    const flat = { kind: 'mailbox', sync: { tableId: 'tbl_msg' } };
    assert.deepStrictEqual(await adoptRecordedReplies(APP, MODEL, flat, [{ level: 0, rows: [synced()] }], deps), { adopted: 1, removed: 0 });
    assert.deepStrictEqual(await adoptRecordedReplies(APP, { tables: [] }, THREADED, grains(synced()), deps), { adopted: 0, removed: 0 });
});
