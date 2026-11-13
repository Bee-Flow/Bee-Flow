'use strict';

/**
 * The per-user image count behind the image limits (core/entitlements/imageQuota.mts).
 * It must count only that user's rows of the image source, inside rolling
 * windows that end at "now".
 *
 * Run: cd server && node --test stores/usageStore.imageCounts.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const usageStore = require('./usageStore');

const WINDOWS = { hour: 3_600_000, day: 86_400_000, week: 604_800_000, month: 2_592_000_000 };

function fakeDb(rows, capture = []) {
    return { async query(sql, params) { capture.push({ sql, params }); return { rows }; } };
}

test('the count is taken under the source every image generation logs', () => {
    assert.strictEqual(usageStore.IMAGE_GENERATION_SOURCE, 'image_generation');
});

test('one user, the image source, and four windows ending now', async () => {
    const seen = [];
    const now = new Date('2026-11-13T12:00:00.000Z');
    const counts = await usageStore.getUserImageCounts('u1', WINDOWS, { now, db: fakeDb([{ hour: '2', day: '5', week: 9, month: '31' }], seen) });
    assert.deepStrictEqual(counts, { hour: 2, day: 5, week: 9, month: 31 });
    assert.strictEqual(seen.length, 1);
    assert.deepStrictEqual(seen[0].params, [
        'u1', 'image_generation',
        '2026-11-13T11:00:00.000Z', '2026-11-12T12:00:00.000Z', '2026-11-06T12:00:00.000Z', '2026-10-14T12:00:00.000Z',
    ]);
    assert.match(seen[0].sql, /user_id = \$1/);
    assert.match(seen[0].sql, /source = \$2/);
    assert.match(seen[0].sql, /timestamp >= \$6/, 'nothing older than the longest window is read');
});

test('no rows means zero everywhere', async () => {
    assert.deepStrictEqual(await usageStore.getUserImageCounts('u1', WINDOWS, { db: fakeDb([]) }), { hour: 0, day: 0, week: 0, month: 0 });
});
