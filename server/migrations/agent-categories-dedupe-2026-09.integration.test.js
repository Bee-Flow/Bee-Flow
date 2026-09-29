/**
 * agent-categories-dedupe-2026-09 against real Postgres (@electric-sql/pglite),
 * handed to up() through its `db` / `initSchema` seams, so db.js is never
 * swapped out in the module cache.
 *
 * Under test:
 *   - --dry-run reports the groups and writes nothing;
 *   - "Sales" / "sales" / "SALES" in one org collapse into the OLDEST row, the
 *     agents of the dropped rows move to it with `rev` bumped, and an agent
 *     already on the keeper is left alone;
 *   - created_at decides, then id; a row without created_at never wins over
 *     one with it;
 *   - the same name in another org, and in the NULL org, is not a duplicate;
 *   - idx_agent_categories_org_lname exists afterwards and refuses a new
 *     case-variant;
 *   - a second run is a no-op;
 *   - a statement failing mid-merge rejects and rolls the whole run back
 *     (no ledger entry, so the next boot retries), and the retry then works;
 *   - a missing agent schema is a logged early return, not a crash.
 *
 * Run: cd server && node --test migrations/agent-categories-dedupe-2026-09.integration.test.js
 */

const { test, before } = require('node:test');
const assert = require('node:assert');

const { PGlite } = require('@electric-sql/pglite');

const { up, INDEX_SQL } = require('./agent-categories-dedupe-2026-09');

function adaptResult(res) {
    const r = Array.isArray(res) ? (res[res.length - 1] || {}) : (res || {});
    const rows = r.rows || [];
    const rowCount = (r.fields || []).length > 0
        ? rows.length
        : (typeof r.affectedRows === 'number' ? r.affectedRows : 0);
    return { rows, rowCount };
}

/** The slice of the db.js facade the migration uses, over one PGlite connection. */
function facadeFor(pg, { failOn = null } = {}) {
    const query = async (sql, params) => {
        if (failOn && failOn.test(sql)) throw Object.assign(new Error('injected failure'), { code: 'XX000' });
        if (Array.isArray(params) && params.length > 0) return adaptResult(await pg.query(sql, params));
        return adaptResult(await pg.query(sql));
    };
    const client = { query };
    return {
        getOne: async (sql, params) => (await query(sql, params)).rows[0] || null,
        getAll: async (sql, params) => (await query(sql, params)).rows,
        // A real transaction, like db.withTransaction: the rollback test is
        // only meaningful if BEGIN/ROLLBACK actually reach Postgres.
        withTransaction: async (fn) => {
            await query('BEGIN');
            try {
                const out = await fn(client);
                await query('COMMIT');
                return out;
            } catch (e) {
                try { await query('ROLLBACK'); } catch { /* already aborted */ }
                throw e;
            }
        },
    };
}

// The columns the migration reads and writes, as stores/agent/initSchema.js
// creates them (minus the unique index: that is what production lacks).
const SCHEMA = `
    CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        category_id TEXT,
        rev INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE agent_categories (
        id TEXT PRIMARY KEY,
        organization_id TEXT,
        name TEXT NOT NULL,
        icon TEXT DEFAULT '📁',
        color TEXT DEFAULT '#6366f1',
        created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX idx_agent_categories_org ON agent_categories(organization_id);
`;

const OLD = '2020-01-01T00:00:00Z';

