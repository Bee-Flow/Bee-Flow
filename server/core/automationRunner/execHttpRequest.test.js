/**
 * Unit tests for execHttpRequest — the declarative outbound HTTP/webhook
 * step. Covers: template interpolation (url/headers/body), the
 * reads-live/writes-simulated dry-run convention (mirrors
 * execIntegrationAction's sideEffect gate), the OPTIONAL `blockPrivateTargets`
 * security toggle (default true → routes through utils/ssrfGuard's
 * safeFetch; false → a bare fetch, a deliberate escape hatch, never the
 * default), and — BFSF-436 — that a response over the 1 MiB cap now FAILS
 * THE STEP with an actionable error instead of silently returning a
 * clipped, invalid-JSON body under `success`.
 *
 * Heavy deps are pre-mocked via the require cache (same approach as
 * execLoop.batchSize.test.js). utils/ssrfGuard is ALSO mocked here so tests
 * control exactly when a "private address" refusal happens without any
 * real DNS/network activity.
 *
 * Run: node --test core/automationRunner/execHttpRequest.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

mock('../../stores/automationStore', { getAutomation: async () => null, recordRunStep: async () => {} });
mock('../../stores/configStore', {});
mock('../../stores/notificationStore', {});
mock('../../db', { pool: {} });
mock('../aiAgent', { getProviderForModel: async () => null });
mock('../providers', { getAdapter: () => ({}) });
mock('../../automation/codeSandbox', { run: async () => ({}) });

// Captures every call so tests can assert on method/headers/body/signal
// without a real network call. Each test sets `safeFetchImpl` to control
// the response/rejection for that case.
const safeFetchCalls = [];
let safeFetchImpl = null;
class FakePrivateAddressError extends Error {
    constructor(host) { super('Refused: target resolves to a private/internal address.'); this.code = 'EPRIVATEADDRESS'; this.host = host; }
}
mock('../../utils/ssrfGuard', {
    safeFetch: async (url, opts) => {
        safeFetchCalls.push({ url, opts });
        return safeFetchImpl(url, opts);
    },
    isPrivateAddressError: (e) => e && e.code === 'EPRIVATEADDRESS',
});

// Feature C — credential injection is httpAuth's job; here it is mocked so
// these tests control the injected headers/mask values without a store.
// MASK_VALUES must stay the real Symbol.for key (global registry).
const authState = { impl: null, calls: [], evicted: [] };
mock('./httpAuth', {
    MASK_VALUES: Symbol.for('beeflow.automation.maskValues'),
    resolveHttpAuthHeaders: async (args, ctx) => { authState.calls.push({ args, ctx }); return authState.impl(args, ctx); },
    evictToken: (id) => { authState.evicted.push(id); },
});

const { execHttpRequest } = require('../automationRunner');
const { secretValuesFor, MASK_VALUES } = require('./engine');

function fakeResponse({ status = 200, headers = {}, body = '' }) {
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: new Map(Object.entries(headers)),
        text: async () => body,
    };
}

function baseState(overrides = {}) {
    return { trigger: { output: {} }, steps: {}, vars: {}, secrets: {}, loop: {}, _templateWarnings: [], ...overrides };
}

test('GET: happy path returns status/ok/headers/body', async () => {
    safeFetchCalls.length = 0;
    safeFetchImpl = async () => fakeResponse({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' });
    const step = { id: 'h1', type: 'http_request', url: 'https://api.example.com/things' };
    const result = await execHttpRequest(step, {}, baseState(), 'live');
    assert.strictEqual(result.output.status, 200);
    assert.strictEqual(result.output.ok, true);
    assert.strictEqual(result.output.body, '{"ok":true}');
    assert.strictEqual(result.output.headers['content-type'], 'application/json');
    assert.strictEqual(result.output.truncated, false);
    assert.strictEqual(safeFetchCalls.length, 1, 'blockPrivateTargets defaults true — must go through safeFetch');
    assert.strictEqual(safeFetchCalls[0].opts.method, 'GET');
});

test('url, headers, and body are all template-interpolated against runState', async () => {
    safeFetchCalls.length = 0;
    safeFetchImpl = async () => fakeResponse({ status: 201, body: 'created' });
    const step = {
        id: 'h1', type: 'http_request', method: 'POST',
        url: 'https://api.example.com/users/{{trigger.output.id}}',
        headers: { Authorization: 'Bearer {{trigger.output.token}}' },
        body: '{"name":"{{trigger.output.name}}"}',
    };
    const runState = baseState({ trigger: { output: { id: '42', token: 'tok_abc', name: 'Ada' } } });
    const result = await execHttpRequest(step, {}, runState, 'live');
    assert.strictEqual(result.output.status, 201);
    assert.strictEqual(safeFetchCalls[0].url, 'https://api.example.com/users/42');
    assert.strictEqual(safeFetchCalls[0].opts.headers.Authorization, 'Bearer tok_abc');
    assert.strictEqual(safeFetchCalls[0].opts.body, '{"name":"Ada"}');
});

test('dry-run: a write method (POST) is SYNTHESIZED — never actually dispatched', async () => {
    safeFetchCalls.length = 0;
    let called = false;
    safeFetchImpl = async () => { called = true; return fakeResponse({ status: 200 }); };
    const step = { id: 'h1', type: 'http_request', method: 'POST', url: 'https://api.example.com/orders', body: '{}' };
    const result = await execHttpRequest(step, {}, baseState(), 'dry_run');
    assert.strictEqual(called, false, 'a POST must never actually dispatch during dry-run');
    assert.strictEqual(result.dryRunSynthesised, true);
    assert.strictEqual(result.output._dryRun, true);
});

test('dry-run: GET/HEAD still execute LIVE — reads-live/writes-simulated, same convention as execIntegrationAction', async () => {
    safeFetchCalls.length = 0;
    safeFetchImpl = async () => fakeResponse({ status: 200, body: 'real preview data' });
    const step = { id: 'h1', type: 'http_request', method: 'GET', url: 'https://api.example.com/things' };
    const result = await execHttpRequest(step, {}, baseState(), 'dry_run');
    assert.strictEqual(safeFetchCalls.length, 1, 'GET must actually dispatch even in dry-run, for a real preview');
    assert.strictEqual(result.output.body, 'real preview data');
});

test('BFSF-436: response body over the 1MB cap now FAILS THE STEP instead of returning a silently-clipped success', async () => {
    safeFetchCalls.length = 0;
    const big = 'x'.repeat(1024 * 1024 + 100);
    safeFetchImpl = async () => fakeResponse({ status: 200, body: big });
    const step = { id: 'h1', type: 'http_request', url: 'https://api.example.com/big' };
    await assert.rejects(
        () => execHttpRequest(step, {}, baseState(), 'live'),
        /http_request: response body exceeded the 1 MiB limit and was clipped mid-document/,
    );
});

test('blockPrivateTargets default true: a private-address refusal from safeFetch surfaces a friendly, actionable error', async () => {
    safeFetchImpl = async () => { throw new FakePrivateAddressError('169.254.169.254'); };
    const step = { id: 'h1', type: 'http_request', url: 'http://169.254.169.254/latest/meta-data' };
    await assert.rejects(
        () => execHttpRequest(step, {}, baseState(), 'live'),
        /private\/internal address/i,
    );
});

test('blockPrivateTargets: false is an explicit opt-out — uses a bare fetch, NOT safeFetch', async () => {
    safeFetchCalls.length = 0;
    const originalFetch = global.fetch;
    let bareFetchCalled = false;
    global.fetch = async (_url, _opts) => { bareFetchCalled = true; return fakeResponse({ status: 200, body: 'internal ok' }); };
    try {
        const step = { id: 'h1', type: 'http_request', url: 'http://internal.local/health', blockPrivateTargets: false };
        const result = await execHttpRequest(step, {}, baseState(), 'live');
        assert.strictEqual(bareFetchCalled, true, 'blockPrivateTargets:false must bypass safeFetch entirely');
        assert.strictEqual(safeFetchCalls.length, 0, 'safeFetch (the guarded path) must NOT be invoked when the toggle is off');
        assert.strictEqual(result.output.body, 'internal ok');
    } finally {
        global.fetch = originalFetch;
    }
});

test('an unsupported URL scheme is rejected before any fetch happens', async () => {
    safeFetchCalls.length = 0;
    const step = { id: 'h1', type: 'http_request', url: 'ftp://example.com/file' };
    await assert.rejects(
        () => execHttpRequest(step, {}, baseState(), 'live'),
        /unsupported URL scheme/i,
    );
    assert.strictEqual(safeFetchCalls.length, 0);
});

test('a malformed URL is rejected with a clear message', async () => {
    const step = { id: 'h1', type: 'http_request', url: 'not a url at all' };
    await assert.rejects(
        () => execHttpRequest(step, {}, baseState(), 'live'),
        /invalid URL/i,
    );
});

test('an aborted (timed-out) request surfaces a clear timeout message', async () => {
    safeFetchImpl = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
    const step = { id: 'h1', type: 'http_request', url: 'https://api.example.com/slow', timeoutMs: 1000 };
    await assert.rejects(
        () => execHttpRequest(step, {}, baseState(), 'live'),
        /timed out after 1000ms/i,
    );
});

// ── Feature C: step.auth = { connectionId } credential injection ────

test('no step.auth → credential resolution is never touched (back-compat path)', async () => {
    authState.calls.length = 0;
    safeFetchImpl = async () => fakeResponse({ status: 200, body: 'ok' });
    await execHttpRequest({ id: 'h1', type: 'http_request', url: 'https://api.example.com/x' }, {}, baseState(), 'live');
    await execHttpRequest({ id: 'h1', type: 'http_request', url: 'https://api.example.com/x', auth: null }, {}, baseState(), 'live');
    assert.strictEqual(authState.calls.length, 0);
});

test('auth: injected credential header replaces a manual Authorization header case-insensitively', async () => {
    safeFetchCalls.length = 0;
    authState.calls.length = 0;
    authState.impl = async () => ({ headers: { Authorization: 'Bearer tok-cred-1' }, maskValues: ['tok-cred-1', 'Bearer tok-cred-1'], label: 'Cred', accessMode: 'own' });
    safeFetchImpl = async () => fakeResponse({ status: 200, body: 'ok' });
    const step = {
        id: 'h1', type: 'http_request', url: 'https://api.example.com/x',
        headers: { authorization: 'Bearer manual-typed', 'X-Other': 'kept' },
        auth: { connectionId: 'conn-1' },
    };
    const ctx = { userId: 'u1', orgId: 'orgA', userGroupIds: ['g1'] };
    await execHttpRequest(step, ctx, baseState(), 'live');
    const sent = safeFetchCalls[0].opts.headers;
    assert.strictEqual(sent.Authorization, 'Bearer tok-cred-1', 'credential header wins');
    assert.ok(!('authorization' in sent), 'lowercase manual duplicate removed');
    assert.strictEqual(sent['X-Other'], 'kept', 'unrelated headers untouched');
    // step settings + run ctx are forwarded to httpAuth
    assert.strictEqual(authState.calls[0].args.connectionId, 'conn-1');
    assert.strictEqual(authState.calls[0].args.blockPrivateTargets, true);
    assert.strictEqual(authState.calls[0].ctx.userId, 'u1');
});

test('auth: mask values land in runState[MASK_VALUES] and flow out via secretValuesFor', async () => {
    authState.impl = async () => ({ headers: { 'X-API-Key': 'key-raw-9' }, maskValues: ['key-raw-9'], label: 'Cred', accessMode: 'own' });
    safeFetchImpl = async () => fakeResponse({ status: 200, body: 'ok' });
    const runState = baseState();
    await execHttpRequest({ id: 'h1', type: 'http_request', url: 'https://api.example.com/x', auth: { connectionId: 'conn-2' } }, {}, runState, 'live');
    assert.deepStrictEqual(runState[MASK_VALUES], ['key-raw-9']);
    assert.ok(secretValuesFor(runState).includes('key-raw-9'), 'recordRunStep chokepoint sees the needle');
    assert.ok(!JSON.stringify(runState).includes('key-raw-9'), 'Symbol key is invisible to JSON/templates');
});

test('auth: mask values are registered even when the fetch itself throws', async () => {
    authState.impl = async () => ({ headers: { Authorization: 'Bearer tok-cred-X' }, maskValues: ['tok-cred-X', 'Bearer tok-cred-X'], label: 'Cred', accessMode: 'own' });
    safeFetchImpl = async () => { throw new Error('boom'); };
    const runState = baseState();
    await assert.rejects(
        () => execHttpRequest({ id: 'h1', type: 'http_request', url: 'https://api.example.com/x', auth: { connectionId: 'conn-3' } }, {}, runState, 'live'),
        /http_request: boom/,
    );
    assert.ok(runState[MASK_VALUES].includes('tok-cred-X'), 'needles present before the throw is recorded');
});

test('dry-run: a GET WITH auth is synthesized — credentials are never resolved in dry-run', async () => {
    safeFetchCalls.length = 0;
    authState.calls.length = 0;
    authState.impl = async () => { throw new Error('must not be called'); };
    const step = { id: 'h1', type: 'http_request', method: 'GET', url: 'https://api.example.com/x', auth: { connectionId: 'conn-4' } };
    const result = await execHttpRequest(step, {}, baseState(), 'dry_run');
    assert.strictEqual(result.dryRunSynthesised, true);
    assert.strictEqual(result.output._dryRun, true);
    assert.strictEqual(authState.calls.length, 0, 'no authorize/decrypt in dry-run');
    assert.strictEqual(safeFetchCalls.length, 0, 'no network call in dry-run');
});

test('dry-run: a GET WITHOUT auth still executes live (reads-live convention unchanged)', async () => {
    safeFetchCalls.length = 0;
    safeFetchImpl = async () => fakeResponse({ status: 200, body: 'live data' });
    const result = await execHttpRequest({ id: 'h1', type: 'http_request', url: 'https://api.example.com/x' }, {}, baseState(), 'dry_run');
    assert.strictEqual(safeFetchCalls.length, 1);
    assert.strictEqual(result.output.body, 'live data');
});

test('auth: a target-API 401 evicts the cached token (retry refetches) but still returns the response', async () => {
    authState.evicted.length = 0;
    authState.impl = async () => ({ headers: { Authorization: 'Bearer tok-stale' }, maskValues: ['tok-stale'], label: 'Cred', accessMode: 'own' });
    safeFetchImpl = async () => fakeResponse({ status: 401, body: 'unauthorized' });
    const result = await execHttpRequest({ id: 'h1', type: 'http_request', url: 'https://api.example.com/x', auth: { connectionId: 'conn-401' } }, {}, baseState(), 'live');
    assert.deepStrictEqual(authState.evicted, ['conn-401']);
    assert.strictEqual(result.output.status, 401, 'response is still surfaced, connection NOT flagged');
});

test('auth: a non-401 response does not evict', async () => {
    authState.evicted.length = 0;
    authState.impl = async () => ({ headers: { Authorization: 'Bearer tok-ok' }, maskValues: ['tok-ok'], label: 'Cred', accessMode: 'own' });
    safeFetchImpl = async () => fakeResponse({ status: 403, body: 'forbidden' });
    await execHttpRequest({ id: 'h1', type: 'http_request', url: 'https://api.example.com/x', auth: { connectionId: 'conn-403' } }, {}, baseState(), 'live');
    assert.deepStrictEqual(authState.evicted, []);
});

// ── output.data — the parsed body ─────────────────────────────────────────
//
// `body` is a string, always has been, and stays one: templates and refs all
// over the product already read it as text. But a string can never satisfy
// `arrayRef` or `repeat_for_each`, both of which demand a real array — so a
// JSON API was unusable as a LIST. `data` is the same body, parsed, added
// alongside.

const jsonList = '[{"summary":"one","state":"Open"},{"summary":"two","state":"Done"}]';

test('a JSON response gains `data` while `body` stays exactly the same string', async () => {
    safeFetchImpl = async () => fakeResponse({ status: 200, headers: { 'content-type': 'application/json' }, body: jsonList });
    const step = { id: 'h1', type: 'http_request', url: 'https://api.example.com/issues' };
    const { output } = await execHttpRequest(step, {}, baseState(), 'live');
    assert.strictEqual(output.body, jsonList, 'body must not change type or content');
    assert.ok(Array.isArray(output.data), 'data should be a real array');
    assert.strictEqual(output.data.length, 2);
    assert.strictEqual(output.data[0].summary, 'one');
});

test('a JSON content-type with parameters still parses', async () => {
    safeFetchImpl = async () => fakeResponse({ status: 200, headers: { 'content-type': 'application/vnd.api+json; charset=utf-8' }, body: '{"a":1}' });
    const { output } = await execHttpRequest({ id: 'h1', type: 'http_request', url: 'https://x.test/' }, {}, baseState(), 'live');
    assert.deepStrictEqual(output.data, { a: 1 });
});

test('a non-JSON response gains nothing — its output is what it always was', async () => {
    safeFetchImpl = async () => fakeResponse({ status: 200, headers: { 'content-type': 'text/csv' }, body: 'a,b\n1,2' });
    const { output } = await execHttpRequest({ id: 'h1', type: 'http_request', url: 'https://x.test/' }, {}, baseState(), 'live');
    assert.strictEqual(output.body, 'a,b\n1,2');
    assert.ok(!('data' in output), 'no data key for a non-JSON body');
});

test('a JSON content-type with a malformed body does not throw and adds no data', async () => {
    // Someone else's server returning nonsense must not stop the automation.
    safeFetchImpl = async () => fakeResponse({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"a":1' });
    const { output } = await execHttpRequest({ id: 'h1', type: 'http_request', url: 'https://x.test/' }, {}, baseState(), 'live');
    assert.strictEqual(output.body, '{"a":1');
    assert.ok(!('data' in output));
});

test('a BOM in front of the JSON is tolerated', async () => {
    safeFetchImpl = async () => fakeResponse({ status: 200, headers: { 'content-type': 'application/json' }, body: '\uFEFF{"a":1}' });
    const { output } = await execHttpRequest({ id: 'h1', type: 'http_request', url: 'https://x.test/' }, {}, baseState(), 'live');
    assert.deepStrictEqual(output.data, { a: 1 });
});

test('an empty JSON body adds no data', async () => {
    safeFetchImpl = async () => fakeResponse({ status: 204, headers: { 'content-type': 'application/json' }, body: '' });
    const { output } = await execHttpRequest({ id: 'h1', type: 'http_request', url: 'https://x.test/' }, {}, baseState(), 'live');
    assert.ok(!('data' in output));
});

test('a body over the cap throws BEFORE parsing is ever attempted — half a document is worse than the text', async () => {
    // BFSF-436: this used to assert `truncated:true` with no `data` key —
    // parseHttpBody's own "never parse a truncated body" rule. Now the step
    // never gets that far: it fails outright, so parseHttpBody is never even
    // called for a body over the cap.
    const huge = '[' + '{"x":1},'.repeat(200_000);
    safeFetchImpl = async () => fakeResponse({ status: 200, headers: { 'content-type': 'application/json' }, body: huge });
    await assert.rejects(
        () => execHttpRequest({ id: 'h1', type: 'http_request', url: 'https://x.test/' }, {}, baseState(), 'live'),
        /response body exceeded the 1 MiB limit/,
    );
});

test('parseResponse:never leaves a JSON response unparsed', async () => {
    safeFetchImpl = async () => fakeResponse({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
    const step = { id: 'h1', type: 'http_request', url: 'https://x.test/', parseResponse: 'never' };
    const { output } = await execHttpRequest(step, {}, baseState(), 'live');
    assert.ok(!('data' in output));
});

test('parseResponse:always parses a body the server mislabels', async () => {
    // Plenty of APIs answer JSON with text/plain; this is the escape hatch.
    safeFetchImpl = async () => fakeResponse({ status: 200, headers: { 'content-type': 'text/plain' }, body: '{"a":1}' });
    const step = { id: 'h1', type: 'http_request', url: 'https://x.test/', parseResponse: 'always' };
    const { output } = await execHttpRequest(step, {}, baseState(), 'live');
    assert.deepStrictEqual(output.data, { a: 1 });
});

test('parseResponse:always still does not throw on nonsense', async () => {
    safeFetchImpl = async () => fakeResponse({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'not json at all' });
    const step = { id: 'h1', type: 'http_request', url: 'https://x.test/', parseResponse: 'always' };
    const { output } = await execHttpRequest(step, {}, baseState(), 'live');
    assert.ok(!('data' in output));
});

test('an unknown parseResponse value falls back to auto rather than refusing', async () => {
    safeFetchImpl = async () => fakeResponse({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
    const step = { id: 'h1', type: 'http_request', url: 'https://x.test/', parseResponse: 'sometimes' };
    const { output } = await execHttpRequest(step, {}, baseState(), 'live');
    assert.deepStrictEqual(output.data, { a: 1 });
});

// ── "Ask this web service only once" — PLACEMENT ────────────────────────────
//
// The whole policy lives in httpCache.js and is matrix-tested there. What can
// only be tested HERE is where the two call sites sit in this function, which
// is the security property: the read is after the credential gate and after
// the guard, and the write is before the output guard.
//
// These use the RUN-MEMO tier only. It needs no store and no org policy, so a
// failure here is unambiguously about placement. The durable tier — its ledger
// row and its conditional revalidation — is in execOutbound.httpCache.test.js.

const { createToolMemo } = require('./toolMemo');

/** A memo that records every look-up, so "never consulted" is assertable. */
function spyMemo() {
    const memo = createToolMemo();
    const peeks = [];
    return {
        ...memo,
        peeks,
        peek: (k) => { peeks.push(k); return memo.peek(k); },
    };
}

