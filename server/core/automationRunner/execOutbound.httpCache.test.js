/**
 * The DURABLE half of "ask this web service only once", through the real
 * execHttpRequest.
 *
 * Three things can only be seen from here, and each is a promise in the plan:
 *
 *   THE LEDGER. A durable hit writes exactly ONE flagged egress row; a run-memo
 *   hit writes none. integration_activity_log is the only evidence the org
 *   talks to a processor at all, so writing nothing would erase it from an
 *   Art-30 register — while a synthetic unflagged row would assert a transfer
 *   that did not happen and inflate the Art-44 count.
 *
 *   CONDITIONAL REVALIDATION. An entry past its TTL but inside the grace window
 *   is reissued with If-None-Match; a 304 refreshes it and serves the stored
 *   body, and it is a REAL call, so it logs a real (unflagged) row. This is the
 *   one mechanism here that cannot serve a stale answer.
 *
 *   THE CONSENT. Three switches — the process env, the org's opt-in, and its
 *   `scopes.http` tick — and the tick is the one an admin who only agreed to
 *   app look-ups never gave.
 *
 * Run: node --test --test-force-exit core/automationRunner/execOutbound.httpCache.test.js
 */

const test = require('node:test');
const { afterEach } = require('node:test');
const assert = require('node:assert');

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

mock('../../stores/automationStore', { getAutomation: async () => null, recordRunStep: async () => {} });
mock('../../stores/notificationStore', {});
mock('../../db', { pool: {} });
mock('../aiAgent', { getProviderForModel: async () => null });
mock('../providers', { getAdapter: () => ({}) });
mock('../../automation/codeSandbox', { run: async () => ({}) });

// Requiring the runner drags in the pricing service, which fires a REAL fetch
// to GitHub at load. Under --test-force-exit that TLS socket is still in flight
// when the process is torn down, and libuv aborts on it
// ("!(handle->flags & UV_HANDLE_CLOSING)") — reported as a file-level failure
// with every subtest green. A unit test has no business on the network anyway.
// Two module-load side effects that a unit test has no business carrying, and
// that BOTH abort libuv on teardown under --test-force-exit
// ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)") — which surfaces as
// a file-level failure with every subtest green:
//   decryptAudit arms a never-unref'd cleanup interval at require time;
//   pricingService fires a REAL fetch to GitHub at require time.
mock('../../auth/decryptAudit', { trackDecrypt: () => {}, getDecryptStats: () => null });
mock('../llm/pricingService', {
    ...require('../llm/pricingService'),
    // modelCosts.js:28 calls initPricing() at REQUIRE time, which opens a real
    // HTTPS connection to GitHub. Same no-op the modelCosts.*.test.js siblings
    // already install; everything else stays real so modelCosts still finds the
    // API it expects.
    initPricing: () => {},
});

// The org's cache policy row, steerable per test.
const configBlobs = {};
mock('../../stores/configStore', {
    async getConfig(key) { return configBlobs[key] !== undefined ? configBlobs[key] : null; },
    async setConfig(key, v) { configBlobs[key] = v; return true; },
});

// The ledger seam. safety.logEgress hands everything to logToolEgress, so this
// is where a flagged row is observable without a database.
const egressRows = [];
mock('../integrations/integrationLogging', {
    logToolEgress: (o) => { egressRows.push(o); },
    flushEgressLogs: async () => {},
});

