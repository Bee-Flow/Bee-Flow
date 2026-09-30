'use strict';

/**
 * Document version retention (jobs/documentVersionRetention.js).
 *
 * Pinned, against a real Postgres (pglite) for the SQL the job owns:
 *   - only documents over the threshold are considered, the fullest first;
 *   - every `documentVersionId` a routine, a saved routine version or an app
 *     (draft or published) pins is collected, from anywhere in the JSON, and
 *     handed to the store as referenced; a table the install lacks pins nothing;
 *   - so is the version each project member last saw of a candidate document
 *     ("Show changes" compares from it), and nothing of another item type;
 *   - a pass runs under the named lock, thins each document with the shared
 *     policy, survives one document failing, and does nothing while another
 *     replica holds the lock.
 *
 * Run: cd server && node --test jobs/documentVersionRetention.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../testUtils/pgliteDb');
const job = require('./documentVersionRetention');

const { pg, db } = pgliteDb();

/** A pool over pglite: the named lock is answered by pglite itself. */
const pool = (locked = null) => ({
    async connect() {
        return {
            async query(sql, params) {
                if (locked !== null && /pg_try_advisory_lock/.test(sql)) return { rows: [{ locked }] };
                return db.query(sql, params);
            },
            release() {},
        };
    },
});

test.before(async () => {
    await pg.exec(`
        CREATE TABLE studio_document_versions (id TEXT PRIMARY KEY, document_id TEXT NOT NULL);
        CREATE TABLE automations (id TEXT PRIMARY KEY, definition_json JSONB NOT NULL);
        CREATE TABLE studio_apps (id TEXT PRIMARY KEY, definition JSONB NOT NULL DEFAULT '{}', published_definition JSONB);
        CREATE TABLE project_item_reads (project_id TEXT NOT NULL, user_id TEXT NOT NULL, item_type TEXT NOT NULL,
            item_id TEXT NOT NULL, seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), seen_version_id TEXT);
        INSERT INTO project_item_reads (project_id, user_id, item_type, item_id, seen_version_id) VALUES
            ('p1', 'u1', 'document', 'big', 'big-7'),
            ('p1', 'u2', 'document', 'big', 'big-7'),
            ('p1', 'u3', 'document', 'big', NULL),
            ('p1', 'u1', 'notebook', 'big', 'nb-9'),
            ('p1', 'u1', 'document', 'small', 'small-1');
    `);
    const rows = [];
    for (let i = 0; i < job.MIN_VERSIONS + 5; i += 1) rows.push(`('big-${i}', 'big')`);
    for (let i = 0; i < job.MIN_VERSIONS + 1; i += 1) rows.push(`('mid-${i}', 'mid')`);
    for (let i = 0; i < 3; i += 1) rows.push(`('small-${i}', 'small')`);
    await pg.exec(`INSERT INTO studio_document_versions (id, document_id) VALUES ${rows.join(', ')}`);
    await pg.query(`INSERT INTO automations (id, definition_json) VALUES ($1, $2), ($3, $4)`, [
        'a1', JSON.stringify({ steps: [{ type: 'fill_document', documentId: 'big', documentVersionId: 'big-1' }] }),
        'a2', JSON.stringify({ nodes: { n1: { config: { branches: [{ steps: [{ documentVersionId: 'mid-2' }] }] } } } }),
    ]);
    await pg.query(`INSERT INTO studio_apps (id, definition, published_definition) VALUES ($1, $2, $3)`, [
        'app1',
        JSON.stringify({ actions: [{ steps: [{ kind: 'document', documentVersionId: 'big-3' }] }] }),
        JSON.stringify({ actions: [{ steps: [{ kind: 'document', documentVersionId: 'big-4' }] }] }),
    ]);
});
test.after(async () => { job.stop(); job._setDeps(null); await pg.close(); });

test('only documents over the threshold, fullest first', async () => {
    assert.deepStrictEqual(await job.listCandidates(db), ['big', 'mid']);
});

test('every pinned revision is collected, from any depth; missing tables pin nothing', async () => {
    const pinned = await job.listPinnedVersionIds(db);
    assert.deepStrictEqual([...pinned].sort(), ['big-1', 'big-3', 'big-4', 'mid-2']);
});

test('the version each reader last saw of a candidate is protected; other items and types are not', async () => {
    assert.deepStrictEqual([...await job.listSeenVersionIds(db, ['big', 'mid'])], ['big-7']);
    assert.deepStrictEqual([...await job.listSeenVersionIds(db, [])], []);
    const noTable = { query: async (sql) => (/to_regclass/.test(sql) ? { rows: [{ present: false }] } : assert.fail(`unexpected ${sql}`)) };
    assert.deepStrictEqual([...await job.listSeenVersionIds(noTable, ['big'])], [], 'an install without project reads protects nothing');
});

test('a pass thins each candidate with the policy and the pinned ids, and survives one failing', async () => {
    const calls = [];
    const info = [];
    const warn = [];
    const policy = () => [];
    job._setDeps({
        pool: pool(),
        selectPrunable: policy,
        pruneVersions: async (id, opts) => {
            calls.push({ id, referenced: [...opts.referencedIds].sort(), policy: opts.selectPrunable === policy });
            if (id === 'mid') throw new Error('statement timeout');
            return 7;
        },
        log: { info: (...a) => info.push(a.join(' ')), warn: (...a) => warn.push(a.join(' ')) },
    });
    assert.deepStrictEqual(await job.runOnce(), { documents: 2, deleted: 7 });
    assert.deepStrictEqual(calls.map((c) => c.id), ['big', 'mid']);
    assert.deepStrictEqual(calls[0].referenced, ['big-1', 'big-3', 'big-4', 'big-7', 'mid-2'], 'pinned and last seen');
    assert.ok(calls.every((c) => c.policy), 'the shared retention policy');
    assert.match(warn[0], /statement timeout/);
    assert.match(info[0], /2 document\(s\) checked, 7 version\(s\) thinned out, 1 failed/);
});

test('does nothing while another replica holds the lock', async () => {
    let pruned = 0;
    job._setDeps({
        pool: pool(false),
        selectPrunable: () => [],
        pruneVersions: async () => { pruned += 1; return 0; },
        log: { info() {}, warn() {} },
    });
    assert.strictEqual(await job.runOnce(), null);
    assert.strictEqual(pruned, 0);
});

test('start schedules once and stop clears', () => {
    job._setDeps({ pool: pool(), selectPrunable: () => [], pruneVersions: async () => 0, log: { info() {}, warn() {} } });
    job.start();
    job.start();
    job.stop();
});
