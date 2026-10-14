/**
 * Pipeline releases (stores/blueprint/releases.js), against a real Postgres
 * (@electric-sql/pglite, in-process) through makeBlueprintStore. No module is
 * replaced: the schema is the store's own applyBlueprintSchema. The ref ledger
 * and the stamps are proven in installs.test.js next to this file.
 *
 * Proven:
 *   - the schema lifts an existing project_releases (idempotently);
 *   - a pipeline cut numbers releases 1..n with version = seq, reuses the
 *     latest release on an identical content hash AND identical payloads,
 *     replays a request key, and stores its payloads;
 *   - the two channels never prune each other;
 *   - the pipeline prune keeps what a stage runs, what a deployment needs, what
 *     waits for PRD and every PRD rollback target, prunes nothing while the
 *     stage tables are absent, and takes the payloads with the pruned rows;
 *   - listReleases shows the gallery channel only.
 *
 * Run: cd server && node --test stores/blueprint/releases.pipeline.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../../testUtils/pgliteDb');
const {
    makeBlueprintStore, applyBlueprintSchema, MAX_PIPELINE_RELEASES_PER_PROJECT, MAX_RELEASES_PER_PROJECT,
} = require('../blueprintStore');

const { pg, db: q } = pgliteDb();
// db.js's shape over the pglite connection.
const db = {
    run: (sql, params) => q.query(sql, params),
    getOne: async (sql, params) => (await q.query(sql, params)).rows[0] || null,
    getAll: async (sql, params) => (await q.query(sql, params)).rows,
    withTransaction: (fn) => q.tx(fn),
};
const store = makeBlueprintStore(db);

// The slice of solutionStageStore's tables the pipeline prune reads.
const STAGE_TABLES = `
    CREATE TABLE solution_stages (
        project_id TEXT PRIMARY KEY, solution_id TEXT NOT NULL, stage TEXT NOT NULL,
        current_release_id TEXT, current_release_seq INTEGER, previous_release_id TEXT);
    CREATE TABLE solution_deployments (
        id TEXT PRIMARY KEY, solution_id TEXT NOT NULL, stage_project_id TEXT NOT NULL,
        stage TEXT NOT NULL, release_id TEXT, status TEXT NOT NULL);`;

const runners = {
    exec: (sql) => pg.exec(sql),
    runDdl: async (_tag, statements) => {
        for (const s of statements) await pg.exec(typeof s === 'string' ? s : s.sql);
    },
};

const manifest = (name = 'Orders') => ({ solution: { key: 'sol_dev', name, version: 1, entities: {} } });

let hashes = 0;
/** One pipeline cut with a fresh content hash unless one is given. */
const cut = (projectId, over = {}) => store.cutPipelineRelease({
    projectId, manifest: manifest(), contentHash: `h${++hashes}`, createdBy: 'alice',
    gate: { blocked: false, findings: [] }, sourceCut: { automations: { a1: 3 } }, ...over,
});

const count = async (projectId, channel) => (await pg.query(
    `SELECT COUNT(*)::int AS n FROM project_releases WHERE project_id = $1 AND channel = $2`,
    [projectId, channel])).rows[0].n;

before(async () => {
    await pg.exec(`CREATE TABLE projects (
        id TEXT PRIMARY KEY, organization_id TEXT DEFAULT '', installed_from_blueprint_id TEXT)`);
    // The legacy table first (blueprint_id NOT NULL), then the ladder twice:
    // the ALTERs must lift an existing installation and be idempotent.
    await applyBlueprintSchema(runners);
    await applyBlueprintSchema(runners);
    for (const id of ['dev1', 'dev2', 'devA', 'devG', 'devH', 'devP', 'devR']) {
        await pg.query(`INSERT INTO projects (id, organization_id) VALUES ($1, 'org1')`, [id]);
    }
});
after(async () => { await pg.close(); });

// ── The schema ──────────────────────────────────────────────────────────────

test('the schema lifts project_releases: blueprint_id is optional and channel defaults to gallery', async () => {
    const cols = (await pg.query(
        `SELECT column_name, is_nullable, column_default FROM information_schema.columns
          WHERE table_name = 'project_releases'`)).rows;
    const col = (n) => cols.find(c => c.column_name === n);
    assert.strictEqual(col('blueprint_id').is_nullable, 'YES');
    assert.match(String(col('channel').column_default), /gallery/);
    for (const n of ['seq', 'content_hash', 'gate', 'source_cut']) assert.ok(col(n), n);
    await assert.rejects(pg.query(
        `INSERT INTO project_releases (id, project_id, version, manifest, published_by, channel)
         VALUES ('x', 'dev1', 1, '{}', 'a', 'elsewhere')`), /project_releases_channel_chk/);
});

