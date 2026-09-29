/**
 * platformReleaseStore — the build/SBOM log. Recording db double: the
 * assertions pin the idempotent upsert (first_seen_at never moves, missing
 * hash/version filled in later) and the input validation.
 *
 * Run: cd server && node --test --test-force-exit stores/platformReleaseStore.test.js
 */

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const { createRecordingDb } = require('../testUtils/mockDb');
const { installResolveStub } = require('../testUtils/stubRequire');

const rows = [];
const mock = createRecordingDb({
    tables: { platform_release_log: rows },
    onQuery(sql, params) {
        if (/^INSERT INTO platform_release_log/i.test(sql)) {
            const [sha, version, sbom] = params;
            const hit = rows.find(r => r.build_sha === sha);
            if (hit) {
                hit.app_version = version ?? hit.app_version;
                hit.sbom_hash = sbom ?? hit.sbom_hash;
                return { rows: [{ ...hit, inserted: false }], rowCount: 1 };
            }
            const row = { build_sha: sha, app_version: version, first_seen_at: new Date(), sbom_hash: sbom };
            rows.push(row);
            return { rows: [{ ...row, inserted: true }], rowCount: 1 };
        }
        return undefined;
    },
});
const restore = installResolveStub({ '../db': mock.db });
const store = require('./platformReleaseStore');

let bootDdl = '';
before(async () => {
    await store.initDB();
    bootDdl = mock.calls.exec.map(c => c.sql).join('\n');
});
after(() => restore());
beforeEach(() => { rows.length = 0; mock.reset(); });

const SHA = 'a3f9c2e1b4d5f6a7b8c9d0e1f2a3b4c5d6e7f8a9';
const SBOM = 'c'.repeat(64);

test('boot DDL: build_sha is the primary key, first_seen_at defaults to now', () => {
    assert.match(bootDdl, /CREATE TABLE IF NOT EXISTS platform_release_log \(\s+build_sha TEXT PRIMARY KEY/);
    assert.match(bootDdl, /app_version TEXT/);
    assert.match(bootDdl, /first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
    assert.match(bootDdl, /sbom_hash TEXT/);
});

test('upsertSeen: inserts once; a second boot keeps first_seen_at and fills in what was missing', async () => {
    const a = await store.upsertSeen({ buildSha: SHA.toUpperCase(), appVersion: '2.14.0' });
    assert.strictEqual(a.build_sha, SHA, 'sha normalised to lower case');
    assert.strictEqual(a.app_version, '2.14.0');
    assert.strictEqual(a.sbom_hash, null);
    assert.strictEqual(a.inserted, true);
    const firstSeen = rows[0].first_seen_at;

    mock.reset();
    const b = await store.upsertSeen({ buildSha: SHA, sbomHash: SBOM.toUpperCase() });
    assert.strictEqual(b.inserted, false);
    assert.strictEqual(b.sbom_hash, SBOM, 'hash filled in and lower-cased');
    assert.strictEqual(b.app_version, '2.14.0', 'a missing version does not erase the stored one');
    assert.strictEqual(rows[0].first_seen_at, firstSeen, 'first_seen_at never moves');
    assert.strictEqual(rows.length, 1);

    const ins = mock.mutations()[0];
    assert.match(ins.sql, /ON CONFLICT \(build_sha\) DO UPDATE SET/);
    assert.match(ins.sql, /app_version = COALESCE\(EXCLUDED\.app_version, platform_release_log\.app_version\)/);
    assert.match(ins.sql, /sbom_hash = COALESCE\(EXCLUDED\.sbom_hash, platform_release_log\.sbom_hash\)/);
    assert.ok(!/first_seen_at =/.test(ins.sql), 'the conflict branch never touches first_seen_at');
    assert.deepStrictEqual(ins.params, [SHA, null, SBOM]);
});

test('upsertSeen validation: git sha shape, sha256 sbom hash, version trimmed/capped', async () => {
    await assert.rejects(() => store.upsertSeen({ buildSha: 'not a sha' }), /buildSha/);
    await assert.rejects(() => store.upsertSeen({ buildSha: 'abc' }), /buildSha/, 'shorter than 7 hex chars');
    await assert.rejects(() => store.upsertSeen({}), /buildSha/);
    await assert.rejects(() => store.upsertSeen({ buildSha: SHA, sbomHash: 'deadbeef' }), /sbomHash/);
    assert.strictEqual(rows.length, 0);
    const r = await store.upsertSeen({ buildSha: 'abcdef1', appVersion: `  ${'9'.repeat(80)}  `, sbomHash: '' });
    assert.strictEqual(r.app_version.length, 64);
    assert.strictEqual(r.sbom_hash, null, 'empty hash = unknown, not an error');
});

test('latest / get / listRecent read newest first with a bounded limit', async () => {
    await store.latest();
    assert.match(mock.calls.getOne[0].sql, /ORDER BY first_seen_at DESC\s+LIMIT 1/);

    await store.get(SHA.toUpperCase());
    assert.match(mock.calls.getOne[1].sql, /WHERE build_sha = \$1/);
    assert.deepStrictEqual(mock.calls.getOne[1].params, [SHA]);
    await assert.rejects(() => store.get('zzz'), /buildSha/);

    await store.listRecent(5);
    assert.match(mock.calls.getAll[0].sql, /ORDER BY first_seen_at DESC\s+LIMIT \$1/);
    assert.deepStrictEqual(mock.calls.getAll[0].params, [5]);
    await store.listRecent('lots');
    assert.deepStrictEqual(mock.calls.getAll[1].params, [20], 'garbage → default');
    await store.listRecent(10_000);
    assert.deepStrictEqual(mock.calls.getAll[2].params, [500], 'capped');
});
