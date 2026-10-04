/**
 * Studio App store cross-tenant IDOR regression tests.
 *
 * Locks two invariants:
 *   1. every mutating query (UPDATE/DELETE + the locking SELECTs that gate
 *      them) carries user_id in its WHERE, so a foreign app/version id can
 *      never be written through by guessing it;
 *   2. contract paths that are documented meta-only (getStudioAppsByUser,
 *      getAccessibleStudioApps, listVersions) never select nor return the
 *      definition / published_definition / builder_session payloads.
 *
 * We mock ../db so the store is side-effect free and record every SQL +
 * params pair, then assert on the recorded statements. WHERE matching mimics
 * Postgres: a row must satisfy every `col = $n` equality after WHERE.
 *
 * Run: node --test stores/studioAppStore.idor.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { createRecordingDb } = require('../testUtils/mockDb');
const { installResolveStub } = require('../testUtils/stubRequire');

process.env.NODE_ENV = 'test';

// ── Recording mock for ../db ──────────────────────────────────────
const appRows = [
    {
        id: 'app-alice', user_id: 'alice', organization_id: 'org1', name: 'A', description: '',
        icon: null, accent_color: null, definition: '{"schemaVersion":1}', definition_version: 3,
        published_definition: '{"schemaVersion":1}', builder_session: '{"version":2,"messages":[]}',
        is_published: true, shared_groups: '[]', published_at: '2026-01-01T00:00:00Z',
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    },
    {
        id: 'app-bob', user_id: 'bob', organization_id: 'org1', name: 'B', description: '',
        icon: null, accent_color: null, definition: '{"secret":true}', definition_version: 5,
        published_definition: null, builder_session: '{"version":7,"messages":[{"role":"user","content":"bob private"}]}',
        is_published: true, shared_groups: '[]', published_at: null,
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    },
];
const versionRows = [
    { id: 'v-alice', app_id: 'app-alice', user_id: 'alice', definition: '{"v":"a"}', summary: 'Published', created_at: '2026-01-01T00:00:00Z' },
    { id: 'v-bob', app_id: 'app-bob', user_id: 'bob', definition: '{"v":"b"}', summary: 'Published', created_at: '2026-01-01T00:00:00Z' },
];

// Shared recording double. Two tables (apps + versions) route by name; the
// only query the equality matcher can't model is getAccessibleStudioApps'
// owner-OR-org-published disjunction, handled by the studio_apps matcher
// (which falls back to default equality for every other statement).
const mock = createRecordingDb({
    tables: { studio_app_versions: versionRows, studio_apps: appRows },
    matchers: {
        studio_apps: (rows, sql, params) => (/\bWHERE\b[\s\S]*\bOR\b/i.test(sql)
            ? rows.filter(r => r.user_id === params[0] ||
                (r.is_published === true && r.organization_id != null && (params[1] || []).includes(r.organization_id)))
            : undefined),
    },
});
installResolveStub({ '../db': mock.db });

const store = require('./studioAppStore');

const calls = mock.calls;
const reset = () => mock.reset();
const allMutations = () => mock.mutations();

// ── Mutations are owner-scoped ────────────────────────────────────

test('updateStudioApp carries user_id and refuses a foreign app', async () => {
    reset();
    const out = await store.updateStudioApp('app-bob', { name: 'hax' }, 'alice');
    assert.strictEqual(out, null, 'foreign app must not update');
    const lock = calls.client.find(c => /FOR UPDATE/i.test(c.sql));
    assert.match(lock.sql, /WHERE\s+id\s*=\s*\$1\s+AND\s+user_id\s*=\s*\$2/i, 'locking SELECT must scope by user_id');
    assert.deepStrictEqual(lock.params, ['app-bob', 'alice']);
    assert.ok(!calls.client.some(c => /^UPDATE/i.test(c.sql.trim())), 'no UPDATE after the failed lock');
});

test('saveDefinition enforces ownership in the locking SELECT', async () => {
    reset();
    const out = await store.saveDefinition('app-bob', 'alice', { hax: true });
    assert.deepStrictEqual(out, { ok: false, notFound: true });
    const lock = calls.client.find(c => /FOR UPDATE/i.test(c.sql));
    assert.match(lock.sql, /WHERE\s+id\s*=\s*\$1\s+AND\s+user_id\s*=\s*\$2/i, 'locking SELECT must scope by user_id');
    assert.deepStrictEqual(lock.params, ['app-bob', 'alice']);
    assert.ok(!calls.client.some(c => /^UPDATE/i.test(c.sql.trim())), 'no UPDATE after the failed lock');
});

test('setStudioAppPublished refuses a foreign app and writes nothing', async () => {
    reset();
    const ok = await store.setStudioAppPublished('app-bob', true, 'alice', [], 'org1');
    assert.strictEqual(ok, false);
    const lock = calls.client.find(c => /FOR UPDATE/i.test(c.sql));
    assert.match(lock.sql, /user_id\s*=\s*\$2/i, 'locking SELECT must scope by user_id');
    assert.ok(!calls.client.some(c => /^(UPDATE|INSERT)/i.test(c.sql.trim())),
        'no UPDATE and no version INSERT for a foreign app');
});

test('setStudioAppPublished UPDATE + version INSERT stay owner-scoped for the owner', async () => {
    reset();
    const ok = await store.setStudioAppPublished('app-alice', true, 'alice');
    assert.strictEqual(ok, true);
    const upd = calls.client.find(c => /^UPDATE studio_apps/i.test(c.sql.trim()));
    assert.match(upd.sql, /WHERE[\s\S]*user_id\s*=\s*\$\d+/i, 'publish UPDATE must scope by user_id');
    const ins = calls.client.find(c => /^INSERT INTO studio_app_versions/i.test(c.sql.trim()));
    assert.ok(ins, 'publish snapshots a version');
    assert.ok(ins.params.includes('alice'), 'snapshot row records the owner');
});

test('deleteStudioApp refuses a foreign app and issues no DELETE', async () => {
    reset();
    const out = await store.deleteStudioApp('app-bob', 'alice');
    assert.strictEqual(out, null);
    assert.ok(!calls.run.some(c => /^DELETE/i.test(c.sql.trim())), 'no DELETE for a foreign app');
    const lookup = calls.getOne.find(c => /FROM studio_apps/i.test(c.sql));
    assert.match(lookup.sql, /user_id\s*=\s*\$2/i, 'lookup must scope by user_id');
});

test('deleteStudioApp DELETE carries user_id for the owner', async () => {
    reset();
    const out = await store.deleteStudioApp('app-alice', 'alice');
    assert.ok(out && out.id === 'app-alice');
    const del = calls.client.find(c => /^DELETE FROM studio_apps/i.test(c.sql.trim()));
    assert.match(del.sql, /WHERE\s+id\s*=\s*\$1\s+AND\s+user_id\s*=\s*\$2/i);
    assert.deepStrictEqual(del.params, ['app-alice', 'alice']);
});

test('restoreVersion refuses foreign versions (both foreign app and foreign version under own app)', async () => {
    reset();
    // Bob's version under Bob's app, requested by alice.
    assert.strictEqual(await store.restoreVersion('app-bob', 'v-bob', 'alice'), null);
    // Bob's version id smuggled under Alice's own app.
    assert.strictEqual(await store.restoreVersion('app-alice', 'v-bob', 'alice'), null);
    const lookups = calls.client.filter(c => /FROM studio_app_versions/i.test(c.sql));
    for (const l of lookups) {
        assert.match(l.sql, /app_id\s*=\s*\$2\s+AND\s+user_id\s*=\s*\$3/i, 'version lookup must scope by app_id AND user_id');
    }
    assert.strictEqual(allMutations().length, 0, 'no writes on refused restores');
});

test('builder-session mutations are owner-scoped', async () => {
    reset();
    // Foreign write → forbidden, no UPDATE.
    const w = await store.setBuilderSession('app-bob', 'alice', { messages: [] });
    assert.deepStrictEqual(w, { ok: false, forbidden: true });
    assert.ok(!calls.client.some(c => /^UPDATE/i.test(c.sql.trim())), 'no UPDATE after the forbidden check');

    // clearBuilderSession carries user_id.
    reset();
    await store.clearBuilderSession('app-bob', 'alice');
    const clr = calls.run.find(c => /builder_session\s*=\s*NULL/i.test(c.sql));
    assert.match(clr.sql, /WHERE\s+id\s*=\s*\$1\s+AND\s+user_id\s*=\s*\$2/i);
    assert.deepStrictEqual(clr.params, ['app-bob', 'alice']);
});

// ── Non-owner / meta-only paths never leak payloads ───────────────

test('getBuilderSession returns null for a non-owner (never the snapshot)', async () => {
    reset();
    assert.strictEqual(await store.getBuilderSession('app-bob', 'alice'), null);
    const own = await store.getBuilderSession('app-bob', 'bob');
    assert.strictEqual(own.version, 7, 'owner still reads it');
});

test('listVersions is user-scoped and meta-only', async () => {
    reset();
    const foreign = await store.listVersions('app-bob', 'alice');
    assert.deepStrictEqual(foreign, [], 'foreign history is empty');
    const own = await store.listVersions('app-alice', 'alice');
    assert.strictEqual(own.length, 1);
    assert.ok(!('definition' in own[0]), 'listVersions must not return the definition payload');
    const q = calls.getAll.find(c => /FROM studio_app_versions/i.test(c.sql));
    assert.match(q.sql, /user_id\s*=\s*\$2/i, 'listVersions must scope by user_id');
    const sel = q.sql.match(/^\s*SELECT([\s\S]*?)FROM/i)[1];
    assert.ok(!/\bdefinition\b/i.test(sel), 'listVersions must not select the definition column');
});

test('getVersion refuses a foreign version id under an owned app', async () => {
    reset();
    assert.strictEqual(await store.getVersion('app-alice', 'v-bob', 'alice'), null);
    assert.strictEqual(await store.getVersion('app-bob', 'v-bob', 'alice'), null);
    const q = calls.getOne.find(c => /FROM studio_app_versions/i.test(c.sql));
    assert.match(q.sql, /app_id\s*=\s*\$2\s+AND\s+user_id\s*=\s*\$3/i);
});

test('app list queries are meta-only: no definition/builder_session in SELECT or output', async () => {
    reset();
    const mine = await store.getStudioAppsByUser('alice');
    const visible = await store.getAccessibleStudioApps('alice', [], ['org1']);
    assert.ok(visible.some(a => a.id === 'app-bob'), 'org-published foreign app is listed');
    for (const row of [...mine, ...visible]) {
        assert.ok(!('definition' in row), 'list rows must not carry definition');
        assert.ok(!('publishedDefinition' in row), 'list rows must not carry published_definition');
        assert.ok(!('builderSession' in row), 'list rows must not carry builder_session');
    }
    for (const c of calls.getAll.filter(c => /FROM studio_apps/i.test(c.sql))) {
        const sel = c.sql.match(/^\s*SELECT([\s\S]*?)FROM/i)[1];
        assert.ok(!/\*/.test(sel), 'list queries must not SELECT *');
        assert.ok(!/\bdefinition\b/i.test(sel), 'list queries must not select definition');
        assert.ok(!/\bpublished_definition\b/i.test(sel), 'list queries must not select published_definition');
        assert.ok(!/\bbuilder_session\b/i.test(sel), 'list queries must not select builder_session');
    }
});
