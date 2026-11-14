// @typecheck
/**
 * platformReleaseStore — the build/SBOM log, against a real Postgres (PGlite
 * behind db.js's pool, testUtils/pglitePool.js): the upsert is idempotent
 * (first_seen_at never moves, a missing hash or version is filled in later and
 * never erased), the input is validated, and the reads are newest first with a
 * bounded limit.
 *
 * Run: cd server && node --test stores/platformReleaseStore.test.js
 */

'use strict';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const store = require('./platformReleaseStore');

before(() => store.initDB());
after(close);
beforeEach(() => pg.exec('DELETE FROM platform_release_log'));

const SHA = 'a3f9c2e1b4d5f6a7b8c9d0e1f2a3b4c5d6e7f8a9';
const SBOM = 'c'.repeat(64);
const count = async () => Number((await pg.query('SELECT COUNT(*)::int AS n FROM platform_release_log')).rows[0].n);

test('the table: build_sha is the primary key, first_seen_at defaults to now', async () => {
    const pk = await pg.query(`SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                                WHERE i.indrelid = 'platform_release_log'::regclass AND i.indisprimary`);
    assert.deepStrictEqual(pk.rows.map((r) => r.attname), ['build_sha']);
    await pg.query("INSERT INTO platform_release_log (build_sha) VALUES ('abcdef0')");
    const { rows } = await pg.query("SELECT first_seen_at, app_version, sbom_hash FROM platform_release_log WHERE build_sha = 'abcdef0'");
    assert.ok(Date.now() - new Date(rows[0].first_seen_at).getTime() < 60_000);
});

test('upsertSeen: inserts once; a second boot keeps first_seen_at and fills in what was missing', async () => {
    const a = await store.upsertSeen({ buildSha: SHA.toUpperCase(), appVersion: '2.14.0' });
    assert.strictEqual(a.build_sha, SHA, 'sha normalised to lower case');
    assert.strictEqual(a.app_version, '2.14.0');
    assert.strictEqual(a.sbom_hash, null);
    assert.strictEqual(a.inserted, true);
    await pg.query("UPDATE platform_release_log SET first_seen_at = '2026-01-01T00:00:00Z'");

    const b = await store.upsertSeen({ buildSha: SHA, sbomHash: SBOM.toUpperCase() });
    assert.strictEqual(b.inserted, false);
    assert.strictEqual(b.sbom_hash, SBOM, 'hash filled in and lower-cased');
    assert.strictEqual(b.app_version, '2.14.0', 'a missing version does not erase the stored one');
    assert.strictEqual(new Date(b.first_seen_at).toISOString(), '2026-01-01T00:00:00.000Z', 'first_seen_at never moves');
    assert.strictEqual(await count(), 1);
});

test('upsertSeen validation: git sha shape, sha256 sbom hash, version trimmed/capped', async () => {
    await assert.rejects(() => store.upsertSeen({ buildSha: 'not a sha' }), /buildSha/);
    await assert.rejects(() => store.upsertSeen({ buildSha: 'abc' }), /buildSha/, 'shorter than 7 hex chars');
    await assert.rejects(() => store.upsertSeen({}), /buildSha/);
    await assert.rejects(() => store.upsertSeen({ buildSha: SHA, sbomHash: 'deadbeef' }), /sbomHash/);
    assert.strictEqual(await count(), 0);
    const r = await store.upsertSeen({ buildSha: 'abcdef1', appVersion: `  ${'9'.repeat(80)}  `, sbomHash: '' });
    assert.strictEqual(r.app_version.length, 64);
    assert.strictEqual(r.sbom_hash, null, 'empty hash = unknown, not an error');
});

test('latest / get / listRecent read newest first with a bounded limit', async () => {
    const shas = Array.from({ length: 25 }, (_, i) => `abcdef${String(i).padStart(2, '0')}`);
    for (const [i, sha] of shas.entries()) {
        await pg.query(`INSERT INTO platform_release_log (build_sha, first_seen_at) VALUES ($1, NOW() - ($2::int * INTERVAL '1 hour'))`, [sha, 25 - i]);
    }
    assert.strictEqual((await store.latest()).build_sha, shas[24]);
    assert.strictEqual((await store.get(shas[3].toUpperCase())).build_sha, shas[3]);
    assert.strictEqual(await store.get('1234567'), null);
    await assert.rejects(() => store.get('zzz'), /buildSha/);

    assert.deepStrictEqual((await store.listRecent(5)).map((r) => r.build_sha), shas.slice(20).reverse());
    assert.strictEqual((await store.listRecent(/** @type {any} */ ('lots'))).length, 20, 'garbage → default');
    assert.strictEqual((await store.listRecent(10_000)).length, 25, 'capped at 500, and there are 25');
});
