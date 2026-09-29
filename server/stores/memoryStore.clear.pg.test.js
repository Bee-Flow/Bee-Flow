'use strict';

/**
 * "Clear All" against a REAL Postgres (@electric-sql/pglite, in-process).
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────
 * The memory panel has two homes: Settings (your personal memory) and a
 * project's Memory tab (the project's SHARED pool). Its "Clear All" button
 * called the one clear there was, `clearAllMemories(userId)`, from both. In
 * a project that deleted the person's PERSONAL memories, every one of them,
 * and left the project's pool on the screen untouched; the panel then showed
 * an empty list, so it even looked as if it had worked. There was no store
 * function that emptied a project's pool at all.
 *
 * So this pins, against the real schema:
 *
 *   - a project clear takes exactly that project's rows, whoever wrote them,
 *     and no personal row and no other project's row;
 *   - what the project LIST shows is a subset of what the project clear
 *     removes: the two mean the same pool (the list is the active rows, the
 *     clear also takes the superseded history behind them, as the personal
 *     clear always did);
 *   - the personal clear still leaves every project pool alone;
 *   - both clears take the provenance rows in `memory_sources` with them.
 *     Those hold a raw copy of the chat message a memory came from, and the
 *     table has no foreign key to `user_memories`, so a clear that deletes
 *     only the memories strands that text for good (the same order rule
 *     migrations/memory-guest-purge-2026-08.js is built around).
 *
 * A fake db can prove the route passes the right intent; only a real
 * database proves the SQL carries it out.
 *
 * Run: cd server && node --test --test-force-exit stores/memoryStore.clear.pg.test.js
 */

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert');

const { PGlite } = require('@electric-sql/pglite');
const pg = new PGlite();

function adapt(res) {
    const r = Array.isArray(res) ? (res[res.length - 1] || {}) : (res || {});
    const rows = r.rows || [];
    const fields = r.fields || [];
    const rowCount = fields.length > 0
        ? rows.length
        : (typeof r.affectedRows === 'number' ? r.affectedRows : 0);
    return { rows, rowCount };
}

async function query(sql, params) {
    if (Array.isArray(params) && params.length > 0) return adapt(await pg.query(sql, params));
    if (/;\s*\S/.test(String(sql).trim())) return adapt(await pg.exec(sql));
    return adapt(await pg.query(sql));
}

// The db facade the store sees. Without withTransaction, like the other
// pglite suites: one connection, no overlapping BEGIN sequences.
const dbPath = require.resolve('../db');
require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
        run: query,
        exec: async (sql) => { await query(sql); },
        getOne: async (sql, params) => (await query(sql, params)).rows[0] || null,
        getAll: async (sql, params) => (await query(sql, params)).rows,
        isSqlStateError: (err) => typeof err?.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code),
    },
};

const store = require('./memoryStore');

const BOB = 'bob';
const ALICE = 'alice';

/**
 * Bob and Alice both work in project p1; Bob also in p2. Each has personal
 * memories, one of Bob's superseded (history the personal clear has always
 * taken too). Two memories carry a source row with the message they came from.
 */
const ROWS = [
    // id,            user,  project, status
    ['bob-own',       BOB,   null,    'active'],
    ['bob-own-old',   BOB,   null,    'superseded'],
    ['alice-own',     ALICE, null,    'active'],
    ['p1-by-alice',   ALICE, 'p1',    'active'],
    ['p1-by-bob',     BOB,   'p1',    'active'],
    ['p1-old',        ALICE, 'p1',    'superseded'],
    ['p2-by-bob',     BOB,   'p2',    'active'],
];
const SOURCES = [
    ['src-bob-own', 'bob-own'],
    ['src-p1', 'p1-by-alice'],
    ['src-p2', 'p2-by-bob'],
];

const ids = async (where = 'TRUE', params = []) =>
    (await query(`SELECT id FROM user_memories WHERE ${where} ORDER BY id`, params)).rows.map((r) => r.id);