async function seed(pg) {
    await pg.exec(SCHEMA);
    const cats = [
        // org-a: three case-variants; the oldest ('c-a-3') must win, not the
        // lowest id and not the first inserted.
        ['c-a-1', 'org-a', 'sales', '2024-02-01T00:00:00Z'],
        ['c-a-2', 'org-a', 'SALES', '2024-03-01T00:00:00Z'],
        ['c-a-3', 'org-a', 'Sales', '2024-01-01T00:00:00Z'],
        // org-a: same created_at, so the id breaks the tie.
        ['c-a-5', 'org-a', 'support', '2024-01-01T00:00:00Z'],
        ['c-a-4', 'org-a', 'Support', '2024-01-01T00:00:00Z'],
        // org-a: an unknown age never beats a known one.
        ['c-a-6', 'org-a', 'ops', null],
        ['c-a-7', 'org-a', 'Ops', '2025-01-01T00:00:00Z'],
        // Same name, other buckets: not duplicates of org-a's.
        ['c-b-1', 'org-b', 'Sales', '2023-01-01T00:00:00Z'],
        ['c-g-1', null, 'Sales', '2023-01-01T00:00:00Z'],
        // The NULL org is a bucket of its own and merges within itself.
        ['c-g-2', null, 'Global', '2023-01-01T00:00:00Z'],
        ['c-g-3', null, 'GLOBAL', '2023-06-01T00:00:00Z'],
    ];
    for (const [id, org, name, createdAt] of cats) {
        await pg.query(
            'INSERT INTO agent_categories (id, organization_id, name, created_at) VALUES ($1, $2, $3, $4)',
            [id, org, name, createdAt]);
    }
    const agents = [
        ['ag-1', 'c-a-1'], // dropped "sales"  -> keeper
        ['ag-2', 'c-a-2'], // dropped "SALES"  -> keeper
        ['ag-3', 'c-a-3'], // already on the keeper: untouched
        ['ag-4', 'c-a-5'], // dropped "support" -> c-a-4
        ['ag-5', 'c-a-6'], // dropped "ops" (no created_at) -> c-a-7
        ['ag-6', 'c-b-1'], // other org: untouched
        ['ag-7', 'c-g-3'], // NULL-org duplicate -> c-g-2
        ['ag-8', null],
    ];
    for (const [id, cat] of agents) {
        await pg.query(
            'INSERT INTO agents (id, name, owner_id, category_id, rev, updated_at) VALUES ($1, $1, $2, $3, 1, $4)',
            [id, 'u-1', cat, OLD]);
    }
}

