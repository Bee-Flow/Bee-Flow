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
 * No database: `../../db` is stubbed, and every assertion is about the SQL and
 * the parameters that reach it.
 *
 * Run: cd server && node --test --test-force-exit stores/agent/agentCrud.project.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const sql = { run: [], getAll: [], getOne: [] };
let nextRunResult = { rowCount: 1 };
let nextRows = [];

const mockDb = {
    async exec() {},
    async run(text, params) { sql.run.push({ text, params }); return nextRunResult; },
    async getAll(text, params) { sql.getAll.push({ text, params }); return nextRows; },
    async getOne(text, params) { sql.getOne.push({ text, params }); return null; },
};

const MOCKS = {
    '../../db': mockDb,
    './initSchema': { initDB: async () => {} },
    './agentTools': {
        getAgentTools: async () => [],
        getAgentToolsWithParams: async () => [],
        getAgentToolsBatch: async () => new Map(),
        getAgentToolsWithParamsBatch: async () => new Map(),
    },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:agentProject:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /agent[\\/]agentCrud\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const store = require('./agentCrud');
test.after(() => { Module._resolveFilename = originalResolve; });

function reset() {
    sql.run.length = 0; sql.getAll.length = 0; sql.getOne.length = 0;
    nextRunResult = { rowCount: 1 };
    nextRows = [];
}

// ═══ Listing ═════════════════════════════════════════════════════════

test('the listing asks for one project and orders by recency', async () => {
    reset();
    nextRows = [{ id: 'ag1', name: 'Helper', description: 'd', avatar: null, owner_id: 'alice', project_id: 'p1', updated_at: 'T' }];

    const list = await store.listProjectAgents('p1');

    assert.strictEqual(sql.getAll.length, 1);
    assert.match(sql.getAll[0].text, /WHERE project_id = \$1/);
    assert.deepStrictEqual(sql.getAll[0].params, ['p1']);
    assert.deepStrictEqual(list, [{
        id: 'ag1', name: 'Helper', description: 'd', avatar: null,
        ownerId: 'alice', projectId: 'p1', updatedAt: 'T',
    }]);
});

test('the listing names its columns instead of starring them', async () => {
    // A `SELECT *` here would put every column added to `agents` next year into
    // a payload every project member reads, without anyone deciding to. The
    // three below are the ones that must never be in it today.
    reset();
    await store.listProjectAgents('p1');
    const text = sql.getAll[0].text;
    assert.ok(!/SELECT \*/.test(text), 'the columns are named');
    for (const forbidden of ['config', 'system_prompt', 'shared_groups', 'published_config']) {
        assert.ok(!new RegExp(`\\b${forbidden}\\b`).test(text), `${forbidden} is not in the listing`);
    }
});

test('no project id means no query at all, and an empty list', async () => {
    reset();
    assert.deepStrictEqual(await store.listProjectAgents(null), []);
    assert.deepStrictEqual(await store.listProjectAgents(''), []);
    assert.strictEqual(sql.getAll.length, 0, 'a missing id must not become WHERE project_id = NULL');
});

// ═══ Filing in and out ═══════════════════════════════════════════════

test('filing in matches on the OWNER, not just the id', async () => {
    reset();
    const ok = await store.setAgentProject('ag1', 'alice', 'p1');

    assert.strictEqual(ok, true);
    assert.strictEqual(sql.run.length, 1);
    assert.match(sql.run[0].text, /UPDATE agents SET project_id = \$1/);
    assert.match(sql.run[0].text, /WHERE id = \$2 AND owner_id = \$3/);
    assert.deepStrictEqual(sql.run[0].params, ['p1', 'ag1', 'alice']);
});

test('a write that matched nothing is reported as false, never as success', async () => {
    reset();
    nextRunResult = { rowCount: 0 };
    assert.strictEqual(await store.setAgentProject('ag1', 'mallory', 'p1'), false);
});

test('taking an agent out writes a real NULL', async () => {
    reset();
    await store.setAgentProject('ag1', 'alice', null);
    assert.strictEqual(sql.run[0].params[0], null);
});

test('filing does NOT bump rev', async () => {
    // `rev` is the editor's optimistic-concurrency token over the agent's
    // concept. Membership changes no part of that, and bumping it would make an
    // open editor's next save collide with a change it cannot even see.
    reset();
    await store.setAgentProject('ag1', 'alice', 'p1');
    assert.ok(!/rev/.test(sql.run[0].text), 'membership is not a concept edit');
});

// ═══ Detaching ═══════════════════════════════════════════════════════

test('a deleted project clears the reference and nothing else', async () => {
    reset();
    nextRunResult = { rowCount: 3 };
    const cleared = await store.clearProjectFromAgents('p1');

    assert.strictEqual(cleared, 3);
    assert.strictEqual(sql.run.length, 1);
    assert.match(sql.run[0].text, /UPDATE agents SET project_id = NULL WHERE project_id = \$1/);
    assert.ok(!/DELETE/i.test(sql.run[0].text), 'deleting a project must never destroy an agent');
    assert.deepStrictEqual(sql.run[0].params, ['p1']);
});