const sourceIds = async () =>
    (await query('SELECT id FROM memory_sources ORDER BY id')).rows.map((r) => r.id);

before(async () => {
    // getMemoriesForProject joins the author's name from `users`, which
    // belongs to another store; the columns it reads are all it needs here.
    await query(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT, "displayName" TEXT)`);
    // One real schema init: the DDL production runs, including the project FK.
    await store.getMemories(BOB, 1);
});

beforeEach(async () => {
    await query('DELETE FROM memory_sources');
    await query('DELETE FROM user_memories');
    await query('DELETE FROM users');
    for (const u of [BOB, ALICE]) {
        await query('INSERT INTO users (id, username, "displayName") VALUES ($1, $1, $1)', [u]);
    }
    const hasProjects = (await query(`SELECT to_regclass('projects') AS t`)).rows[0].t;
    if (hasProjects) {
        await query('DELETE FROM projects');
        for (const p of ['p1', 'p2']) {
            await query('INSERT INTO projects (id, name, owner_id) VALUES ($1, $1, $2)', [p, ALICE]);
        }
    }
    for (const [id, user, project, status] of ROWS) {
        await query(
            `INSERT INTO user_memories (id, user_id, type, content, status, project_id)
             VALUES ($1, $2, 'fact', $1, $3, $4)`,
            [id, user, status, project],
        );
    }
    for (const [id, memoryId] of SOURCES) {
        await query(
            `INSERT INTO memory_sources (id, memory_id, conversation_id, message_content)
             VALUES ($1, $2, 'conv-1', 'the message this came from')`,
            [id, memoryId],
        );
    }
});

test('a project clear takes that project\'s pool, whoever wrote it, and nothing else', async () => {
    assert.strictEqual(typeof store.clearProjectMemories, 'function',
        'there has to be a way to clear ONE project\'s memory without touching anyone\'s personal memory');

    await store.clearProjectMemories('p1');

    assert.deepStrictEqual(await ids(`project_id = 'p1'`), [], 'every p1 row went, active and superseded, Alice\'s and Bob\'s');
    assert.deepStrictEqual(await ids(), ['alice-own', 'bob-own', 'bob-own-old', 'p2-by-bob'],
        'personal memories and the other project stay exactly as they were');
});

test('the project list and the project clear mean the same pool', async () => {
    const listed = (await store.getMemoriesForProject(BOB, 'p1')).map((m) => m.id).sort();
    assert.deepStrictEqual(listed, ['p1-by-alice', 'p1-by-bob'], 'the list is the active rows of the pool, both authors');

    const held = await ids();
    await store.clearProjectMemories('p1');
    const left = new Set(await ids());
    const removed = held.filter((id) => !left.has(id));

    for (const id of listed) assert.ok(removed.includes(id), `${id} was on the screen and must be gone after Clear All`);
    assert.deepStrictEqual(removed.sort(), ['p1-by-alice', 'p1-by-bob', 'p1-old'],
        'beyond what the list shows, only the superseded history of the same pool');
    assert.deepStrictEqual(await store.getMemoriesForProject(BOB, 'p1'), [], 'the panel reloads to an empty pool');
});

test('the personal clear still leaves every project pool alone', async () => {
    await store.clearAllMemories(BOB);

    assert.deepStrictEqual(await ids(), ['alice-own', 'p1-by-alice', 'p1-by-bob', 'p1-old', 'p2-by-bob'],
        'only Bob\'s personal rows went; his project rows and Alice\'s memories stay');
});

test('the personal clear takes the source messages of what it deleted, and only those', async () => {
    await store.clearAllMemories(BOB);
    assert.deepStrictEqual(await sourceIds(), ['src-p1', 'src-p2'],
        'Bob\'s personal source text went with his memories; the project pools keep theirs');
});

test('the project clear takes the source messages of what it deleted, and only those', async () => {
    await store.clearProjectMemories('p1');
    assert.deepStrictEqual(await sourceIds(), ['src-bob-own', 'src-p2'],
        'the p1 source text went with its memory; personal and p2 sources stay');
});