async function snapshot(pg) {
    const cats = (await pg.query('SELECT id, organization_id, name FROM agent_categories ORDER BY id')).rows;
    const agents = (await pg.query(
        `SELECT id, category_id, rev, updated_at = $1::timestamptz AS pristine FROM agents ORDER BY id`, [OLD])).rows;
    const index = (await pg.query(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_agent_categories_org_lname'`)).rows;
    return { cats, agents, index };
}

const noSchemaInit = async () => {};

const pg = new PGlite();
let db;

before(async () => {
    await seed(pg);
    db = facadeFor(pg);
});

test('registered in LOOSE_MIGRATIONS and builds the boot DDL\'s own index statement', () => {
    const { LOOSE_MIGRATIONS } = require('../boot/bootMigrations');
    assert.ok(LOOSE_MIGRATIONS.includes('agent-categories-dedupe-2026-09'),
        'an unregistered migration never runs');
    const { AGENT_CATEGORY_NAME_INDEX_SQL } = require('../stores/agent/initSchema');
    assert.strictEqual(INDEX_SQL, AGENT_CATEGORY_NAME_INDEX_SQL,
        'a same-named index with another definition would make IF NOT EXISTS skip the boot version');
});

test('the agent schema is awaited before anything is read', async () => {
    const order = [];
    const spyDb = {
        ...db,
        getOne: async (...a) => { order.push('read'); return db.getOne(...a); },
        getAll: async (...a) => { order.push('read'); return db.getAll(...a); },
    };
    await up({ dryRun: true, db: spyDb, initSchema: async () => { order.push('init'); } });
    assert.strictEqual(order[0], 'init');
});

test('--dry-run reports the groups and writes nothing', async () => {
    const beforeState = await snapshot(pg);
    const res = await up({ dryRun: true, db, initSchema: noSchemaInit });
    assert.deepStrictEqual(res, { groups: 4, removed: 5, agentsMoved: 5, dryRun: true });
    assert.deepStrictEqual(await snapshot(pg), beforeState);
});

test('each group collapses into its oldest row; agents follow with a rev bump; other buckets are untouched', async () => {
    const res = await up({ db, initSchema: noSchemaInit });
    assert.deepStrictEqual(res, { groups: 4, removed: 5, agentsMoved: 5, dryRun: false });

    const { cats, agents } = await snapshot(pg);
    assert.deepStrictEqual(cats.map((c) => c.id), ['c-a-3', 'c-a-4', 'c-a-7', 'c-b-1', 'c-g-1', 'c-g-2'],
        'keepers: oldest created_at (c-a-3), id tiebreak (c-a-4), known age over NULL (c-a-7), NULL-org oldest (c-g-2)');
    assert.strictEqual(cats.find((c) => c.id === 'c-a-3').name, 'Sales', 'the keeper keeps its own spelling');

    const byId = Object.fromEntries(agents.map((a) => [a.id, a]));
    for (const [id, cat] of [['ag-1', 'c-a-3'], ['ag-2', 'c-a-3'], ['ag-4', 'c-a-4'], ['ag-5', 'c-a-7'], ['ag-7', 'c-g-2']]) {
        assert.strictEqual(byId[id].category_id, cat, `${id} re-pointed`);
        assert.strictEqual(byId[id].rev, 2, `${id}: rev bumped so an open editor reconciles via 409`);
        assert.strictEqual(byId[id].pristine, false, `${id}: updated_at moved`);
    }
    for (const [id, cat] of [['ag-3', 'c-a-3'], ['ag-6', 'c-b-1'], ['ag-8', null]]) {
        assert.strictEqual(byId[id].category_id, cat, `${id} untouched`);
        assert.strictEqual(byId[id].rev, 1, `${id}: no rev bump without a move`);
        assert.strictEqual(byId[id].pristine, true, `${id}: updated_at untouched`);
    }
});

test('the unique index exists afterwards and refuses a new case-variant', async () => {
    const { index } = await snapshot(pg);
    assert.strictEqual(index.length, 1);
    assert.match(index[0].indexdef, /CREATE UNIQUE INDEX idx_agent_categories_org_lname/);
    assert.match(index[0].indexdef, /COALESCE\(organization_id, ''::text\), lower\(name\)/);

    await assert.rejects(
        pg.query(`INSERT INTO agent_categories (id, organization_id, name) VALUES ('c-a-9', 'org-a', 'sALES')`),
        (e) => e.code === '23505');
    // The same name in a fresh org is still fine.
    await pg.query(`INSERT INTO agent_categories (id, organization_id, name) VALUES ('c-c-1', 'org-c', 'sALES')`);
});

test('a second run is a no-op', async () => {
    const beforeState = await snapshot(pg);
    const res = await up({ db, initSchema: noSchemaInit });
    assert.deepStrictEqual(res, { groups: 0, removed: 0, agentsMoved: 0, dryRun: false });
    assert.deepStrictEqual(await snapshot(pg), beforeState);
});

test('a statement failing mid-merge rejects and rolls everything back; the retry then succeeds', async () => {
    const pg2 = new PGlite();
    await seed(pg2);
    // A real Postgres error on the first DELETE, after the first agent UPDATE
    // has already run inside the transaction.
    await pg2.exec(`
        CREATE FUNCTION refuse_delete() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'refused by test'; END $$;
        CREATE TRIGGER refuse_delete BEFORE DELETE ON agent_categories
            FOR EACH ROW EXECUTE FUNCTION refuse_delete();
    `);
    const beforeState = await snapshot(pg2);

    await assert.rejects(up({ db: facadeFor(pg2), initSchema: noSchemaInit }), /refused by test/,
        'up() must throw so runList leaves it out of the ledger and the next boot retries');
    assert.deepStrictEqual(await snapshot(pg2), beforeState,
        'no re-pointed agent, no deleted row, no index: the transaction rolled back as a whole');

    // A failure outside Postgres (the index statement) rolls back the same way.
    await pg2.exec('DROP TRIGGER refuse_delete ON agent_categories');
    await assert.rejects(up({ db: facadeFor(pg2, { failOn: /^CREATE UNIQUE INDEX/ }), initSchema: noSchemaInit }),
        /injected failure/);
    assert.deepStrictEqual(await snapshot(pg2), beforeState);

    const res = await up({ db: facadeFor(pg2), initSchema: noSchemaInit });
    assert.deepStrictEqual(res, { groups: 4, removed: 5, agentsMoved: 5, dryRun: false });
    assert.strictEqual((await snapshot(pg2)).index.length, 1);
    await pg2.close();
});

test('a failing schema init rejects instead of recording the migration as applied', async () => {
    await assert.rejects(
        up({ db, initSchema: async () => { throw new Error('connection terminated'); } }),
        /connection terminated/);
});

test('a missing agent schema is a logged early return', async () => {
    const empty = new PGlite();
    const res = await up({ db: facadeFor(empty), initSchema: noSchemaInit });
    assert.deepStrictEqual(res, { groups: 0, removed: 0, agentsMoved: 0, dryRun: false, skipped: 'schema' });
    await empty.close();
});
