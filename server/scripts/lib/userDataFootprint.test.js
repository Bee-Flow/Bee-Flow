'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { discoverUserTables, userDataFootprint, isSafeToDelete, DISCOVER_SQL } = require('./userDataFootprint');
const { pgliteDb } = require('../../testUtils/pgliteDb');

// A schema with the four tables the old hard-coded check knew about, plus the
// kinds of tables it never looked at (and deleteUser does erase).
const DDL = `
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);
    CREATE TABLE user_memories (id SERIAL PRIMARY KEY, user_id TEXT);
    CREATE TABLE agent_conversations (id SERIAL PRIMARY KEY, user_id TEXT);
    CREATE TABLE direct_conversations (id SERIAL PRIMARY KEY, user_id TEXT);
    CREATE TABLE execution_history (id SERIAL PRIMARY KEY, user_id TEXT);
    CREATE TABLE notebooks (id SERIAL PRIMARY KEY, owner_id TEXT, title TEXT);
    CREATE TABLE pii_vault (id SERIAL PRIMARY KEY, "userId" TEXT, value TEXT);
    CREATE TABLE agents (id SERIAL PRIMARY KEY, created_by TEXT);
    CREATE TABLE connections (id SERIAL PRIMARY KEY, holder TEXT REFERENCES users(id));
    CREATE TABLE unrelated (id SERIAL PRIMARY KEY, actor_id TEXT, note TEXT);
    CREATE VIEW notebook_view AS SELECT * FROM notebooks;
`;

async function withDb(fn) {
    const { pg, db } = pgliteDb();
    try {
        await pg.exec(DDL);
        await pg.exec(`INSERT INTO users (id) VALUES ('orphan'), ('empty')`);
        await fn(pg, db);
    } finally {
        await pg.close();
    }
}

test('discovers every user table, by column name and by foreign key, not a fixed list', async () => {
    await withDb(async (_pg, db) => {
        const tables = await discoverUserTables(db);
        assert.deepEqual(tables, [
            { table: 'agent_conversations', columns: ['user_id'] },
            { table: 'agents', columns: ['created_by'] },
            { table: 'connections', columns: ['holder'] },
            { table: 'direct_conversations', columns: ['user_id'] },
            { table: 'execution_history', columns: ['user_id'] },
            { table: 'notebooks', columns: ['owner_id'] },
            { table: 'pii_vault', columns: ['userId'] },
            { table: 'user_memories', columns: ['user_id'] },
        ]);
    });
});

test('an orphan whose only data is outside the old four tables is NOT safe to delete', async () => {
    await withDb(async (pg, db) => {
        await pg.exec(`
            INSERT INTO notebooks (owner_id, title) VALUES ('orphan', 'n1'), ('orphan', 'n2');
            INSERT INTO pii_vault ("userId", value) VALUES ('orphan', 'secret');
            INSERT INTO agents (created_by) VALUES ('orphan');
            INSERT INTO connections (holder) VALUES ('orphan');
            INSERT INTO unrelated (actor_id) VALUES ('empty');
        `);
        const tables = await discoverUserTables(db);
        const fp = await userDataFootprint(db, 'orphan', tables);
        assert.deepEqual(fp.counts, { agents: 1, connections: 1, notebooks: 2, pii_vault: 1 });
        assert.equal(fp.total, 5);
        assert.deepEqual(fp.errors, {});
        assert.equal(isSafeToDelete(fp), false);

        const empty = await userDataFootprint(db, 'empty', tables);
        assert.deepEqual(empty, { counts: {}, total: 0, errors: {} });
        assert.equal(isSafeToDelete(empty), true);
    });
});

test('a count that fails is an unknown, never a zero (fail-closed)', async () => {
    await withDb(async (pg, db) => {
        const tables = await discoverUserTables(db);
        await pg.exec('DROP TABLE notebooks CASCADE');
        const fp = await userDataFootprint(db, 'empty', tables);
        assert.equal(fp.total, 0);
        assert.deepEqual(Object.keys(fp.errors), ['notebooks']);
        assert.equal(isSafeToDelete(fp), false);
    });
});

test('discovery that fails or finds no table throws instead of declaring users empty', async () => {
    await assert.rejects(discoverUserTables({ async query() { throw new Error('permission denied'); } }), /permission denied/);
    await assert.rejects(discoverUserTables({ async query() { return { rows: [] }; } }), /found no table/);
    const { pg, db } = pgliteDb();
    try {
        await pg.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
        await assert.rejects(discoverUserTables(db), /found no table/);
    } finally {
        await pg.close();
    }
});

test('identifiers are quoted, so an odd table name cannot break or extend the count query', async () => {
    const sent = [];
    const db = { async query(sql, params) { sent.push({ sql, params }); return { rows: [{ n: 0 }] }; } };
    await userDataFootprint(db, 'u1', [{ table: 'we"ird', columns: ['user_id', 'x"y'] }]);
    assert.equal(sent[0].sql, 'SELECT COUNT(*)::int AS n FROM "we""ird" WHERE "user_id"::text = $1 OR "x""y"::text = $1');
    assert.deepEqual(sent[0].params, ['u1']);
    assert.match(DISCOVER_SQL, /^\s*SELECT\b/);
});