// ── Cutting a pipeline release ──────────────────────────────────────────────

test('a cut numbers the releases, writes version = seq, and has no gallery row', async () => {
    const one = await cut('dev1', { notes: { summary: 'first' } });
    const two = await cut('dev1');
    assert.strictEqual(one.reused, false);
    assert.strictEqual(one.release.seq, 1);
    assert.strictEqual(two.release.seq, 2);
    assert.strictEqual(two.release.version, 2, 'version = seq');
    assert.strictEqual(two.release.channel, 'pipeline');
    assert.strictEqual(two.release.blueprintId, null);
    assert.strictEqual(two.release.publishedBy, 'alice');
    assert.strictEqual((await pg.query(`SELECT COUNT(*)::int AS n FROM project_blueprints`)).rows[0].n, 0,
        'a pipeline release never puts a candidate in the gallery');

    const full = await store.getRelease('dev1', one.release.id);
    assert.strictEqual(full.seq, 1);
    assert.strictEqual(full.channel, 'pipeline');
    assert.deepStrictEqual(full.gate, { blocked: false, findings: [] });
    assert.strictEqual(full.contentHash, one.release.contentHash);
    assert.strictEqual(full.manifest.solution.name, 'Orders');
    assert.strictEqual(full.notes.summary, 'first');
    assert.strictEqual(full.sourceCut, undefined, 'the capture tokens stay home');
});

test('the same content hash as the latest release reuses it; a changed one cuts the next seq', async () => {
    const latest = (await store.listPipelineReleases('dev1'))[0];
    const same = await cut('dev1', { contentHash: latest.contentHash });
    assert.strictEqual(same.reused, true);
    assert.strictEqual(same.release.id, latest.id);
    const changed = await cut('dev1');
    assert.strictEqual(changed.release.seq, latest.seq + 1);
});

test('the same content hash with changed payloads cuts the next seq', async () => {
    const rowsPayload = (h) => [{ ref: 'dt_1', kind: 'reference_rows', sourceEntityId: 'tbl_1', payload: { rows: [] }, contentHash: h }];
    const first = await cut('devR', { contentHash: 'defs1', payloads: rowsPayload('rowsA') });
    const same = await cut('devR', { contentHash: 'defs1', payloads: rowsPayload('rowsA') });
    assert.strictEqual(same.reused, true, 'identical definitions and payloads reuse the release');
    assert.strictEqual(same.release.id, first.release.id);

    const changed = await cut('devR', { contentHash: 'defs1', payloads: rowsPayload('rowsB') });
    assert.strictEqual(changed.reused, false, 'changed reference rows alone are a new release');
    assert.strictEqual(changed.release.seq, first.release.seq + 1);
    assert.strictEqual((await store.getReleasePayloads(changed.release.id))[0].contentHash, 'rowsB');

    const dropped = await cut('devR', { contentHash: 'defs1' });
    assert.strictEqual(dropped.reused, false, 'a payload that is gone is a change too');
    assert.strictEqual(dropped.release.seq, changed.release.seq + 1);
});

test('a request key replays the release it cut, even after a newer one', async () => {
    const first = await cut('dev2', { requestKey: 'req-1' });
    await cut('dev2');
    const replay = await cut('dev2', { requestKey: 'req-1' });
    assert.strictEqual(replay.replayed, true);
    assert.strictEqual(replay.release.id, first.release.id);
    assert.strictEqual(replay.release.notes.requestKey, 'req-1');
    assert.strictEqual((await store.listPipelineReleases('dev2')).length, 2);
});

test('payloads are stored with the release and read back by kind', async () => {
    const { release } = await cut('dev2', {
        payloads: [
            { ref: 'dt_1', kind: 'reference_rows', sourceEntityId: 'tbl_1', payload: { rows: [{ id: 'r1', code: 'NL' }] }, contentHash: 'p1' },
            { ref: 'kb_1', kind: 'knowledge_listing', sourceEntityId: 'kb_dev', payload: { docs: [] }, contentHash: 'p2' },
        ],
    });
    const all = await store.getReleasePayloads(release.id);
    assert.deepStrictEqual(all.map(p => [p.ref, p.kind]), [['dt_1', 'reference_rows'], ['kb_1', 'knowledge_listing']]);
    const rows = await store.getReleasePayloads(release.id, { kind: 'reference_rows' });
    assert.deepStrictEqual(rows, [{
        ref: 'dt_1', kind: 'reference_rows', sourceEntityId: 'tbl_1',
        payload: { rows: [{ id: 'r1', code: 'NL' }] }, contentHash: 'p1',
    }]);
    await assert.rejects(cut('dev2', { payloads: [{ ref: 'x', kind: 'rows', sourceEntityId: 's', payload: {}, contentHash: 'h' }] }),
        /known kind/);
});

