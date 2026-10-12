/**
 * The durable half of "ask this app only once".
 *
 * This store outlives the run, so every guarantee the in-memory memo gets for
 * free has to be built here — and each test below is one of those guarantees.
 * Two matter more than the rest:
 *
 *   THE KEY IS NOT REVERSIBLE. A plain sha256 of a real look-up
 *   ({"email":"someone@a-company.com"}) is confirmable by anyone holding a
 *   database dump — the argument space is tiny. It is an HMAC under a
 *   server-side secret instead, so a stolen table cannot be used to prove which
 *   addresses an organisation looked up.
 *
 *   THE PAYLOAD IS NOT READABLE. The value is the raw third-party response — a
 *   mail search result is somebody's mail — so the column holds ciphertext.
 *
 * The rest of the file is about the two things that only bite once a second,
 * higher-volume writer arrives: the org quota (there was none) and the fact
 * that `expires_at` records the policy as it stood at WRITE time.
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-for-integration-cache';

const { createRecordingDb } = require('../testUtils/mockDb');
const { installResolveStub } = require('../testUtils/stubRequire');

const rows = [];
const mock = createRecordingDb({
    tables: { integration_response_cache: rows },
    onQuery(sql, params) {
        // The init probe asks for the table AND the payload_bytes column: an
        // installation that got the table from the old lazy DDL has no column.
        if (/to_regclass/i.test(sql)) {
            return { rows: [{ t: 'integration_response_cache', c: 1 }], rowCount: 1 };
        }
        if (/^\s*SELECT payload\b/i.test(sql)) {
            const [key, org, maxAge] = params;
            const hit = rows.find(r => r.cache_key === key
                && r.organization_id === org
                && r.expires_at > Date.now()
                && (maxAge == null || r.created_at > Date.now() - Number(maxAge) * 1000));
            return { rows: hit ? [{ payload: hit.payload }] : [], rowCount: hit ? 1 : 0 };
        }
        if (/^\s*INSERT INTO integration_response_cache/i.test(sql)) {
            const [cacheKey, organizationId, userId, toolName, payload, payloadBytes, ttl] = params;
            const at = rows.findIndex(r => r.cache_key === cacheKey);
            const row = {
                cache_key: cacheKey, organization_id: organizationId, user_id: userId,
                tool_name: toolName, payload, payload_bytes: payloadBytes,
                created_at: Date.now(),
                expires_at: Date.now() + Number(ttl) * 1000,
            };
            if (at >= 0) rows[at] = row; else rows.push(row);
            return { rows: [], rowCount: 1 };
        }
        // The migration's one-off sizing of rows written before the column.
        if (/^\s*UPDATE integration_response_cache\s+SET payload_bytes/i.test(sql)) {
            const hit = rows.filter(r => r.payload_bytes === null || r.payload_bytes === undefined);
            for (const r of hit) r.payload_bytes = Buffer.byteLength(String(r.payload), 'utf8');
            return { rows: [], rowCount: hit.length };
        }
        // shrinkTtlForOrg — only ever pulls an expiry back.
        if (/^\s*UPDATE integration_response_cache/i.test(sql) && /expires_at\s*=\s*LEAST/i.test(sql)) {
            const [org, secs] = params;
            const hit = rows.filter(r => r.organization_id === org
                && r.expires_at > r.created_at + Number(secs) * 1000);
            for (const r of hit) r.expires_at = r.created_at + Number(secs) * 1000;
            return { rows: [], rowCount: hit.length };
        }
        if (/^\s*DELETE FROM integration_response_cache/i.test(sql)) {
            const before = rows.length;
            let keep = rows;
            if (/expires_at <= NOW\(\)/i.test(sql)) keep = rows.filter(r => r.expires_at > Date.now());
            else if (/cache_key = \$1/i.test(sql)) {
                keep = rows.filter(r => !(r.cache_key === params[0] && r.organization_id === params[1]));
            } else if (/user_id = \$1/i.test(sql)) keep = rows.filter(r => r.user_id !== params[0]);
            else if (/organization_id = \$1/i.test(sql)) keep = rows.filter(r => r.organization_id !== params[0]);
            const kept = [...keep];
            rows.length = 0;
            rows.push(...kept);
            return { rows: [], rowCount: before - rows.length };
        }
        // The quota's usage read.
        if (/AS row_count/i.test(sql)) {
            const live = rows.filter(r => r.organization_id === params[0] && r.expires_at > Date.now());
            return {
                rows: [{ row_count: live.length, byte_count: live.reduce((n, r) => n + (r.payload_bytes || 0), 0) }],
                rowCount: 1,
            };
        }
        // statsForOrg.
        if (/AS expired_entries/i.test(sql)) {
            const mine = rows.filter(r => r.organization_id === params[0]);
            const live = mine.filter(r => r.expires_at > Date.now());
            return {
                rows: [{
                    entries: live.length,
                    expired_entries: mine.length - live.length,
                    bytes: live.reduce((n, r) => n + (r.payload_bytes || 0), 0),
                }],
                rowCount: 1,
            };
        }
        return { rows: [], rowCount: 0 };
    },
});
const restore = installResolveStub({ '../db': mock.db });
after(() => restore());

const store = require('./integrationCacheStore');

const ORG = 'org-a';
const USER = 'u1';
const seed = (over = {}) => store.put({
    key: store.cacheKey('k'), organizationId: ORG, userId: USER,
    toolName: 'gmail_search', value: { a: 1 }, ttlSeconds: 300, ...over,
});

/** A row the store never wrote — used to put an org over its quota cheaply. */
const fakeRow = (i, over = {}) => ({
    cache_key: `filler-${i}`, organization_id: ORG, user_id: USER,
    tool_name: 'gmail_search', payload: 'x', payload_bytes: 10,
    created_at: Date.now(), expires_at: Date.now() + 600_000, ...over,
});

