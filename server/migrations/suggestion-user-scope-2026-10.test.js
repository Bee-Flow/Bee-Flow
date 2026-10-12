'use strict';

/**
 * The per-user scope migration of the "Find repeating work" tables, against a
 * real Postgres (pglite) with the stores' own DDL.
 *
 * Run: cd server && node --test migrations/suggestion-user-scope-2026-10.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const { PGlite } = require('@electric-sql/pglite');

const { pgliteDb } = require('../testUtils/pgliteDb');
const { up } = require('./suggestion-user-scope-2026-10');
const feedbackStore = require('../stores/suggestionFeedbackStore');
const scanCache = require('../stores/suggestionScanCache');

const open = [];
function fresh() {
    const h = pgliteDb(new PGlite());
    open.push(h.pg);
    return h;
}
after(async () => { for (const pg of open) await pg.close(); });

test('absent tables are skipped, not an error', async () => {
    const { db } = fresh();
    assert.deepStrictEqual(await up({ db }), { feedback: null, cache: null });
});

test('org feedback rows are rewritten per user, org scans are deleted, and a rerun is a no-op', async () => {
    const { pg, db } = fresh();
    await pg.exec(feedbackStore.DDL);
    await pg.exec(scanCache.DDL);
    await pg.query(`
        INSERT INTO automation_suggestion_feedback (id, user_id, organization_id, title_fingerprint, title, action, suggestion_json, expires_at)
        VALUES
          ('org:o1:fpA', 'ua', 'o1', 'fpA', 'Invoice flow', 'built',
           '{"title":"Invoice flow","buildPrompt":"mail jan@example.com","apps":["gmail"]}'::jsonb, NULL),
          ('org:o1:fpB', 'ub', 'o1', 'fpB', 'Report', 'dismissed', NULL, NOW() + interval '5 days'),
          ('org:o1:fpC', NULL, 'o1', 'fpC', 'Nobody', 'asked', NULL, NULL),
          ('org:o1:fpD', 'ua', 'o1', 'fpD', 'Older', 'dismissed', NULL, NULL),
          ('user:ua:fpD', 'ua', 'o1', 'fpD', 'Newer', 'built', '"just a string"'::jsonb, NULL)
    `);
    await pg.query(`
        INSERT INTO suggestion_scan_cache (id, scope_key, user_id, cache_key, suggestions_json, expires_at)
        VALUES ('org:o1:k', 'org:o1', 'ua', 'k', '[]'::jsonb, NOW()),
               ('user:ua:k', 'user:ua', 'ua', 'k', '[]'::jsonb, NOW())
    `);

    const first = await up({ db });
    assert.deepStrictEqual(first.feedback, { moved: 2, dropped: 4, stripped: 2 });
    assert.deepStrictEqual(first.cache, { deleted: 1 });

    const { rows } = await pg.query(`SELECT id, user_id, title, action, suggestion_json FROM automation_suggestion_feedback ORDER BY id`);
    assert.deepStrictEqual(rows.map(r => r.id), ['user:ua:fpA', 'user:ua:fpD', 'user:ub:fpB']);
    const a = rows.find(r => r.id === 'user:ua:fpA');
    assert.strictEqual(a.action, 'built', 'a built row must survive the rewrite');
    assert.deepStrictEqual(a.suggestion_json, { title: 'Invoice flow', apps: ['gmail'] }, 'the buildPrompt must be stripped');
    const d = rows.find(r => r.id === 'user:ua:fpD');
    assert.strictEqual(d.title, 'Newer', 'an existing per-user row wins over the org row');
    assert.strictEqual(d.suggestion_json, null, 'a non-object suggestion_json is cleared');

    const scans = await pg.query(`SELECT scope_key FROM suggestion_scan_cache`);
    assert.deepStrictEqual(scans.rows.map(r => r.scope_key), ['user:ua']);

    const second = await up({ db });
    assert.deepStrictEqual(second.feedback, { moved: 0, dropped: 0, stripped: 0 });
    assert.deepStrictEqual(second.cache, { deleted: 0 });
});

test('the migrated rows are readable through the per-user store', async () => {
    const { pg, db } = fresh();
    await pg.exec(feedbackStore.DDL);
    await pg.query(`INSERT INTO automation_suggestion_feedback (id, user_id, organization_id, title_fingerprint, title, action)
                    VALUES ('org:o2:fp', 'u7', 'o2', 'fp', 'Kept', 'asked')`);
    await up({ db });
    const store = feedbackStore.makeSuggestionFeedbackStore(db);
    assert.deepStrictEqual(await store.getRecentSuppressedTitles({ userId: 'u7' }), ['Kept']);
    assert.deepStrictEqual(await store.getRecentSuppressedTitles({ userId: 'colleague' }), []);
});