const CACHE_CTX = () => ({ userId: 'u1', orgId: 'org-a', _toolMemo: spyMemo() });
const CACHED_STEP = {
    id: 'h1', type: 'http_request', method: 'GET',
    url: 'https://api.example.com/rates', askOnce: true,
};

test('placement: a revoked credential throws BEFORE the cache is ever consulted', async () => {
    // resolveHttpAuthHeaders is not a header renderer — it re-reads the
    // connection row and re-evaluates the grant join for revocation and expiry
    // on EVERY run. Hoisting the cache read above it would keep a revoked lend
    // flowing for a whole TTL with no ledger row and no refusal.
    safeFetchCalls.length = 0;
    const ctx = CACHE_CTX();
    authState.impl = async () => { throw new Error('http_request: the referenced HTTP credential is not available.'); };
    await assert.rejects(
        () => execHttpRequest({ ...CACHED_STEP, auth: { connectionId: 'conn-revoked' } }, ctx, baseState(), 'live'),
        /not available/,
    );
    assert.deepStrictEqual(ctx._toolMemo.peeks, [],
        'the cache must never be reached past a credential the runner just refused');
    assert.strictEqual(safeFetchCalls.length, 0);
});

test('a second identical call in one run does not dispatch again', async () => {
    safeFetchCalls.length = 0;
    safeFetchImpl = async () => fakeResponse({
        status: 200, headers: { 'content-type': 'application/json' }, body: '{"rate":1.09}',
    });
    const ctx = CACHE_CTX();
    const first = await execHttpRequest(CACHED_STEP, ctx, baseState(), 'live');
    const second = await execHttpRequest(CACHED_STEP, ctx, baseState(), 'live');
    assert.strictEqual(safeFetchCalls.length, 1, 'the second call must come from the memo');
    assert.strictEqual(second.reused, 'run');
    // The identical guard tail, so a hit and a live call are the same shape
    // downstream — including the parsed `data` a collection step binds to.
    assert.deepStrictEqual(second.output, first.output);
    assert.deepStrictEqual(second.output.data, { rate: 1.09 });
});

