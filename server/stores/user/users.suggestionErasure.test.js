'use strict';

/**
 * Account erasure reaches "Find repeating work": deleteUser calls
 * eraseSuggestionTraces, which empties the user's rows in both tables (scans
 * derived from their own mail and files, and their feedback) and nobody
 * else's. Runs the real stores' SQL against pglite.
 *
 * Run: cd server && node --test stores/user/users.suggestionErasure.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { pgliteDb } = require('../../testUtils/pgliteDb');
const { eraseSuggestionTraces } = require('./users');
const scanCache = require('../suggestionScanCache');
const feedbackStore = require('../suggestionFeedbackStore');

const { pg, db } = pgliteDb();
const stores = [scanCache.makeSuggestionScanCache(db), feedbackStore.makeSuggestionFeedbackStore(db)];
const [cache, feedback] = stores;
const future = () => new Date(Date.now() + 3600_000).toISOString();

before(async () => { await pg.exec(scanCache.DDL); await pg.exec(feedbackStore.DDL); });
after(() => pg.close());

test('the leaver\'s scans and feedback go, a colleague\'s stay', async () => {
    for (const userId of ['leaver', 'colleague']) {
        await cache.upsertScan({ scopeKey: `user:${userId}`, cacheKey: 'k', userId, organizationId: 'o1', suggestions: [], expiresAt: future() });
        await feedback.saveSuggestionFeedback({ userId, organizationId: 'o1', action: 'built', signature: 's1', suggestion: { title: 'X' } });
    }
    // A legacy org-scoped scan written by the leaver.
    await cache.upsertScan({ scopeKey: 'org:o1', cacheKey: 'k', userId: 'leaver', organizationId: 'o1', suggestions: [], expiresAt: future() });

    assert.strictEqual(await eraseSuggestionTraces('leaver', { stores }), 3);

    const scans = await pg.query(`SELECT user_id FROM suggestion_scan_cache`);
    assert.deepStrictEqual(scans.rows.map(r => r.user_id), ['colleague']);
    const fb = await pg.query(`SELECT user_id FROM automation_suggestion_feedback`);
    assert.deepStrictEqual(fb.rows.map(r => r.user_id), ['colleague']);
});

test('one failing store does not stop the other', async () => {
    const seen = [];
    const n = await eraseSuggestionTraces('u1', {
        stores: [
            { purgeForUser: async () => { throw new Error('relation does not exist'); } },
            { purgeForUser: async (id) => { seen.push(id); return 4; } },
        ],
    });
    assert.deepStrictEqual(seen, ['u1']);
    assert.strictEqual(n, 4);
});