beforeEach(() => {
    rows.length = 0;
    mock.reset();
    // The usage counter is memoised for 60s; without this every test after the
    // quota ones would inherit a full org.
    store.invalidateUsage();
});

// -- the key ---------------------------------------------------------------

test('the key is a digest, so the identity is never recoverable from it', () => {
    const k = store.cacheKey('gmail_search u1 org-a {"q":"super-secret-value"}');
    assert.match(k, /^[a-f0-9]{64}$/);
    assert.ok(!k.includes('secret'));
});

test('it is an HMAC, not a bare hash, so a dump alone cannot confirm a guess', () => {
    const identity = 'gmail_search u1 org-a {"email":"someone@a-company.com"}';
    const naive = crypto.createHash('sha256').update(identity).digest('hex');
    assert.notStrictEqual(store.cacheKey(identity), naive,
        'a plain sha256 over a tiny argument space is guess-and-check');
});

test('different identities never share a key, and the same one always does', () => {
    assert.notStrictEqual(store.cacheKey('a'), store.cacheKey('b'));
    assert.strictEqual(store.cacheKey('a'), store.cacheKey('a'));
});

// -- store and read --------------------------------------------------------

test('a miss is null and a hit is the value', async () => {
    const key = store.cacheKey('k');
    assert.strictEqual(await store.get(key, ORG), null);
    assert.strictEqual(await seed({ value: { rows: [1, 2] } }), true);
    assert.deepStrictEqual((await store.get(key, ORG)).value, { rows: [1, 2] });
});

test('the payload is stored encrypted, not as readable JSON', async () => {
    await seed({ value: { subject: 'Salary review' } });
    const stored = rows[0].payload;
    assert.ok(!stored.includes('Salary'), 'a table dump must not be readable mail');
    assert.match(stored, /^[a-f0-9]+:[a-f0-9]+:[a-f0-9]+$/, 'iv:tag:ciphertext, the house format');
});

test('a tampered payload reads as a MISS, and the row is REAPED', async () => {
    await seed();
    // Flip the last hex digit to a DIFFERENT one. `replace(/.$/, '0')` was a
    // no-op one time in sixteen — whenever the ciphertext already ended in
    // '0' — and on those runs the payload was never tampered at all: the
    // decrypt succeeded, `get` returned the value, and this test failed
    // claiming GCM authentication was broken. It was not; the fixture was.
    // Worse than the flake: on the runs it did NOT fail, it asserted nothing.
    const before = rows[0].payload;
    rows[0].payload = before.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
    assert.notStrictEqual(rows[0].payload, before,
        'the fixture must actually tamper with the payload, or this test proves nothing');
    assert.strictEqual(await store.get(store.cacheKey('k'), ORG), null,
        'GCM authentication failing must not be reported as "the app returned nothing"');
    // A blob that will not decrypt never will — a SESSION_SECRET rotation
    // invalidates the whole table at once. Leaving it costs a fetch and a
    // failed decrypt on every run that asks for it until its TTL runs out.
    assert.strictEqual(rows.length, 0, 'an unreadable row is deleted, not left to expire');
});

