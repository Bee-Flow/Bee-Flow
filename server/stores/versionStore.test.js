/**
 * versionStore: the `kind` column (autosave | published | pre_refine) and the
 * rule that only autosaves are pruned.
 *
 * The database is handed in — `createVersionStore(fakeDb)` — so this file
 * never touches require.cache. That matters beyond tidiness: the old version
 * parked a four-function double on the resolved path of db.js, and everything
 * any later suite in the same process required got that double instead of the
 * real module. Each test here also gets its OWN store, so one test's schema
 * init cannot satisfy the next one's.
 *
 * Run: cd server && node --test --test-force-exit stores/versionStore.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createVersionStore } = require('./versionStore');

const flat = (sql) => String(sql).replace(/\s+/g, ' ').trim();

/** An in-memory agent_versions table, plus the DDL it was asked to run. */
function fakeDb() {
    const ddl = [];
    const rows = [];
    return {
        ddl,
        rows,
        async exec(sql) { ddl.push(flat(sql)); },
        async getOne(sql, params) {
            const s = flat(sql);
            if (s.startsWith('SELECT MAX(version_number)')) {
                const mine = rows.filter(r => r.agent_id === params[0]);
                return { max_ver: mine.length ? Math.max(...mine.map(r => r.version_number)) : null };
            }
            if (s.startsWith('SELECT COUNT(*)')) {
                const onlyAuto = /kind = 'autosave'/.test(s);
                return { cnt: rows.filter(r => r.agent_id === params[0] && (!onlyAuto || r.kind === 'autosave')).length };
            }
            if (s.startsWith('SELECT snapshot FROM agent_versions')) {
                const mine = rows.filter(r => r.agent_id === params[0]).sort((a, b) => b.version_number - a.version_number);
                return mine[0] ? { snapshot: mine[0].snapshot } : null;
            }
            if (s.startsWith('SELECT * FROM agent_versions WHERE id')) return rows.find(r => r.id === params[0]) || null;
            return null;
        },
        async getAll(sql, params) {
            return rows.filter(r => r.agent_id === params[0]).sort((a, b) => b.version_number - a.version_number)
                .map(({ snapshot, ...rest }) => rest);
        },
        async run(sql, params) {
            const s = flat(sql);
            if (s.startsWith('INSERT INTO agent_versions')) {
                const [id, agent_id, agent_type, version_number, snapshot, change_summary, created_by, kind] = params;
                rows.push({ id, agent_id, agent_type, version_number, snapshot, change_summary, created_by, kind });
                return { rowCount: 1 };
            }
            if (s.startsWith('DELETE FROM agent_versions WHERE agent_id = $1 AND kind')) {
                const [agentId, , keep] = params;
                const auto = rows.filter(r => r.agent_id === agentId && r.kind === 'autosave').sort((a, b) => b.version_number - a.version_number);
                const keepIds = new Set(auto.slice(0, keep).map(r => r.id));
                let n = 0;
                for (let i = rows.length - 1; i >= 0; i--) {
                    const r = rows[i];
                    if (r.agent_id === agentId && r.kind === 'autosave' && !keepIds.has(r.id)) { rows.splice(i, 1); n++; }
                }
                return { rowCount: n };
            }
            return { rowCount: 0 };
        },
    };
}

const freshStore = () => { const db = fakeDb(); return { db, store: createVersionStore(db) }; };

test('schema adds kind with default autosave (existing rows become autosaves) — idempotent DDL', async () => {
    const { db, store } = freshStore();
    await store.pruneVersions('x'); // the first query is what creates the schema
    const add = db.ddl.find(s => /ALTER TABLE agent_versions ADD COLUMN IF NOT EXISTS kind/.test(s));
    assert.ok(add, 'kind column added lazily');
    assert.match(add, /DEFAULT 'autosave'/);
    for (const s of db.ddl) {
        if (s.startsWith('CREATE TABLE')) assert.match(s, /IF NOT EXISTS/);
        if (s.startsWith('CREATE INDEX')) assert.match(s, /IF NOT EXISTS/);
        if (s.startsWith('ALTER TABLE')) assert.match(s, /ADD COLUMN IF NOT EXISTS/);
    }
});

test('requiring the store creates nothing; the first query does', async () => {
    // The whole point of the boot/storeSchemas split: a module that is only
    // read must not issue DDL against whatever database the process points at.
    const { db, store } = freshStore();
    assert.deepEqual(db.ddl, [], 'no DDL yet');
    await store.getVersions('ag');
    assert.ok(db.ddl.length > 0, 'and now there is');
});

test('createVersion defaults to autosave; kind is stored and listed', async () => {
    const { store } = freshStore();
    const a = await store.createVersion('ag', 'agent', { name: 'x' }, 'u1', 'init');
    assert.equal(a.kind, 'autosave');
    const p = await store.createVersion('ag', 'agent', { name: 'x' }, 'u1', 'Published v1', { kind: 'published' });
    assert.equal(p.kind, 'published');
    assert.equal(p.version_number, 2, 'one numbering sequence across kinds');
    const junk = await store.createVersion('ag', 'agent', { name: 'x' }, 'u1', 's', { kind: 'bogus' });
    assert.equal(junk.kind, 'autosave', 'unknown kinds fall back to autosave');
    const list = await store.getVersions('ag');
    assert.deepEqual(list.map(v => v.kind), ['autosave', 'published', 'autosave']);
});

test('prune keeps 50 autosaves and never touches published / pre_refine rows', async () => {
    const { store } = freshStore();
    await store.createVersion('ag', 'agent', { n: 0 }, 'u', 'Published v1', { kind: 'published' });
    await store.createVersion('ag', 'agent', { n: 0 }, 'u', 'before refine', { kind: 'pre_refine' });
    for (let i = 1; i <= 60; i++) await store.createVersion('ag', 'agent', { n: i }, 'u', `auto ${i}`);
    const list = await store.getVersions('ag');
    const autos = list.filter(v => v.kind === 'autosave');
    assert.equal(autos.length, store.AUTOSAVE_KEEP);
    assert.equal(Math.min(...autos.map(v => v.version_number)), 13, 'the oldest autosaves went, newest 50 stay');
    assert.ok(list.some(v => v.kind === 'published' && v.version_number === 1), 'published row survived');
    assert.ok(list.some(v => v.kind === 'pre_refine' && v.version_number === 2), 'pre_refine row survived');
});

test('prune counts only autosaves (55 mixed rows with <=50 autosaves prune nothing)', async () => {
    const { db, store } = freshStore();
    for (let i = 0; i < 5; i++) await store.createVersion('ag', 'agent', { i }, 'u', 'p', { kind: 'published' });
    for (let i = 0; i < 50; i++) await store.createVersion('ag', 'agent', { i }, 'u', 'a');
    assert.equal(db.rows.length, 55);
});