test('a hit re-derives data under THIS step parseResponse, not the one that stored it', async () => {
    // parseResponse is deliberately out of the key: the stored value is the
    // pre-parse response, so two steps sharing an answer each read it their way.
    safeFetchCalls.length = 0;
    safeFetchImpl = async () => fakeResponse({ status: 200, headers: { 'content-type': 'text/plain' }, body: '{"a":1}' });
    const ctx = CACHE_CTX();
    const loose = await execHttpRequest(CACHED_STEP, ctx, baseState(), 'live');
    assert.ok(!('data' in loose.output), 'auto must not parse a text/plain body');
    const strict = await execHttpRequest({ ...CACHED_STEP, parseResponse: 'always' }, ctx, baseState(), 'live');
    assert.strictEqual(safeFetchCalls.length, 1);
    assert.deepStrictEqual(strict.output.data, { a: 1 });
});

test('a step with blockPrivateTargets:false never caches at all', async () => {
    // A refusal, not a key component: no fetch happens on a hit, so the SSRF
    // guard's refusal never fires and re-enabling it would not undo the leak.
    safeFetchCalls.length = 0;
    let bareFetches = 0;
    const realFetch = global.fetch;
    global.fetch = async () => { bareFetches++; return fakeResponse({ status: 200, body: 'ok' }); };
    try {
        const ctx = CACHE_CTX();
        const step = { ...CACHED_STEP, blockPrivateTargets: false };
        await execHttpRequest(step, ctx, baseState(), 'live');
        await execHttpRequest(step, ctx, baseState(), 'live');
        assert.strictEqual(bareFetches, 2, 'both calls must be dispatched for real');
        assert.deepStrictEqual(ctx._toolMemo.peeks, [], 'it was never eligible, so it is not even a miss');
    } finally {
        global.fetch = realFetch;
    }
});