test('another organisation cannot read the row even holding the key', async () => {
    // The org is bound into the key upstream, so this is redundant while that
    // stays correct — which is exactly why it is here: a future bug in key
    // construction must not become a cross-tenant read.
    await seed();
    assert.strictEqual(await store.get(store.cacheKey('k'), 'org-b'), null);
});

test('an expired entry is not served', async () => {
    await seed();
    rows[0].expires_at = Date.now() - 1;
    assert.strictEqual(await store.get(store.cacheKey('k'), ORG), null);
});

test('an oversized answer is refused rather than truncated', async () => {
    const ok = await seed({ value: { pad: 'x'.repeat(5000) }, maxBytes: 100 });
    assert.strictEqual(ok, false);
    assert.strictEqual(await store.get(store.cacheKey('k'), ORG), null,
        'a truncated payload replayed as whole is the "arrayRef did not resolve to an array" failure');
});

test('a caller that names no size limit still gets one', async () => {
    // maxBytes used to be optional (`if (maxBytes && …)`), so a caller that
    // simply forgot the argument had no ceiling at all — one 40 MB response
    // and the org's whole budget is a single row.
    const ok = await seed({ value: { pad: 'x'.repeat(store.MAX_ENTRY_BYTES + 1) }, maxBytes: undefined });
    assert.strictEqual(ok, false);
    assert.strictEqual(rows.length, 0);
});

test('a write with no owner is refused, because an unattributable row cannot be erased', async () => {
    assert.strictEqual(await seed({ userId: null }), false);
    assert.strictEqual(await seed({ organizationId: null }), false);
});

test('a re-store replaces rather than duplicating', async () => {
    await seed({ value: { v: 1 } });
    await seed({ value: { v: 2 } });
    assert.strictEqual(rows.length, 1);
    assert.deepStrictEqual((await store.get(store.cacheKey('k'), ORG)).value, { v: 2 });
});

test('every stored row records its own size, so the quota needs no length(payload)', async () => {
    await seed();
    assert.strictEqual(rows[0].payload_bytes, Buffer.byteLength(rows[0].payload, 'utf8'));
});

// -- the current window, not the one that was in force at write time --------

test('an answer older than the CURRENT window is not served, whatever expires_at says', async () => {
    await seed({ ttlSeconds: 3600 });
    rows[0].created_at = Date.now() - 20 * 60 * 1000;   // 20 minutes ago
    assert.ok(rows[0].expires_at > Date.now(), 'the row is still inside its stamped expiry');
    assert.strictEqual(await store.get(store.cacheKey('k'), ORG, { maxAgeSeconds: 300 }), null,
        'an admin who just shortened the window means now, not in another 40 minutes');
    assert.ok(await store.get(store.cacheKey('k'), ORG, { maxAgeSeconds: 3600 }),
        'and the unchanged window still serves it');
});

test('shortening the org window pulls the stored rows back with it', async () => {
    await seed({ key: store.cacheKey('a'), ttlSeconds: 3600 });
    await seed({ key: store.cacheKey('b'), ttlSeconds: 3600 });
    const shrunk = await store.shrinkTtlForOrg(ORG, 300);
    assert.strictEqual(shrunk, 2);
    for (const r of rows) {
        assert.strictEqual(r.expires_at, r.created_at + 300_000);
    }
});

test('the shrink only ever shortens — widening the window changes nothing', async () => {
    await seed({ ttlSeconds: 300 });
    const before = rows[0].expires_at;
    assert.strictEqual(await store.shrinkTtlForOrg(ORG, 3600), 0);
    assert.strictEqual(rows[0].expires_at, before,
        'a longer window must not resurrect answers the shorter one already condemned');
});

test('the shrink is scoped to the organisation asking for it', async () => {
    await seed({ key: store.cacheKey('a'), ttlSeconds: 3600 });
    await seed({ key: store.cacheKey('b'), organizationId: 'org-b', ttlSeconds: 3600 });
    await store.shrinkTtlForOrg(ORG, 300);
    const other = rows.find(r => r.organization_id === 'org-b');
    assert.strictEqual(other.expires_at, other.created_at + 3_600_000);
});

// -- the per-org quota -----------------------------------------------------