test('a cut for a project that does not exist writes nothing', async () => {
    await assert.rejects(cut('nope'), (err) => err.status === 404 && err.code === 'project_not_found');
    assert.strictEqual(await count('nope', 'pipeline'), 0);
});

// ── Pruning, per channel ────────────────────────────────────────────────────

test('without the stage tables the pipeline prune deletes nothing', async () => {
    for (let i = 0; i < MAX_PIPELINE_RELEASES_PER_PROJECT + 2; i++) await cut('devA');
    assert.strictEqual(await count('devA', 'pipeline'), MAX_PIPELINE_RELEASES_PER_PROJECT + 2,
        'the guards cannot be read, so nothing a stage may run on is touched');
    await pg.exec(STAGE_TABLES);
    await cut('devA');
    assert.strictEqual(await count('devA', 'pipeline'), MAX_PIPELINE_RELEASES_PER_PROJECT, 'with them, the cap holds');
});

test('a gallery publish never prunes pipeline rows, and pipeline cuts never evict gallery rows', async () => {
    for (let i = 0; i < 3; i++) await cut('devG');
    for (let i = 0; i < MAX_RELEASES_PER_PROJECT + 5; i++) {
        await store.publishRelease({ organizationId: 'org1', createdBy: 'bob', sourceProjectId: 'devG', manifest: manifest() });
    }
    assert.strictEqual(await count('devG', 'pipeline'), 3, 'the gallery cap does not count pipeline rows');
    const gallery = await count('devG', 'gallery');
    assert.ok(gallery <= MAX_RELEASES_PER_PROJECT + 1, 'the gallery channel was pruned');

    for (let i = 0; i < MAX_PIPELINE_RELEASES_PER_PROJECT + 5; i++) await cut('devG');
    assert.strictEqual(await count('devG', 'pipeline'), MAX_PIPELINE_RELEASES_PER_PROJECT);
    assert.strictEqual(await count('devG', 'gallery'), gallery, 'no gallery row was evicted');

    const listed = await store.listReleases('devG');
    assert.ok(listed.length > 0);
    assert.ok(listed.every(r => r.blueprintId), 'listReleases shows the gallery channel only');
    assert.strictEqual((await store.listReleases('devG', { channel: 'pipeline' })).length,
        Math.min(MAX_RELEASES_PER_PROJECT, MAX_PIPELINE_RELEASES_PER_PROJECT));
});

test('the pipeline prune keeps what runs, what is in flight, what waits for PRD and every PRD rollback target', async () => {
    const bySeq = {};
    for (let i = 0; i < 10; i++) {
        const { release } = await cut('devH', {
            payloads: [{ ref: 'dt_1', kind: 'reference_rows', sourceEntityId: 'tbl_1', payload: { rows: [] }, contentHash: `rows${i}` }],
        });
        bySeq[release.seq] = release.id;
    }
    // PRD runs 6 (previous 4); UAT runs 8 (previous 7).
    await pg.query(`INSERT INTO solution_stages VALUES ('prdH', 'devH', 'prd', $1, 6, $2), ('uatH', 'devH', 'uat', $3, 8, $4)`,
        [bySeq[6], bySeq[4], bySeq[8], bySeq[7]]);
    await pg.query(`INSERT INTO solution_deployments VALUES
        ('d1', 'devH', 'prdH', 'prd', $1, 'succeeded'),
        ('d2', 'devH', 'prdH', 'prd', $2, 'queued'),
        ('d3', 'devH', 'uatH', 'uat', $3, 'succeeded'),
        ('d4', 'devH', 'uatH', 'uat', $4, 'succeeded_with_warnings'),
        ('d5', 'devH', 'uatH', 'uat', $5, 'failed')`,
    [bySeq[2], bySeq[3], bySeq[5], bySeq[9], bySeq[10]]);

    // Up to 60: seven rows are held, so the three oldest unheld ones go.
    for (let i = 10; i < 60; i++) await cut('devH');

    const left = new Set((await store.listPipelineReleases('devH', { limit: 100 })).map(r => r.seq));
    assert.strictEqual(left.size, 57);
    for (const seq of [2, 3, 4, 6, 7, 8, 9]) assert.ok(left.has(seq), `seq ${seq} is held`);
    for (const seq of [1, 5, 10]) assert.ok(!left.has(seq), `seq ${seq} is pruned`);
    // 5 succeeded in UAT, but PRD already runs 6: nothing waits for it.

    assert.deepStrictEqual(await store.getReleasePayloads(bySeq[1]), [], 'payloads go with their release');
    assert.deepStrictEqual(await store.getReleasePayloads(bySeq[5]), []);
    assert.strictEqual((await store.getReleasePayloads(bySeq[2])).length, 1, 'a held release keeps its payloads');
});