// The durable store, in memory. `now` is controllable so a TTL can lapse
// without waiting for it.
let clock = 1_700_000_000_000;
const durableRows = new Map();   // key → { value, expiresAt, createdAt, toolName, userId, orgId }
const storeCalls = { get: 0, getStale: 0, put: 0, touch: 0 };
mock('../../stores/integrationCacheStore', {
    cacheKey: (identity) => `hmac:${identity}`,
    async get(key, orgId, { maxAgeSeconds = null } = {}) {
        storeCalls.get++;
        const row = durableRows.get(key);
        if (!row || row.orgId !== orgId) return null;
        if (row.expiresAt <= clock) return null;
        if (maxAgeSeconds !== null && row.createdAt < clock - maxAgeSeconds * 1000) return null;
        return { value: row.value };
    },
    async getStale(key, orgId, { graceSeconds } = {}) {
        storeCalls.getStale++;
        const row = durableRows.get(key);
        if (!row || row.orgId !== orgId) return null;
        if (row.expiresAt > clock) return null;
        if (row.expiresAt <= clock - graceSeconds * 1000) return null;
        return { value: row.value };
    },
    async touch(key, orgId, ttlSeconds) {
        storeCalls.touch++;
        const row = durableRows.get(key);
        if (!row || row.orgId !== orgId) return false;
        row.expiresAt = clock + ttlSeconds * 1000;
        row.createdAt = clock;
        return true;
    },
    async put({ key, organizationId, userId, toolName, value, ttlSeconds }) {
        storeCalls.put++;
        durableRows.set(key, {
            value, orgId: organizationId, userId, toolName,
            createdAt: clock, expiresAt: clock + ttlSeconds * 1000,
        });
        return true;
    },
    MAX_ENTRY_BYTES: 262_144,
});

const safeFetchCalls = [];
let safeFetchImpl = null;
mock('../../utils/ssrfGuard', {
    safeFetch: async (url, opts) => { safeFetchCalls.push({ url, opts }); return safeFetchImpl(url, opts); },
    isPrivateAddressError: () => false,
});

mock('./httpAuth', {
    MASK_VALUES: Symbol.for('beeflow.automation.maskValues'),
    resolveHttpAuthHeaders: async () => { throw new Error('not used here'); },
    evictToken: () => {},
});

const { execHttpRequest } = require('../automationRunner');
const { createToolMemo } = require('./toolMemo');
const cachePolicy = require('./integrationCachePolicy');
const { CONFIG_KEY_PREFIX } = cachePolicy;

const ORG = 'org-a';

function fakeResponse({ status = 200, headers = {}, body = '' }) {
    return { status, ok: status >= 200 && status < 300, headers: new Map(Object.entries(headers)), text: async () => body };
}
function baseState() {
    return { trigger: { output: {} }, steps: {}, vars: {}, secrets: {}, loop: {}, _templateWarnings: [] };
}
function ctx() {
    return { userId: 'u1', orgId: ORG, _toolMemo: createToolMemo() };
}
const STEP = {
    id: 'h1', type: 'http_request', method: 'GET',
    url: 'https://api.example.com/rates',
    askOnce: { acrossRuns: true },
};

function setPolicy(blob) {
    configBlobs[`${CONFIG_KEY_PREFIX}${ORG}`] = blob;
    cachePolicy.invalidateCachePolicy();
}

function reset({ enabled = true, http = true, ttlSeconds = 300 } = {}) {
    safeFetchCalls.length = 0;
    egressRows.length = 0;
    durableRows.clear();
    storeCalls.get = storeCalls.getStale = storeCalls.put = storeCalls.touch = 0;
    setPolicy({ enabled, ttlSeconds, scopes: { integration: true, http } });
    safeFetchImpl = async () => fakeResponse({
        status: 200, headers: { 'content-type': 'application/json' }, body: '{"rate":1.09}',
    });
}

/** The durable write is detached on purpose, so give it a turn to land. */
const settle = () => new Promise(r => setImmediate(r));

// Every test drains it, not just the ones that assert on the row: a detached
// write still in flight when the process is torn down under --test-force-exit
// aborts in libuv and is reported as a file-level failure with no failing
// assertion — a flake that looks exactly like a real bug.
afterEach(async () => { await settle(); await settle(); });

// ── the ledger ──────────────────────────────────────────────────────────────