test('an org at its row cap has further writes REFUSED, not evicted', async () => {
    for (let i = 0; i < store.MAX_ROWS_PER_ORG; i++) rows.push(fakeRow(i));
    assert.strictEqual(await seed(), false);
    assert.strictEqual(rows.length, store.MAX_ROWS_PER_ORG,
        'evicting would drop an answer a running automation is about to read');
});

test('an org at its byte cap has further writes refused', async () => {
    rows.push(fakeRow(0, { payload_bytes: store.MAX_BYTES_PER_ORG }));
    assert.strictEqual(await seed(), false);
    assert.strictEqual(rows.length, 1);
});

test('the cap is per organisation — a full org does not stop anyone else', async () => {
    for (let i = 0; i < store.MAX_ROWS_PER_ORG; i++) rows.push(fakeRow(i));
    assert.strictEqual(await seed(), false);
    assert.strictEqual(await seed({ organizationId: 'org-b', key: store.cacheKey('b') }), true);
});

test('a burst inside one usage window still trips the cap', async () => {
    // The count is memoised for 60s; a forEach can store hundreds of rows in
    // that time, so the write path has to count its own stores too.
    for (let i = 0; i < store.MAX_ROWS_PER_ORG - 1; i++) rows.push(fakeRow(i));
    assert.strictEqual(await seed({ key: store.cacheKey('a') }), true);
    assert.strictEqual(await seed({ key: store.cacheKey('b') }), false);
});

test('purging frees the quota immediately, not after the usage memo expires', async () => {
    for (let i = 0; i < store.MAX_ROWS_PER_ORG; i++) rows.push(fakeRow(i));
    assert.strictEqual(await seed(), false);
    await store.purgeForOrg(ORG);
    assert.strictEqual(await seed(), true);
});

// -- retention and erasure -------------------------------------------------

test('the prune drops only what has expired', async () => {
    await seed({ key: store.cacheKey('a') });
    await seed({ key: store.cacheKey('b') });
    rows[0].expires_at = Date.now() - 1;
    assert.strictEqual(await store.pruneExpired(), 1);
    assert.strictEqual(rows.length, 1);
});

test('erasing a user takes their cached answers with them', async () => {
    await seed({ key: store.cacheKey('a'), userId: 'u1' });
    await seed({ key: store.cacheKey('b'), userId: 'u2' });
    assert.strictEqual(await store.purgeForUser('u1'), 1);
    assert.deepStrictEqual(rows.map(r => r.user_id), ['u2']);
});

test('switching the org off forgets everything it had stored', async () => {
    await seed({ key: store.cacheKey('a') });
    await seed({ key: store.cacheKey('b'), organizationId: 'org-b' });
    assert.strictEqual(await store.purgeForOrg(ORG), 1);
    assert.deepStrictEqual(rows.map(r => r.organization_id), ['org-b']);
});

// -- stats -----------------------------------------------------------------

test('stats report expired-but-present rows too, and never leak a value', async () => {
    // The prune runs hourly. Reporting only live entries told an org it held
    // nothing while thousands of rows sat in the table between passes — and
    // hid the purge button on exactly that screen.
    await seed({ key: store.cacheKey('a') });
    await seed({ key: store.cacheKey('b') });
    rows[0].expires_at = Date.now() - 1;
    const s = await store.statsForOrg(ORG);
    assert.deepStrictEqual(Object.keys(s).sort(), ['bytes', 'entries', 'expiredEntries']);
    assert.strictEqual(s.entries, 1);
    assert.strictEqual(s.expiredEntries, 1);
    assert.strictEqual(s.bytes, rows[1].payload_bytes);
});

test('an org with nothing stored reports zeroes rather than a missing field', async () => {
    assert.deepStrictEqual(await store.statsForOrg(ORG), { entries: 0, expiredEntries: 0, bytes: 0 });
    assert.deepStrictEqual(await store.statsForOrg(null), { entries: 0, expiredEntries: 0, bytes: 0 });
});

// -- the migration ---------------------------------------------------------

test('the backfill sizes rows written before payload_bytes existed', async () => {
    // A NULL in the SUM would silently under-count the org against its cap,
    // which is the direction that lets an unbounded table grow.
    rows.push(fakeRow(1, { payload: 'abcd', payload_bytes: null }));
    rows.push(fakeRow(2, { payload: 'abcdefg', payload_bytes: null }));
    await require('../migrations/integration-response-cache-2026-09').up();
    assert.deepStrictEqual(rows.map(r => r.payload_bytes), [4, 7]);
});