test('a write method DOES reuse now — the second POST is served from the memo', async () => {
    // The owner's call, taken 2026-09-02: a POST that only searches is the
    // common case, and refusing it refused the feature. The cost is stated in
    // httpCache.js and warned about by the validator — on a POST that CREATES
    // something, this second call silently not happening is the whole hazard.
    safeFetchCalls.length = 0;
    safeFetchImpl = async () => fakeResponse({ status: 200, body: 'results' });
    const ctx = CACHE_CTX();
    const step = { ...CACHED_STEP, method: 'POST', body: '{}' };
    await execHttpRequest(step, ctx, baseState(), 'live');
    await execHttpRequest(step, ctx, baseState(), 'live');
    assert.strictEqual(safeFetchCalls.length, 1, 'the second identical POST was served from the run memo');
});

test('two different POST bodies are two different calls', async () => {
    // The guard that makes the above safe for a search API.
    safeFetchCalls.length = 0;
    safeFetchImpl = async () => fakeResponse({ status: 200, body: 'results' });
    const ctx = CACHE_CTX();
    await execHttpRequest({ ...CACHED_STEP, method: 'POST', body: '{"q":"a"}' }, ctx, baseState(), 'live');
    await execHttpRequest({ ...CACHED_STEP, method: 'POST', body: '{"q":"b"}' }, ctx, baseState(), 'live');
    assert.strictEqual(safeFetchCalls.length, 2, 'a different body must not be served the first answer');
});

