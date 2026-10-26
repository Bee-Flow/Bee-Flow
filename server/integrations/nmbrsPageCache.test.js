/**
 * Unit tests of the NMBRS page cache (nmbrsPageCache.mts): TTL, LRU bounds, shared in-flight
 * fetches, failures, invalidation. No NMBRS, no network: the fetch is a counting function and
 * the clock is injected.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { PageCache, readPageCacheConfig, buildCacheKey, credentialFingerprint } = require('./nmbrsPageCache.mts');

const PARTS = { orgId: 'org1', userId: 'u1', credential: 'cred1', tool: 'nmbrs_list_company_contracts', companyId: '9', args: {} };
const rowsOf = (n, tag = 'r') => Array.from({ length: n }, (_, i) => ({ id: `${tag}${i}` }));

function counting(rows) {
    const fn = async () => { fn.calls += 1; return typeof rows === 'function' ? rows(fn.calls) : rows; };
    fn.calls = 0;
    return fn;
}
function deferred() {
    let resolve; let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

test('first page fetches, later pages are served from the cache', async () => {
    const cache = new PageCache({ ttlMs: 1000 });
    const fetchRows = counting(rowsOf(5));
    assert.equal((await cache.load(PARTS, fetchRows, { fresh: true })).outcome, 'refresh');
    for (let i = 0; i < 4; i++) assert.equal((await cache.load(PARTS, fetchRows, { fresh: false })).outcome, 'hit');
    assert.equal(fetchRows.calls, 1);
    assert.deepEqual(cache.stats()[PARTS.tool], { hit: 4, miss: 0, refresh: 1, shared: 0, bypass: 0, evicted: 0 });
});

test('offset 0 (fresh) always refetches and replaces the entry', async () => {
    const cache = new PageCache({ ttlMs: 1000 });
    const fetchRows = counting((n) => rowsOf(2, `v${n}-`));
    await cache.load(PARTS, fetchRows, { fresh: true });
    const second = await cache.load(PARTS, fetchRows, { fresh: true });
    assert.equal(fetchRows.calls, 2);
    assert.deepEqual(second.rows, rowsOf(2, 'v2-'));
    assert.deepEqual((await cache.load(PARTS, fetchRows, { fresh: false })).rows, rowsOf(2, 'v2-'));
    assert.equal(fetchRows.calls, 2);
});

test('a later page without a cached entry fetches and stores', async () => {
    const cache = new PageCache({ ttlMs: 1000 });
    const fetchRows = counting(rowsOf(3));
    assert.equal((await cache.load(PARTS, fetchRows, { fresh: false })).outcome, 'miss');
    assert.equal((await cache.load(PARTS, fetchRows, { fresh: false })).outcome, 'hit');
    assert.equal(fetchRows.calls, 1);
});

test('a different organisation, user, connection, tool, company or argument is a separate entry', async () => {
    const cache = new PageCache({ ttlMs: 1000 });
    const variants = [
        PARTS,
        { ...PARTS, orgId: 'org2' },
        { ...PARTS, userId: 'u2' },
        { ...PARTS, credential: 'cred2' },
        { ...PARTS, tool: 'nmbrs_list_company_runs' },
        { ...PARTS, companyId: '10' },
        { ...PARTS, args: { year: 2026 } },
        { ...PARTS, args: { year: 2025 } },
        { ...PARTS, args: { year: 2026, period: 3 } },
    ];
    const fetchRows = counting((n) => rowsOf(1, `c${n}-`));
    for (const parts of variants) await cache.load(parts, fetchRows, { fresh: false });
    assert.equal(fetchRows.calls, variants.length, 'each variant fetched once');
    for (const [i, parts] of variants.entries()) {
        const { rows, outcome } = await cache.load(parts, fetchRows, { fresh: false });
        assert.equal(outcome, 'hit');
        assert.deepEqual(rows, rowsOf(1, `c${i + 1}-`), 'each variant reads its own list');
    }
    assert.equal(fetchRows.calls, variants.length);
});

test('argument order does not split an entry; offset and limit are not key parts', async () => {
    const a = buildCacheKey({ ...PARTS, args: { year: 2026, period: 3 } });
    const b = buildCacheKey({ ...PARTS, args: { period: 3, year: 2026 } });
    assert.equal(a, b);
    assert.notEqual(buildCacheKey({ ...PARTS, orgId: null }), buildCacheKey({ ...PARTS, orgId: 'org1' }));
});

test('the entry expires after the TTL and is fetched again', async () => {
    let now = 1_000;
    const cache = new PageCache({ ttlMs: 500, now: () => now });
    const fetchRows = counting(rowsOf(2));
    await cache.load(PARTS, fetchRows, { fresh: true });
    now += 499;
    assert.equal((await cache.load(PARTS, fetchRows, { fresh: false })).outcome, 'hit');
    now += 2;
    assert.equal((await cache.load(PARTS, fetchRows, { fresh: false })).outcome, 'miss');
    assert.equal(fetchRows.calls, 2);
    assert.equal(cache.size.entries, 1);
});

test('TTL 0 disables the cache: every call fetches, nothing is kept', async () => {
    const cache = new PageCache({ ttlMs: 0 });
    const fetchRows = counting(rowsOf(2));
    for (const fresh of [true, false, false]) assert.equal((await cache.load(PARTS, fetchRows, { fresh })).outcome, 'bypass');
    assert.equal(fetchRows.calls, 3);
    assert.deepEqual(cache.size, { entries: 0, items: 0 });
    assert.equal(cache.enabled, false);
});

test('concurrent requests for one key share one fetch', async () => {
    const cache = new PageCache({ ttlMs: 1000 });
    const gate = deferred();
    let calls = 0;
    const fetchRows = async () => { calls += 1; return gate.promise; };
    const pending = [
        cache.load(PARTS, fetchRows, { fresh: false }),
        cache.load(PARTS, fetchRows, { fresh: false }),
        cache.load(PARTS, fetchRows, { fresh: false }),
    ];
    gate.resolve(rowsOf(4));
    const results = await Promise.all(pending);
    assert.equal(calls, 1);
    assert.deepEqual(results.map((r) => r.outcome), ['miss', 'shared', 'shared']);
    for (const r of results) assert.deepEqual(r.rows, rowsOf(4));
    // Another key is not held up by it.
    await cache.load({ ...PARTS, companyId: '77' }, fetchRows, { fresh: false });
    assert.equal(calls, 2);
});

test('a failed fetch is not cached; waiting callers get the error and the next call retries', async () => {
    const cache = new PageCache({ ttlMs: 1000 });
    const gate = deferred();
    let calls = 0;
    const failing = async () => { calls += 1; return gate.promise; };
    const a = cache.load(PARTS, failing, { fresh: false });
    const b = cache.load(PARTS, failing, { fresh: false });
    gate.reject(new Error('NMBRS returned a server error'));
    await assert.rejects(a, /server error/);
    await assert.rejects(b, /server error/);
    assert.equal(calls, 1);
    assert.deepEqual(cache.size, { entries: 0, items: 0 });
    const ok = counting(rowsOf(2));
    assert.equal((await cache.load(PARTS, ok, { fresh: false })).outcome, 'miss');
    assert.equal(ok.calls, 1);
});

test('a failed refresh also removes the stale entry', async () => {
    const cache = new PageCache({ ttlMs: 1000 });
    await cache.load(PARTS, counting(rowsOf(2, 'old')), { fresh: true });
    await assert.rejects(cache.load(PARTS, async () => { throw new Error('boom'); }, { fresh: true }), /boom/);
    assert.equal(cache.size.entries, 0, 'a new run never falls back to the old list');
});

test('LRU: the least recently used list goes first when the entry bound is hit', async () => {
    const cache = new PageCache({ ttlMs: 1000, maxEntries: 2, maxItems: 0 });
    const fetchRows = counting(rowsOf(1));
    const p = (companyId) => ({ ...PARTS, companyId });
    await cache.load(p('a'), fetchRows, { fresh: true });
    await cache.load(p('b'), fetchRows, { fresh: true });
    await cache.load(p('a'), fetchRows, { fresh: false }); // a is now the most recent
    await cache.load(p('c'), fetchRows, { fresh: true }); // evicts b
    assert.equal(cache.size.entries, 2);
    assert.equal((await cache.load(p('a'), fetchRows, { fresh: false })).outcome, 'hit');
    assert.equal((await cache.load(p('b'), fetchRows, { fresh: false })).outcome, 'miss');
    assert.ok(cache.stats()[PARTS.tool].evicted >= 1);
});

test('the total number of rows is bounded; a list bigger than the budget is not kept', async () => {
    const cache = new PageCache({ ttlMs: 1000, maxEntries: 0, maxItems: 10 });
    const p = (companyId) => ({ ...PARTS, companyId });
    await cache.load(p('a'), counting(rowsOf(6)), { fresh: true });
    await cache.load(p('b'), counting(rowsOf(6)), { fresh: true }); // 12 > 10: a goes
    assert.deepEqual(cache.size, { entries: 1, items: 6 });
    const huge = counting(rowsOf(11));
    await cache.load(p('c'), huge, { fresh: true });
    assert.deepEqual(cache.size, { entries: 1, items: 6 }, 'not stored');
    assert.equal((await cache.load(p('c'), huge, { fresh: false })).outcome, 'miss');
    assert.equal(huge.calls, 2);
});

test('0 means unlimited for the bounds', async () => {
    const cache = new PageCache({ ttlMs: 1000, maxEntries: 0, maxItems: 0 });
    for (let i = 0; i < 200; i++) await cache.load({ ...PARTS, companyId: String(i) }, counting(rowsOf(50)), { fresh: true });
    assert.deepEqual(cache.size, { entries: 200, items: 10_000 });
});

test('expired entries are swept when a new list is stored', async () => {
    let now = 0;
    const cache = new PageCache({ ttlMs: 100, now: () => now });
    await cache.load(PARTS, counting(rowsOf(3)), { fresh: true });
    now = 500;
    await cache.load({ ...PARTS, companyId: '2' }, counting(rowsOf(2)), { fresh: true });
    assert.deepEqual(cache.size, { entries: 1, items: 2 });
});

test('invalidateUser and invalidateOrg drop their lists, also those still being fetched', async () => {
    const cache = new PageCache({ ttlMs: 1000 });
    await cache.load(PARTS, counting(rowsOf(2)), { fresh: true });
    await cache.load({ ...PARTS, userId: 'u2' }, counting(rowsOf(2)), { fresh: true });
    await cache.load({ ...PARTS, userId: 'u3', orgId: 'org9' }, counting(rowsOf(2)), { fresh: true });
    cache.invalidateUser('u1');
    assert.equal(cache.size.entries, 2);
    cache.invalidateOrg('org9');
    assert.equal(cache.size.entries, 1);
    cache.clear();
    assert.deepEqual(cache.size, { entries: 0, items: 0 });

    // A fetch that started before the invalidation does not write its old list back.
    const gate = deferred();
    const slow = cache.load(PARTS, async () => gate.promise, { fresh: false });
    cache.invalidateUser('u1');
    gate.resolve(rowsOf(2));
    assert.equal((await slow).rows.length, 2, 'the caller still gets its answer');
    assert.equal(cache.size.entries, 0);
});

test('the outcome callback gets the tool name and the outcome only', async () => {
    const seen = [];
    const cache = new PageCache({ ttlMs: 1000, onOutcome: (...args) => seen.push(args) });
    const fetchRows = counting([{ secret: 'TOPSECRETROW' }]);
    await cache.load(PARTS, fetchRows, { fresh: true });
    await cache.load(PARTS, fetchRows, { fresh: false });
    assert.deepEqual(seen, [[PARTS.tool, 'refresh'], [PARTS.tool, 'hit']]);
    assert.ok(!JSON.stringify([seen, cache.stats()]).includes('TOPSECRETROW'));
});

test('the fingerprint changes with the credentials and never contains the secret', () => {
    const base = { mode: 'soap', env: 'production', subdomain: 'acme', email: 'me@acme.nl', token: 'a1b2c3d4e5f6a7b8c9d0e1f2' };
    const f = credentialFingerprint(base);
    assert.equal(f, credentialFingerprint({ ...base }));
    for (const change of [{ token: 'z1b2c3d4e5f6a7b8c9d0e1f2' }, { subdomain: 'other' }, { mode: 'rest' }, { env: 'sandbox' }, { email: 'x@acme.nl' }]) {
        assert.notEqual(credentialFingerprint({ ...base, ...change }), f, JSON.stringify(change));
    }
    assert.ok(!f.includes(base.token) && !f.includes('acme'));
});

test('readPageCacheConfig: defaults, overrides, and nonsense falls back', () => {
    assert.deepEqual(readPageCacheConfig({}), { ttlMs: 120000, maxEntries: 50, maxItems: 200000 });
    assert.deepEqual(
        readPageCacheConfig({ NMBRS_PAGE_CACHE_TTL_MS: '0', NMBRS_PAGE_CACHE_MAX_ENTRIES: '7', NMBRS_PAGE_CACHE_MAX_ITEMS: '0' }),
        { ttlMs: 0, maxEntries: 7, maxItems: 0 },
    );
    assert.deepEqual(
        readPageCacheConfig({ NMBRS_PAGE_CACHE_TTL_MS: '-5', NMBRS_PAGE_CACHE_MAX_ENTRIES: 'many', NMBRS_PAGE_CACHE_MAX_ITEMS: '1.5' }),
        { ttlMs: 120000, maxEntries: 50, maxItems: 200000 },
    );
});
