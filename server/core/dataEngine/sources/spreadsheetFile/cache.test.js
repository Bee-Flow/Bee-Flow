/**
 * The download cache: one download per file version however many ask, a
 * parsed value per sub-key, sixty seconds from insertion, a byte budget
 * that drops the oldest, a key that moves with the marker.
 *
 * Run: cd server && node --test core/dataEngine/sources/spreadsheetFile/cache.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const cache = require('./cache');

test.beforeEach(() => cache.clear());

test('the key is stable for one marker whatever its key order, and moves with the marker', () => {
    const a = cache.keyOf('onedrive', '01ABC', { eTag: 'e1', cTag: 'c1' });
    const b = cache.keyOf('onedrive', '01ABC', { cTag: 'c1', eTag: 'e1' });
    assert.strictEqual(a, b);
    assert.notStrictEqual(a, cache.keyOf('onedrive', '01ABC', { eTag: 'e1', cTag: 'c2' }));
    assert.notStrictEqual(a, cache.keyOf('google_drive', '01ABC', { eTag: 'e1', cTag: 'c1' }));
    assert.strictEqual(cache.keyOf('nextcloud_files', '/a.csv', null), 'nextcloud_files|/a.csv|none');
});

test('bytes: one download for many concurrent askers, then a hit; another marker is another download', async () => {
    let loads = 0;
    const load = async () => { loads += 1; await new Promise(r => setTimeout(r, 5)); return Buffer.from('abc'); };
    const key = cache.keyOf('google_drive', 'f1', { version: '3' });
    const [x, y, z] = await Promise.all([cache.bytes(key, load), cache.bytes(key, load), cache.bytes(key, load)]);
    assert.strictEqual(loads, 1);
    assert.strictEqual(x, y);
    assert.strictEqual(y, z);
    assert.strictEqual((await cache.bytes(key, load)).toString(), 'abc');
    assert.strictEqual(loads, 1);
    await cache.bytes(cache.keyOf('google_drive', 'f1', { version: '4' }), load);
    assert.strictEqual(loads, 2);
    assert.strictEqual(cache.stats().entries, 2);
    assert.strictEqual(cache.stats().bytes, 6);
});

test('a failed download is not cached and the next asker retries', async () => {
    const key = cache.keyOf('google_drive', 'f2', { version: '1' });
    let n = 0;
    const load = async () => { n += 1; if (n === 1) throw new Error('boom'); return Buffer.from('ok'); };
    await assert.rejects(cache.bytes(key, load), /boom/);
    assert.strictEqual((await cache.bytes(key, load)).toString(), 'ok');
    assert.strictEqual(n, 2);
    assert.strictEqual(cache.stats().inFlight, 0);
});

test('parsed: computed once per sub-key, estimated from its rows, gone with its entry', async () => {
    const key = cache.keyOf('nextcloud_files', '/a.xlsx', { etag: '"1"' });
    let computes = 0;
    const compute = async () => { computes += 1; return { header: ['a', 'b'], rows: [[1, 2], [3, 4]] }; };
    const one = await cache.parsed(key, 'read|Blad1|1', compute);
    const two = await cache.parsed(key, 'read|Blad1|1', compute);
    assert.strictEqual(one, two);
    assert.strictEqual(computes, 1);
    await cache.parsed(key, 'read|Blad1|2', compute);
    assert.strictEqual(computes, 2);
    assert.ok(cache.stats().bytes >= 2 * (1024 + 2 * 2 * 16));
    cache.forget('nextcloud_files|/a.xlsx');
    assert.strictEqual(cache.stats().entries, 0);
    assert.strictEqual(cache.stats().bytes, 0);
});

test('entries expire sixty seconds after insertion, not after their last use', async () => {
    const key = cache.keyOf('google_drive', 'f3', { version: '1' });
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
        await cache.bytes(key, async () => Buffer.from('x'));
        now += cache.TTL_MS - 1;
        let loads = 0;
        assert.strictEqual((await cache.bytes(key, async () => { loads += 1; return Buffer.from('y'); })).toString(), 'x');
        now += 2;
        assert.strictEqual((await cache.bytes(key, async () => { loads += 1; return Buffer.from('y'); })).toString(), 'y');
        assert.strictEqual(loads, 1);
    } finally {
        Date.now = realNow;
    }
});

test('the budget drops the oldest entries first', async () => {
    const realNow = Date.now;
    let now = 5_000_000;
    Date.now = () => now;
    try {
        const big = Buffer.alloc(40 * 1024 * 1024);
        for (let i = 0; i < 3; i += 1) {
            now += 10;
            await cache.bytes(cache.keyOf('google_drive', `big${i}`, { version: '1' }), async () => big);
        }
        assert.ok(cache.stats().bytes <= cache.BUDGET_BYTES, `${cache.stats().bytes} within budget`);
        assert.strictEqual(cache.stats().entries, 2);
        let reloaded = false;
        await cache.bytes(cache.keyOf('google_drive', 'big0', { version: '1' }), async () => { reloaded = true; return big; });
        assert.strictEqual(reloaded, true, 'the oldest was the one dropped');
    } finally {
        Date.now = realNow;
        cache.clear();
    }
});