test('a dry run neither reuses nor stores', async () => {
    safeFetchCalls.length = 0;
    safeFetchImpl = async () => fakeResponse({ status: 200, body: 'preview' });
    const ctx = CACHE_CTX();
    await execHttpRequest(CACHED_STEP, ctx, baseState(), 'dry_run');
    await execHttpRequest(CACHED_STEP, ctx, baseState(), 'dry_run');
    assert.strictEqual(safeFetchCalls.length, 2, 'a preview must show what the service says now');
    assert.deepStrictEqual(ctx._toolMemo.peeks, []);
});

test('nothing is stored when the dispatch throws', async () => {
    safeFetchCalls.length = 0;
    safeFetchImpl = async () => { throw new Error('socket hang up'); };
    const ctx = CACHE_CTX();
    await assert.rejects(() => execHttpRequest(CACHED_STEP, ctx, baseState(), 'live'));
    safeFetchImpl = async () => fakeResponse({ status: 200, body: 'now it works' });
    const after = await execHttpRequest(CACHED_STEP, ctx, baseState(), 'live');
    assert.strictEqual(after.output.body, 'now it works', 'a transient failure must not become the answer');
    assert.strictEqual(safeFetchCalls.length, 2);
});

test('BFSF-436: a truncated response with askOnce set is never cached — the throw runs before httpCache.store', async () => {
    // The truncation check now sits before httpCache.store is even called, so
    // this is really the same guarantee as "nothing is stored when the
    // dispatch throws" above, for the one failure mode that used to reach
    // `store` and get refused there (httpCache.storability already excludes
    // `out.truncated`) instead of never reaching it at all.
    safeFetchCalls.length = 0;
    const big = 'x'.repeat(1024 * 1024 + 1);
    safeFetchImpl = async () => fakeResponse({ status: 200, body: big });
    const ctx = CACHE_CTX();
    await assert.rejects(
        () => execHttpRequest(CACHED_STEP, ctx, baseState(), 'live'),
        /response body exceeded the 1 MiB limit/,
    );
    safeFetchImpl = async () => fakeResponse({ status: 200, body: 'small now' });
    const after = await execHttpRequest(CACHED_STEP, ctx, baseState(), 'live');
    assert.strictEqual(after.output.body, 'small now', 'the failed oversized call must never have been cached');
    assert.strictEqual(safeFetchCalls.length, 2, 'the retry must dispatch for real, not reuse a truncated answer');
});

