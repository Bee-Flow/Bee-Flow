'use strict';

/**
 * suggestion_scan_cache against a real Postgres (pglite), through the store's
 * own SQL. What is pinned: the scope is always the user (an org colleague
 * never sees another person's scan), the mode column, Art. 17 erasure and the
 * retention prune.
 *
 * Run: cd server && node --test stores/suggestionScanCache.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { pgliteDb } = require('../testUtils/pgliteDb');
const { DDL, deriveScopeKey, makeSuggestionScanCache } = require('./suggestionScanCache');

const { pg, db } = pgliteDb();
const store = makeSuggestionScanCache(db);
const future = () => new Date(Date.now() + 3600_000).toISOString();

before(async () => { await pg.exec(DDL); await pg.exec(DDL); });
after(() => pg.close());

test('the scope is the user, never the organisation', () => {
    assert.strictEqual(deriveScopeKey({ organizationId: 'org1', userId: 'u1' }), 'user:u1');
    assert.strictEqual(deriveScopeKey({ organizationId: 'org1' }), 'anon');
    assert.strictEqual(deriveScopeKey(), 'anon');
});

test('a colleague in the same org does not see another user\'s last scan', async () => {
    const a = deriveScopeKey({ organizationId: 'org1', userId: 'ua' });
    await store.upsertScan({
        scopeKey: a, cacheKey: 'k1', userId: 'ua', organizationId: 'org1', mode: 'patterns',
        suggestions: [{ title: 'Weekly invoice' }], summary: { events: 3 }, expiresAt: future(),
    });
    const b = deriveScopeKey({ organizationId: 'org1', userId: 'ub' });
    assert.strictEqual(await store.getLatestScan({ scopeKey: b }), null);
    assert.strictEqual(await store.getCachedScan({ scopeKey: b, cacheKey: 'k1' }), null);
    const mine = await store.getLatestScan({ scopeKey: a });
    assert.strictEqual(mine.mode, 'patterns');
    assert.deepStrictEqual(mine.suggestions, [{ title: 'Weekly invoice' }]);
});

test('getLatestScan filters by mode; a legacy row without a mode reads as ideas', async () => {
    const s = deriveScopeKey({ userId: 'um' });
    await pg.query(
        `INSERT INTO suggestion_scan_cache (id, scope_key, user_id, cache_key, suggestions_json, expires_at, scanned_at)
         VALUES ('legacy', $1, 'um', 'old', '[]'::jsonb, NOW(), NOW() - interval '1 hour')`, [s]);
    await store.upsertScan({ scopeKey: s, cacheKey: 'new', userId: 'um', mode: 'patterns', suggestions: [], expiresAt: future() });
    assert.strictEqual((await store.getLatestScan({ scopeKey: s, mode: 'ideas' })).cacheKey, 'old');
    assert.strictEqual((await store.getLatestScan({ scopeKey: s, mode: 'patterns' })).cacheKey, 'new');
    assert.strictEqual((await store.getLatestScan({ scopeKey: s })).cacheKey, 'new');
});

test('an unknown mode is stored as NULL', async () => {
    const s = deriveScopeKey({ userId: 'ux' });
    const row = await store.upsertScan({ scopeKey: s, cacheKey: 'x', userId: 'ux', mode: 'bogus', suggestions: [], expiresAt: future() });
    assert.strictEqual(row.mode, null);
});

test('removeSuggestionsFromScope strips only the scope\'s own rows', async () => {
    const mine = deriveScopeKey({ userId: 'ur1' });
    const theirs = deriveScopeKey({ userId: 'ur2' });
    for (const [scopeKey, userId] of [[mine, 'ur1'], [theirs, 'ur2']]) {
        await store.upsertScan({ scopeKey, cacheKey: 'c', userId, suggestions: [{ title: 'A' }, { title: 'B' }], expiresAt: future() });
    }
    const n = await store.removeSuggestionsFromScope({ scopeKey: mine, predicate: (s) => s.title === 'A' });
    assert.strictEqual(n, 1);
    assert.deepStrictEqual((await store.getLatestScan({ scopeKey: mine })).suggestions, [{ title: 'B' }]);
    assert.strictEqual((await store.getLatestScan({ scopeKey: theirs })).suggestions.length, 2);
});

test('purgeForUser erases the user\'s rows, including a legacy org-scoped one', async () => {
    await store.upsertScan({ scopeKey: 'user:gone', cacheKey: 'a', userId: 'gone', suggestions: [], expiresAt: future() });
    await store.upsertScan({ scopeKey: 'org:o9', cacheKey: 'b', userId: 'gone', suggestions: [], expiresAt: future() });
    await store.upsertScan({ scopeKey: 'user:stays', cacheKey: 'a', userId: 'stays', suggestions: [], expiresAt: future() });
    assert.strictEqual(await store.purgeForUser('gone'), 2);
    assert.strictEqual(await store.purgeForUser(''), 0);
    assert.ok(await store.getLatestScan({ scopeKey: 'user:stays' }));
});

test('pruneExpired reaps rows past the retention window only', async () => {
    await pg.query(
        `INSERT INTO suggestion_scan_cache (id, scope_key, user_id, cache_key, suggestions_json, expires_at, scanned_at)
         VALUES ('ancient', 'user:old', 'old', 'z', '[]'::jsonb, NOW(), NOW() - interval '31 days')`);
    await store.upsertScan({ scopeKey: 'user:old', cacheKey: 'fresh', userId: 'old', suggestions: [], expiresAt: future() });
    assert.strictEqual(await store.pruneExpired(), 1);
    assert.strictEqual((await store.getLatestScan({ scopeKey: 'user:old' })).cacheKey, 'fresh');
});

test('freshness follows the clock the caller passes, so it agrees with the expiresAt that clock wrote', async () => {
    const s = deriveScopeKey({ userId: 'uclock' });
    const then = Date.UTC(2026, 0, 1, 12, 0);
    await store.upsertScan({ scopeKey: s, cacheKey: 'c', userId: 'uclock', mode: 'patterns', suggestions: [], expiresAt: new Date(then + 3600_000) });
    assert.ok(await store.getCachedScan({ scopeKey: s, cacheKey: 'c', now: then }), 'fresh at the writer\'s clock');
    assert.strictEqual(await store.getCachedScan({ scopeKey: s, cacheKey: 'c', now: then + 2 * 3600_000 }), null);
    assert.strictEqual(await store.getCachedScan({ scopeKey: s, cacheKey: 'c' }), null, 'without a clock the database decides');
});