test('a durable hit writes exactly ONE row, flagged served_from_cache', async () => {
    reset();
    await execHttpRequest(STEP, ctx(), baseState(), 'live');
    await settle();
    assert.strictEqual(egressRows.length, 1, 'the live call logs a real transfer');
    assert.strictEqual(!!egressRows[0].servedFromCache, false);
    assert.strictEqual(storeCalls.put, 1);

    // A SECOND RUN: fresh ctx, so the run memo is empty and the answer can only
    // come from the database.
    const result = await execHttpRequest(STEP, ctx(), baseState(), 'live');
    assert.strictEqual(result.reused, 'stored');
    assert.strictEqual(safeFetchCalls.length, 1, 'no bytes crossed the boundary on the second run');
    assert.strictEqual(egressRows.length, 2, 'the processor must not vanish from the Art-30 register');
    assert.strictEqual(egressRows[1].servedFromCache, true,
        'the Art-44 transfer count excludes this row, so it has to be flagged');
    assert.strictEqual(egressRows[1].toolName, 'http_request');
});

test('a RUN-MEMO hit writes no row at all', async () => {
    reset();
    const c = ctx();
    await execHttpRequest(STEP, c, baseState(), 'live');
    await settle();
    const before = egressRows.length;
    const second = await execHttpRequest(STEP, c, baseState(), 'live');
    assert.strictEqual(second.reused, 'run');
    assert.strictEqual(egressRows.length, before,
        'the first call in this run already logged the transfer — a second row double-counts it');
});

test('the durable row is named by HOSTNAME, never by the URL', async () => {
    // execOutbound interpolates step.url against RAW runState, so a
    // {{secrets.api_key}} resolves INTO it — and tool_name is a plaintext
    // column an admin screen can read.
    reset();
    await execHttpRequest(
        { ...STEP, url: 'https://api.example.com/rates?key={{secrets.api_key}}' },
        ctx(),
        { ...baseState(), secrets: { api_key: 'sk-live-do-not-log-me' } },
        'live',
    );
    await settle();
    const row = [...durableRows.values()][0];
    assert.strictEqual(row.toolName, 'http:api.example.com');
    assert.ok(!JSON.stringify(row.toolName).includes('sk-live'));
});

// ── the consent ─────────────────────────────────────────────────────────────

test('scopes.http off means the answer is never stored, however the org is set up', async () => {
    reset({ http: false });
    await execHttpRequest(STEP, ctx(), baseState(), 'live');
    await settle();
    assert.strictEqual(storeCalls.put, 0,
        'an admin who consented to app look-ups did not consent to arbitrary outbound HTTP');
    assert.strictEqual(storeCalls.get, 0);
    await execHttpRequest(STEP, ctx(), baseState(), 'live');
    assert.strictEqual(safeFetchCalls.length, 2);
});

test('a config row written before scopes existed is http-OFF, not http-on', async () => {
    reset();
    setPolicy({ enabled: true, ttlSeconds: 300 });   // no `scopes` key at all
    await execHttpRequest(STEP, ctx(), baseState(), 'live');
    await settle();
    assert.strictEqual(storeCalls.put, 0,
        'there is no reading of an older row under which the admin agreed to this');
});

test('the org opt-in off means nothing is stored either', async () => {
    reset({ enabled: false });
    await execHttpRequest(STEP, ctx(), baseState(), 'live');
    await settle();
    assert.strictEqual(storeCalls.put, 0);
});

test('a step without acrossRuns stays in the run memo only', async () => {
    reset();
    await execHttpRequest({ ...STEP, askOnce: true }, ctx(), baseState(), 'live');
    await settle();
    assert.strictEqual(storeCalls.get, 0);
    assert.strictEqual(storeCalls.put, 0);
});

// ── conditional revalidation ────────────────────────────────────────────────

