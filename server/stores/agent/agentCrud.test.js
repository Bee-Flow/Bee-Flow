/**
 * Store-level tests for updateAgent's optimistic-concurrency (CAS) behaviour.
 * `../../db`, `./initSchema` and `../versionStore` are mocked via the
 * Module._resolveFilename harness so no DB/pool is opened.
 *
 * Run: cd server && node --test stores/agent/agentCrud.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── In-memory single-row "agents" table ─────────────────────────────
const table = new Map(); // id → { id, owner_id, rev, ...cols }

function seed(id, ownerId, rev, extra = {}) {
    table.set(id, { id, owner_id: ownerId, rev, name: 'seed', config: '{}', ...extra });
}

const mockDb = {
    async exec() {},
    async getOne(sql, params) {
        if (/SELECT \* FROM agents WHERE id = \$1/.test(sql)) {
            const r = table.get(params[0]);
            return r ? { ...r } : null;
        }
        if (/SELECT rev, owner_id FROM agents WHERE id = \$1/.test(sql)) {
            const r = table.get(params[0]);
            return r ? { rev: r.rev, owner_id: r.owner_id } : null;
        }
        return null;
    },
    async getAll() { return []; },
    async run(sql, params) {
        if (/^UPDATE agents SET name=/.test(sql)) {
            const id = params[14];
            const ownerId = params[15];
            const hasGuard = /AND rev = \$17/.test(sql);
            const expectedRev = hasGuard ? params[16] : null;
            const row = table.get(id);
            if (!row || row.owner_id !== ownerId) return { rowCount: 0 };
            if (hasGuard && row.rev !== expectedRev) return { rowCount: 0 };
            row.rev += 1;
            row.name = params[0];
            // The three optional columns the SET list always writes — recorded so
            // "omitted argument must not wipe the column" is assertable.
            row.organization_id = params[11];
            row.shared_groups = params[12];
            row.category_id = params[13];
            return { rowCount: 1 };
        }
        return { rowCount: 0 };
    },
};

const versionCalls = [];
const mockVersionStore = { async createVersion(...a) { versionCalls.push(a); } };

const MOCKS = {
    '../../db': mockDb,
    './initSchema': { initDB: async () => {} },
    '../versionStore': mockVersionStore,
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:agentcrud:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    // Only redirect requires coming from agentCrud.js itself.
    if (parent && /agentCrud\.js$/.test(parent.filename) && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const agentCrud = require('./agentCrud');

// updateAgent(id, name, description, systemPrompt, ownerId, model, starterPrompts,
//   avatar, threadsEnabled, copyEnabled, workspaceEnabled, config, embedEnabled,
//   organizationId, sharedGroups, categoryId, opts)
function update(id, ownerId, opts) {
    return agentCrud.updateAgent(id, 'new name', 'd', 'sp', ownerId, null, [], null, true, true, false, {}, false, null, undefined, undefined, opts);
}

test.beforeEach(() => { table.clear(); versionCalls.length = 0; });

test('matching expectedRev succeeds, bumps rev, snapshots once', async () => {
    seed('a1', 'owner', 3);
    const res = await update('a1', 'owner', { expectedRev: 3 });
    assert.deepStrictEqual(res, { ok: true, rev: 4 });
    assert.strictEqual(table.get('a1').rev, 4);
    assert.strictEqual(versionCalls.length, 1, 'exactly one version snapshot on success');
});

test('stale expectedRev returns conflict with currentRev and writes NO snapshot', async () => {
    seed('a1', 'owner', 5);
    const res = await update('a1', 'owner', { expectedRev: 3 });
    assert.deepStrictEqual(res, { ok: false, conflict: true, currentRev: 5 });
    assert.strictEqual(table.get('a1').rev, 5, 'rev unchanged on conflict');
    assert.strictEqual(versionCalls.length, 0, 'no snapshot on a rejected save');
});

test('no expectedRev is unguarded last-write-wins (backward compatible)', async () => {
    seed('a1', 'owner', 9);
    const res = await update('a1', 'owner', {});
    assert.deepStrictEqual(res, { ok: true, rev: 10 });
});

test('missing row / wrong owner returns notFound (not conflict)', async () => {
    seed('a1', 'owner', 2);
    const res = await update('a1', 'someone-else', { expectedRev: 2 });
    assert.deepStrictEqual(res, { ok: false, notFound: true });
});

// ── undefined means "not supplied", never "clear it" ────────────────
// routes/versions.js (version restore) calls updateAgent with exactly 15
// positional arguments and never reaches categoryId. Collapsing that undefined
// to null silently detached the restored agent from its org category.

const CATEGORISED = { organization_id: 'org-1', shared_groups: '["grp-A"]', category_id: 'cat-42' };
const cols = (id) => {
    const r = table.get(id);
    return { organization_id: r.organization_id, shared_groups: r.shared_groups, category_id: r.category_id };
};

test('a 15-argument restore (no categoryId) preserves category_id', async () => {
    seed('a1', 'owner', 1, CATEGORISED);
    const res = await agentCrud.updateAgent('a1', 'restored', 'd', 'sp', 'owner', null, [], null,
        true, true, false, {}, false, 'org-1', ['grp-A']);   // 15 args — stops at sharedGroups
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(cols('a1'), CATEGORISED, 'restore must not detach the agent from its category');
});

test('omitting organizationId / sharedGroups / categoryId preserves all three', async () => {
    seed('a1', 'owner', 1, CATEGORISED);
    await agentCrud.updateAgent('a1', 'renamed', 'd', 'sp', 'owner', null, [], null, true, true, false, {}, false);
    assert.deepStrictEqual(cols('a1'), CATEGORISED);
});

test('explicit null / [] still CLEARS — preserve must not become un-clearable', async () => {
    seed('a1', 'owner', 1, CATEGORISED);
    await agentCrud.updateAgent('a1', 'cleared', 'd', 'sp', 'owner', null, [], null, true, true, false, {}, false, null, [], null);
    assert.deepStrictEqual(cols('a1'), { organization_id: null, shared_groups: '[]', category_id: null });
});

test('a shared_groups value stored as an array is written back as JSON text', async () => {
    seed('a1', 'owner', 1, { ...CATEGORISED, shared_groups: ['grp-A'] });
    await agentCrud.updateAgent('a1', 'renamed', 'd', 'sp', 'owner', null, [], null, true, true, false, {}, false);
    assert.strictEqual(table.get('a1').shared_groups, '["grp-A"]');
});

test.after(() => { Module._resolveFilename = originalResolve; });
