/**
 * agents-published-config: the schema half is replay-safe, the backfill half
 * is idempotent, skips system agents, and writes nothing on --dry-run.
 * The pg layer is mocked via require.cache.
 *
 * Run: cd server && node --test --test-force-exit migrations/agents-published-config.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ddl = [];
const writes = [];
let rows = [];
const flat = (sql) => String(sql).replace(/\s+/g, ' ').trim();

// The migration destructures `getAll` at load time, so a per-test override
// has to go through this hook rather than by reassigning fakeDb.getAll.
let afterSelect = null;

const fakeDb = {
    async exec(sql) { ddl.push(flat(sql)); },
    async getAll(sql) {
        const s = flat(sql);
        assert.match(s, /owner_id NOT IN \('system', 'swarm'\)/);
        assert.match(s, /published_version = 0/);
        const out = rows
            .filter(r => !['system', 'swarm'].includes(r.owner_id) && r.published_version === 0 && r.published_config == null)
            .map(r => ({ id: r.id, config: r.config, rev: r.rev }));
        if (afterSelect) afterSelect();
        return out;
    },
    async run(sql, params) {
        const s = flat(sql);
        writes.push({ sql: s, params });
        const [cfg, id, rev] = params;
        const r = rows.find(x => x.id === id);
        if (!r || r.rev !== rev || r.published_version !== 0 || ['system', 'swarm'].includes(r.owner_id)) return { rowCount: 0 };
        r.published_config = JSON.parse(cfg);
        r.published_system_prompt = r.system_prompt;
        r.published_version = 1;
        r.published_rev = r.rev;
        return { rowCount: 1 };
    },
    async getOne() { return null; },
};

const dbPath = require.resolve(path.join(__dirname, '..', 'db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const migration = require('./agents-published-config');

test.beforeEach(() => {
    ddl.length = 0; writes.length = 0;
    rows = [
        { id: 'a1', owner_id: 'u1', rev: 3, system_prompt: 'p1', config: '{"knowledge_base_ids":["kb1"]}', published_version: 0, published_config: null },
        { id: 'a2', owner_id: 'u2', rev: 1, system_prompt: 'p2', config: 'not json', published_version: 0, published_config: null },
        { id: 'sys', owner_id: 'system', rev: 1, system_prompt: 'sup', config: '{}', published_version: 0, published_config: null },
        { id: 'done', owner_id: 'u1', rev: 5, system_prompt: 'p', config: '{}', published_version: 2, published_config: { a: 1 }, published_rev: 5 },
    ];
});

test('up() is schema only and survives a replay', async () => {
    await migration.up();
    await migration.up();
    assert.equal(ddl.length, 2);
    assert.equal(writes.length, 0, 'up() never writes rows');
    for (const s of ddl) {
        assert.match(s, /^ALTER TABLE agents/);
        const adds = s.match(/ADD COLUMN[^,;]*/g) || [];
        assert.equal(adds.length, 5);
        for (const a of adds) assert.match(a, /ADD COLUMN IF NOT EXISTS/);
    }
    const s = ddl[0];
    assert.match(s, /published_config JSONB/);
    assert.match(s, /published_system_prompt TEXT/);
    assert.match(s, /published_version INTEGER NOT NULL DEFAULT 0/);
    assert.match(s, /published_rev INTEGER/);
    assert.match(s, /published_at TIMESTAMPTZ/);
});

test('backfill exports exist and are NOT part of up()', () => {
    assert.equal(typeof migration.backfillPublished, 'function');
    assert.equal(typeof migration.up, 'function');
});

test('--dry-run counts candidates and writes nothing', async () => {
    const r = await migration.backfillPublished({ dryRun: true });
    assert.deepEqual(r, { dryRun: true, candidates: 2, updated: 0, invalidConfig: ['a2'] });
    assert.equal(writes.length, 0);
    assert.equal(rows.find(x => x.id === 'a1').published_version, 0);
});

test('backfill copies the concept, skips system agents and already-published rows, is idempotent', async () => {
    const r = await migration.backfillPublished();
    assert.equal(r.dryRun, false);
    assert.equal(r.candidates, 2);
    assert.equal(r.updated, 2);
    assert.deepEqual(r.invalidConfig, ['a2']);
    const a1 = rows.find(x => x.id === 'a1');
    assert.deepEqual(a1.published_config, { knowledge_base_ids: ['kb1'] });
    assert.equal(a1.published_system_prompt, 'p1');
    assert.equal(a1.published_version, 1);
    assert.equal(a1.published_rev, 3);
    assert.deepEqual(rows.find(x => x.id === 'a2').published_config, {}, 'invalid JSON publishes as {} and is reported');
    const sys = rows.find(x => x.id === 'sys');
    assert.equal(sys.published_version, 0, 'system agents always follow live');
    assert.equal(sys.published_config, null);
    const done = rows.find(x => x.id === 'done');
    assert.equal(done.published_version, 2, 'an agent already in split mode is left alone');
    for (const w of writes) assert.match(w.sql, /AND rev = \$3 AND published_version = 0 AND owner_id NOT IN \('system', 'swarm'\)/);

    writes.length = 0;
    const again = await migration.backfillPublished();
    assert.deepEqual(again, { dryRun: false, candidates: 0, updated: 0, invalidConfig: [] });
    assert.equal(writes.length, 0);
});

test('a concept saved between SELECT and UPDATE is skipped, not frozen at the stale snapshot', async () => {
    afterSelect = () => { rows.find(x => x.id === 'a1').rev = 4; }; // a save lands after the read
    try {
        const r = await migration.backfillPublished();
        assert.equal(r.updated, 1, 'only a2 was written');
        assert.equal(rows.find(x => x.id === 'a1').published_version, 0);
    } finally { afterSelect = null; }
});