test('an expired entry inside the grace window triggers a conditional GET; a 304 refreshes it AND logs a real row', async () => {
    reset();
    safeFetchImpl = async () => fakeResponse({
        status: 200,
        headers: { 'content-type': 'application/json', etag: 'W/"v1"' },
        body: '{"rate":1.09}',
    });
    await execHttpRequest(STEP, ctx(), baseState(), 'live');
    await settle();
    assert.strictEqual(storeCalls.put, 1);

    // Past the TTL, still inside one more TTL of grace.
    clock += 400 * 1000;
    egressRows.length = 0;
    safeFetchCalls.length = 0;
    safeFetchImpl = async () => fakeResponse({ status: 304, headers: {}, body: '' });

    const result = await execHttpRequest(STEP, ctx(), baseState(), 'live');
    assert.strictEqual(safeFetchCalls.length, 1, 'a conditional GET is a REAL call');
    assert.strictEqual(safeFetchCalls[0].opts.headers['If-None-Match'], 'W/"v1"');
    assert.strictEqual(result.output.body, '{"rate":1.09}', 'the 304 means the stored body is still current');
    assert.deepStrictEqual(result.output.data, { rate: 1.09 });
    assert.strictEqual(egressRows.length, 1);
    assert.strictEqual(!!egressRows[0].servedFromCache, false,
        'bytes really did cross the boundary, so this row is not a cache hit');
    assert.strictEqual(storeCalls.touch, 1, 'a 304 pushes the expiry out rather than refetching the body');
});

test('a 200 answering the conditional GET replaces the stored entry', async () => {
    reset();
    safeFetchImpl = async () => fakeResponse({
        status: 200, headers: { 'content-type': 'application/json', etag: 'W/"v1"' }, body: '{"rate":1.09}',
    });
    await execHttpRequest(STEP, ctx(), baseState(), 'live');
    await settle();

    clock += 400 * 1000;
    safeFetchImpl = async () => fakeResponse({
        status: 200, headers: { 'content-type': 'application/json', etag: 'W/"v2"' }, body: '{"rate":1.11}',
    });
    const result = await execHttpRequest(STEP, ctx(), baseState(), 'live');
    await settle();
    assert.deepStrictEqual(result.output.data, { rate: 1.11 });
    assert.strictEqual([...durableRows.values()][0].value.body, '{"rate":1.11}');
});

test('an entry with no validators is not revalidated — there is nothing to ask', async () => {
    reset();
    await execHttpRequest(STEP, ctx(), baseState(), 'live');   // no etag, no last-modified
    await settle();
    clock += 400 * 1000;
    safeFetchCalls.length = 0;
    await execHttpRequest(STEP, ctx(), baseState(), 'live');
    assert.strictEqual(safeFetchCalls.length, 1);
    assert.strictEqual(safeFetchCalls[0].opts.headers['If-None-Match'], undefined);
});

test('past the grace window it is an ordinary miss', async () => {
    reset();
    safeFetchImpl = async () => fakeResponse({
        status: 200, headers: { 'content-type': 'application/json', etag: 'W/"v1"' }, body: '{"rate":1.09}',
    });
    await execHttpRequest(STEP, ctx(), baseState(), 'live');
    await settle();
    clock += 10_000 * 1000;
    safeFetchCalls.length = 0;
    await execHttpRequest(STEP, ctx(), baseState(), 'live');
    assert.strictEqual(safeFetchCalls[0].opts.headers['If-None-Match'], undefined);
});

// ── the storage matrix, through the real executor ───────────────────────────

test('Cache-Control shortens the org window but can never lengthen it', async () => {
    reset({ ttlSeconds: 600 });
    safeFetchImpl = async () => fakeResponse({
        status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'max-age=60' }, body: '{}',
    });
    await execHttpRequest(STEP, ctx(), baseState(), 'live');
    await settle();
    const row = [...durableRows.values()][0];
    assert.strictEqual(row.expiresAt - row.createdAt, 60_000, 'min(step, org, max-age)');

    // And the other direction: an origin asking for a day gets the org's 600s.
    reset({ ttlSeconds: 600 });
    safeFetchImpl = async () => fakeResponse({
        status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'max-age=86400' }, body: '{}',
    });
    await execHttpRequest(STEP, ctx(), baseState(), 'live');
    await settle();
    const row2 = [...durableRows.values()][0];
    assert.strictEqual(row2.expiresAt - row2.createdAt, 600_000,
        'the origin must not overrule the organisation that consented');
});