test('a failing status is dispatched again — a cached 401 would defeat the retry', async () => {
    safeFetchCalls.length = 0;
    let n = 0;
    safeFetchImpl = async () => (++n === 1
        ? fakeResponse({ status: 401, body: 'nope' })
        : fakeResponse({ status: 200, body: 'ok' }));
    const ctx = CACHE_CTX();
    await execHttpRequest(CACHED_STEP, ctx, baseState(), 'live');
    const second = await execHttpRequest(CACHED_STEP, ctx, baseState(), 'live');
    assert.strictEqual(safeFetchCalls.length, 2);
    assert.strictEqual(second.output.status, 200);
});

test('a response that sets a cookie is dispatched again — a stored session is replayable', async () => {
    safeFetchCalls.length = 0;
    safeFetchImpl = async () => fakeResponse({
        status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'sid=abc; HttpOnly' }, body: '{}',
    });
    const ctx = CACHE_CTX();
    await execHttpRequest(CACHED_STEP, ctx, baseState(), 'live');
    await execHttpRequest(CACHED_STEP, ctx, baseState(), 'live');
    assert.strictEqual(safeFetchCalls.length, 2);
});

test('two calls differing only in a template-resolved URL do not share an answer', async () => {
    safeFetchCalls.length = 0;
    safeFetchImpl = async (url) => fakeResponse({ status: 200, body: url });
    const ctx = CACHE_CTX();
    const step = { ...CACHED_STEP, url: 'https://api.example.com/rates/{{trigger.output.id}}' };
    const a = await execHttpRequest(step, ctx, baseState({ trigger: { output: { id: '1' } } }), 'live');
    const b = await execHttpRequest(step, ctx, baseState({ trigger: { output: { id: '2' } } }), 'live');
    assert.strictEqual(safeFetchCalls.length, 2);
    assert.notStrictEqual(a.output.body, b.output.body);
});
