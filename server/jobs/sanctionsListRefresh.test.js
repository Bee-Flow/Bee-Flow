'use strict';
/**
 * The refresh job with fake downloads and an in-memory store: a good file replaces the list, a
 * failed, broken or too small one never does, an unchanged one is not parsed, an unused server
 * makes no call, the size cap holds.
 * Run: cd server && node --test jobs/sanctionsListRefresh.test.js
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const job = require('./sanctionsListRefresh.mts');

const entity = (id) => ({ entityId: id, kind: 'person', names: [`Name ${id}`], birthDates: [], countries: [], programmes: [], reference: null, url: null });

function source(over = {}) {
    return {
        id: 'test_list', label: 'Test list', publisher: 'Test', infoUrl: 'https://example.test',
        files: [{ key: 'xml', as: 'text', url: 'https://lists.example.test/list.xml' }],
        minEntities: 2,
        parse: (f) => String(f.xml).split(',').filter(Boolean).map(entity),
        ...over,
    };
}

function fakeStore(status = []) {
    const calls = [];
    return {
        calls,
        replaceList: async (id, label, entities, meta) => { calls.push(['replace', id, entities.length, meta]); return { entities: entities.length, names: entities.length }; },
        recordFailure: async (id, label, error) => { calls.push(['failure', id, error]); },
        recordUnchanged: async (id) => { calls.push(['unchanged', id]); },
        listStatus: async () => status,
        anyOrganisationUses: async () => true,
        candidates: async () => [],
    };
}

function response(body, { status = 200, headers = {} } = {}) {
    return new Response(status === 304 ? null : body, { status, headers });
}

function setup({ store = fakeStore(), fetch, sources = [source()], env = {} } = {}) {
    const fetched = [];
    job._setDeps({
        pool: {},
        withNamedLock: async (_p, _n, fn) => ({ ran: true, value: await fn() }),
        store: () => store,
        fetch: async (url, init) => { fetched.push({ url, init }); return fetch(url, init); },
        envInt: (name, fallback) => (name in env ? env[name] : fallback),
        sources,
        log: { info: () => {}, warn: () => {} },
    });
    return { store, fetched };
}

afterEach(() => job._setDeps(null));

test('a good download replaces the list, with its ETag and content hash', async () => {
    const { store, fetched } = setup({ fetch: () => response('a,b,c', { headers: { etag: '"v1"' } }) });
    const out = await job.runOnce();
    assert.deepStrictEqual(out.ran && out.outcomes, [{ listId: 'test_list', result: 'replaced', entities: 3, names: 3 }]);
    const [, , count, meta] = store.calls[0];
    assert.strictEqual(count, 3);
    assert.strictEqual(meta.etag, '"v1"');
    assert.match(meta.contentHash, /^[0-9a-f]{64}$/);
    assert.strictEqual(fetched[0].init.timeoutPhase, 'headers');
});

test('an HTTP error, a parse error or too few entries records the failure and keeps the rows', async () => {
    for (const [fetch, sources, why] of [
        [() => response('down', { status: 503 }), [source()], /HTTP 503/],
        [() => response('a,b'), [source({ parse: () => { throw new Error('no <export> root'); } })], /no <export> root/],
        [() => response('a'), [source()], /fewer than the 2 expected; the stored list was kept/],
        [() => { throw new Error('getaddrinfo ENOTFOUND'); }, [source()], /ENOTFOUND/],
    ]) {
        const { store } = setup({ fetch, sources });
        const out = await job.runOnce();
        assert.strictEqual(out.ran && out.outcomes[0].result, 'failed');
        assert.deepStrictEqual(store.calls.map((c) => c[0]), ['failure']);
        assert.match(store.calls[0][2], why);
    }
});

test('an unchanged file is not parsed: 304 on the ETag, or the same content hash', async () => {
    let parsed = 0;
    const prev = { id: 'test_list', status: 'ok', etag: '"v1"', lastModified: null, contentHash: null };
    const { store, fetched } = setup({ store: fakeStore([prev]), fetch: () => response('', { status: 304 }), sources: [source({ parse: () => { parsed++; return []; } })] });
    await job.runOnce();
    assert.strictEqual(fetched[0].init.headers['If-None-Match'], '"v1"');
    assert.deepStrictEqual(store.calls, [['unchanged', 'test_list']]);
    assert.strictEqual(parsed, 0);

    const first = setup({ fetch: () => response('a,b') });
    await job.runOnce();
    const hash = first.store.calls[0][3].contentHash;
    const again = setup({ store: fakeStore([{ id: 'test_list', status: 'ok', etag: null, lastModified: null, contentHash: hash }]), fetch: () => response('a,b') });
    await job.runOnce();
    assert.deepStrictEqual(again.store.calls, [['unchanged', 'test_list']]);
    // A forced pass (the admin's "refresh now") imports anyway.
    const forced = setup({ store: fakeStore([{ id: 'test_list', status: 'ok', etag: null, lastModified: null, contentHash: hash }]), fetch: () => response('a,b') });
    await job.runOnce({ force: true });
    assert.strictEqual(forced.store.calls[0][0], 'replace');
});

test('no organisation uses the integration: no download, unless forced', async () => {
    const store = { ...fakeStore(), anyOrganisationUses: async () => false };
    const { fetched } = setup({ store, fetch: () => response('a,b') });
    assert.deepStrictEqual(await job.runOnce(), { ran: false, reason: 'unused' });
    assert.strictEqual(fetched.length, 0);
    await job.runOnce({ force: true });
    assert.strictEqual(fetched.length, 1);
});

test('another replica holding the lock skips the pass', async () => {
    job._setDeps({ withNamedLock: async () => ({ ran: false }), store: () => fakeStore(), fetch: async () => response('a,b'), sources: [source()], log: { info() {}, warn() {} }, envInt: (_n, f) => f });
    assert.deepStrictEqual(await job.runOnce(), { ran: false, reason: 'locked' });
});

test('a file above SANCTIONS_MAX_DOWNLOAD_MB is refused', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024);
    const { store } = setup({ fetch: () => response(big), env: { SANCTIONS_MAX_DOWNLOAD_MB: 1 } });
    await job.runOnce();
    assert.match(store.calls[0][2], /larger than 1 MB/);
    assert.strictEqual(job.settings().maxBytes, 1024 * 1024);
    setup({ fetch: () => response(''), env: { SANCTIONS_MAX_DOWNLOAD_MB: 0 } });
    assert.strictEqual(job.settings().maxBytes, Infinity);
});

test('SANCTIONS_REFRESH_INTERVAL_HOURS=0 starts no timer', () => {
    setup({ fetch: () => response(''), env: { SANCTIONS_REFRESH_INTERVAL_HOURS: 0 } });
    job.start();
    job.stop();
    assert.strictEqual(job.settings().intervalHours, 0);
});

test('a list that shrinks below 70% of what it held is refused unless forced', async () => {
    const prev = { id: 'test_list', status: 'ok', entityCount: 10, etag: null, lastModified: null, contentHash: 'old' };
    const { store } = setup({ store: fakeStore([prev]), fetch: () => response('a,b,c,d,e,f') });
    await job.runOnce();
    assert.deepStrictEqual(store.calls.map((c) => c[0]), ['failure']);
    assert.match(store.calls[0][2], /6 entries, less than 70% of the 10 stored; the stored list was kept/);
    const forced = setup({ store: fakeStore([prev]), fetch: () => response('a,b,c,d,e,f') });
    await job.runOnce({ force: true });
    assert.strictEqual(forced.store.calls[0][0], 'replace');
});

test('the hourly tick: not due while every list is fresh, due at once while a list is empty', async () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    const fresh = { id: 'test_list', status: 'ok', entityCount: 3, lastAttemptAt: recent, lastSuccessAt: recent, etag: null, lastModified: null, contentHash: null };
    const a = setup({ store: fakeStore([fresh]), fetch: () => response('a,b,c') });
    assert.deepStrictEqual(await job.runOnce(), { ran: false, reason: 'not_due' });
    assert.strictEqual(a.fetched.length, 0);
    const old = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const b = setup({ store: fakeStore([{ ...fresh, entityCount: 0, status: 'error', lastAttemptAt: old }]), fetch: () => response('a,b,c') });
    await job.runOnce();
    assert.strictEqual(b.fetched.length, 1, 'an empty list is retried every hour');
});

test('screening demand counts as use: a user without an organisation still gets the lists', async () => {
    const store = { ...fakeStore(), anyOrganisationUses: async () => false, hasRecentDemand: async () => true };
    const { fetched } = setup({ store, fetch: () => response('a,b') });
    await job.runOnce();
    assert.strictEqual(fetched.length, 1);
});