test('a per-step ttl shortens it further', async () => {
    reset({ ttlSeconds: 600 });
    await execHttpRequest({ ...STEP, askOnce: { acrossRuns: true, ttlSeconds: 90 } }, ctx(), baseState(), 'live');
    await settle();
    const row = [...durableRows.values()][0];
    assert.strictEqual(row.expiresAt - row.createdAt, 90_000);
});

test('private keeps it out of the DATABASE while the run memo still works', async () => {
    reset();
    safeFetchImpl = async () => fakeResponse({
        status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'private, max-age=600' }, body: '{}',
    });
    const c = ctx();
    await execHttpRequest(STEP, c, baseState(), 'live');
    await settle();
    assert.strictEqual(storeCalls.put, 0, 'private means "not where a later run can read it"');
    const again = await execHttpRequest(STEP, c, baseState(), 'live');
    assert.strictEqual(again.reused, 'run', 'within one run it is still the same answer');
});

test('no-store keeps it out of both tiers', async () => {
    reset();
    safeFetchImpl = async () => fakeResponse({
        status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: '{}',
    });
    const c = ctx();
    await execHttpRequest(STEP, c, baseState(), 'live');
    await settle();
    await execHttpRequest(STEP, c, baseState(), 'live');
    assert.strictEqual(storeCalls.put, 0);
    assert.strictEqual(safeFetchCalls.length, 2);
});

test('a 500 is never stored — a transient failure must not freeze for the TTL', async () => {
    reset();
    safeFetchImpl = async () => fakeResponse({ status: 500, body: 'boom' });
    await execHttpRequest(STEP, ctx(), baseState(), 'live');
    await settle();
    assert.strictEqual(storeCalls.put, 0);
});

test('BFSF-436: an over-cap response now throws before dispatch even reaches httpCache.store — never stored', async () => {
    // This used to be a successful call whose truncated `out` reached
    // httpCache.store and was refused there by storability(). Now the step
    // fails outright, before `store` is ever called — a strictly stronger
    // guarantee that this test still confirms rather than assumes.
    reset();
    const huge = 'x'.repeat(1024 * 1024 + 10);
    safeFetchImpl = async () => fakeResponse({ status: 200, headers: { 'content-type': 'text/plain' }, body: huge });
    await assert.rejects(
        () => execHttpRequest(STEP, ctx(), baseState(), 'live'),
        /response body exceeded the 1 MiB limit/,
    );
    await settle();
    assert.strictEqual(storeCalls.put, 0);
});

test('a response that establishes a session is never stored', async () => {
    for (const header of ['set-cookie', 'www-authenticate', 'proxy-authenticate', 'authentication-info']) {
        reset();
        safeFetchImpl = async () => fakeResponse({
            status: 200, headers: { 'content-type': 'application/json', [header]: 'value' }, body: '{}',
        });
        await execHttpRequest(STEP, ctx(), baseState(), 'live');
        await settle();
        assert.strictEqual(storeCalls.put, 0, header);
    }
});

test('two orgs never share an answer', async () => {
    reset();
    await execHttpRequest(STEP, ctx(), baseState(), 'live');
    await settle();
    safeFetchCalls.length = 0;
    setPolicy({ enabled: true, ttlSeconds: 300, scopes: { integration: true, http: true } });
    configBlobs[`${CONFIG_KEY_PREFIX}org-b`] = { enabled: true, ttlSeconds: 300, scopes: { integration: true, http: true } };
    cachePolicy.invalidateCachePolicy();
    const other = await execHttpRequest(STEP, { userId: 'u9', orgId: 'org-b', _toolMemo: createToolMemo() }, baseState(), 'live');
    assert.strictEqual(other.reused, undefined);
    assert.strictEqual(safeFetchCalls.length, 1, 'org B must make its own call');
});
