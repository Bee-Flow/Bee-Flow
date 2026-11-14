/**
 * Filing an agent into a Solution.
 *
 * Three hooks, and each of them is one half of a pair that has drifted in this
 * codebase before: a `project_id` column with nothing that reads it, and a
 * `detaches: true` with no detacher behind it. The registry
 * (projects/membership.js) is what forces them to exist; this file is what
 * pins WHAT THEY WRITE.
 *
 * The load-bearing assertions:
 *
 *   1. OWNER-ONLY, IN THE WHERE CLAUSE. Filing an agent into a project exposes
 *      it to every member of that project without it being published to the
 *      organisation. A check done first and a write done second can race; a
 *      predicate cannot.
 *   2. THE LISTING IS NARROW. `config` is the agent's tool grants, its
 *      knowledge bases and its skills; `system_prompt` is its instructions.
 *      Neither belongs in a list of names, and the columns are named in the
 *      SELECT rather than starred so a column added next year does not join
 *      the payload on its own.
 *   3. DETACHING NEVER DELETES. A project delete clears the reference. Nothing
 *      else.
 *
 * Against a real Postgres (PGlite behind db.js's pool, testUtils/pglitePool.js)
 * with the agent store's own schema. The pool notes the columns of every
 * answer, which is how "the listing is narrow" is read off the database.
 *
 * Run: cd server && node --test stores/agent/agentCrud.project.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { usePglitePool } = require('../../testUtils/pglitePool');
const db = require('../../db');

const { pg, close } = usePglitePool();
/** The column names of every answer the database gave, in order. */
const answered = [];
const query = db.pool.query;
db.pool.query = /** @type {any} */ (async (...args) => {
    const r = await query(...args);
    answered.push((r.fields || []).map((f) => f.name));
    return r;
});
const agentSchema = require('./initSchema');
const store = require('./agentCrud');

test.before(async () => {
    await pg.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, "organizationId" TEXT)`);
    await agentSchema.initDB();
});
test.after(close);

async function reset() {
    await pg.exec('DELETE FROM agents');
    answered.length = 0;
}
/** @param {string} id @param {string} owner @param {string | null} projectId @param {string} [updatedAt] */
const agent = (id, owner, projectId, updatedAt = '2026-01-01T00:00:00Z') => pg.query(
    `INSERT INTO agents (id, name, description, owner_id, project_id, system_prompt, config, rev, updated_at)
     VALUES ($1, $1, 'd', $2, $3, 'secret instructions', '{"tools":["x"]}', 4, $4)`, [id, owner, projectId, updatedAt]);
const agentRow = async (id) => (await pg.query('SELECT project_id, rev, updated_at FROM agents WHERE id = $1', [id])).rows[0];

// ═══ Listing ═════════════════════════════════════════════════════════

test('the listing asks for one project and orders by recency', async () => {
    await reset();
    await agent('ag_old', 'alice', 'p1', '2026-01-01T00:00:00Z');
    await agent('ag_new', 'bob', 'p1', '2026-02-01T00:00:00Z');
    await agent('ag_other', 'alice', 'p2');
    await agent('ag_loose', 'alice', null);

    const list = await store.listProjectAgents('p1');

    assert.deepStrictEqual(list.map(a => a.id), ['ag_new', 'ag_old']);
    assert.deepStrictEqual(Object.keys(list[0]).sort(), ['avatar', 'description', 'id', 'name', 'ownerId', 'projectId', 'updatedAt']);
    assert.deepStrictEqual({ ...list[0], updatedAt: undefined }, {
        id: 'ag_new', name: 'ag_new', description: 'd', avatar: null,
        ownerId: 'bob', projectId: 'p1', updatedAt: undefined,
    });
});

test('the listing names its columns instead of starring them', async () => {
    // A `SELECT *` here would put every column added to `agents` next year into
    // a payload every project member reads, without anyone deciding to. The
    // ones below are the ones that must never be in it today.
    await reset();
    await agent('ag1', 'alice', 'p1');
    answered.length = 0;
    await store.listProjectAgents('p1');
    const columns = answered.at(-1);
    assert.deepStrictEqual([...columns].sort(), ['avatar', 'description', 'id', 'name', 'owner_id', 'project_id', 'updated_at']);
    for (const forbidden of ['config', 'system_prompt', 'shared_groups', 'published_config']) {
        assert.ok(!columns.includes(forbidden), `${forbidden} is not in the listing`);
    }
});

test('no project id means an empty list, never the agents without a project', async () => {
    await reset();
    await agent('ag_loose', 'alice', null);
    assert.deepStrictEqual(await store.listProjectAgents(null), []);
    assert.deepStrictEqual(await store.listProjectAgents(''), []);
});

// ═══ Filing in and out ═══════════════════════════════════════════════

test('filing in matches on the OWNER, not just the id', async () => {
    await reset();
    await agent('ag1', 'alice', null);
    assert.strictEqual(await store.setAgentProject('ag1', 'alice', 'p1'), true);
    assert.strictEqual((await agentRow('ag1')).project_id, 'p1');
});

test('a write that matched nothing is reported as false, never as success', async () => {
    await reset();
    await agent('ag1', 'alice', null);
    assert.strictEqual(await store.setAgentProject('ag1', 'mallory', 'p1'), false);
    assert.strictEqual((await agentRow('ag1')).project_id, null, 'someone else\'s agent stays where it was');
    assert.strictEqual(await store.setAgentProject('ag_missing', 'alice', 'p1'), false);
});

test('taking an agent out writes a real NULL', async () => {
    await reset();
    await agent('ag1', 'alice', 'p1');
    assert.strictEqual(await store.setAgentProject('ag1', 'alice', null), true);
    assert.strictEqual((await agentRow('ag1')).project_id, null);
    await store.setAgentProject('ag1', 'alice', 'p1');
    await store.setAgentProject('ag1', 'alice', '');
    assert.strictEqual((await agentRow('ag1')).project_id, null, 'an empty id is no project, not a project called ""');
});

test('filing does NOT bump rev', async () => {
    // `rev` is the editor's optimistic-concurrency token over the agent's
    // concept. Membership changes no part of that, and bumping it would make an
    // open editor's next save collide with a change it cannot even see.
    await reset();
    await agent('ag1', 'alice', null);
    await store.setAgentProject('ag1', 'alice', 'p1');
    assert.strictEqual((await agentRow('ag1')).rev, 4, 'membership is not a concept edit');
});

// ═══ Detaching ═══════════════════════════════════════════════════════

test('a deleted project clears the reference and nothing else', async () => {
    await reset();
    await agent('a1', 'alice', 'p1');
    await agent('a2', 'bob', 'p1');
    await agent('a3', 'carol', 'p1');
    await agent('keep', 'alice', 'p2');
    const cleared = await store.clearProjectFromAgents('p1');

    assert.strictEqual(cleared, 3);
    const { rows } = await pg.query('SELECT id, project_id FROM agents ORDER BY id');
    assert.deepStrictEqual(rows, [
        { id: 'a1', project_id: null }, { id: 'a2', project_id: null }, { id: 'a3', project_id: null },
        { id: 'keep', project_id: 'p2' },
    ], 'deleting a project must never destroy an agent');
});
