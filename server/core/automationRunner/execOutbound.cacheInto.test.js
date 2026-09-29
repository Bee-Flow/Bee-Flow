/**
 * `step.cacheInto` — "remember answers in a table", through the real
 * execHttpRequest, the real httpCache, the real datatableResolve, the real
 * access filter and the real query compiler.
 *
 * The datatable STORES are faked; everything that decides anything is not. The
 * fake engine below applies the compiled `INSERT … ON CONFLICT` by reading the
 * statement's own column list and its own DO UPDATE SET clause, so what these
 * tests exercise is the SQL the compiler actually emits rather than a
 * remembered description of it.
 *
 * Five properties, and each is a promise the plan makes:
 *
 *   IT IS ONE ROW. Ten runs of the same call leave exactly one row, refreshed
 *   in place. This is the duplicate class ws4 removed from save_row, and the
 *   reason a MANAGED table declares its key column unique: `execDatatable`
 *   cannot assume that of an author's table, so it probes; here the upsert is
 *   real and a racer between probe and write cannot produce a second row.
 *
 *   IT NEVER WRITES A SECRET DOWN. execOutbound interpolates `step.url` against
 *   RAW runState, so `{{secrets.api_key}}` resolves INTO it. These are
 *   plaintext, org-readable, CSV-exportable columns, so the query string is
 *   dropped and a secret found anywhere in what would be written refuses the
 *   whole row.
 *
 *   IT STORES THE POST-GUARD VALUE. The raw pre-guard body is exactly what the
 *   Privacy Shield exists to tokenise before colleagues see it, and a table
 *   with a month-long window and an export button is the definition of
 *   "colleagues see it".
 *
 *   IT REFUSES THE SAME THINGS askOnce REFUSES. A 500, a truncated body, a
 *   `no-store`, a response carrying `set-cookie` — same matrix, one
 *   implementation.
 *
 *   AUTHORISATION IS NOT A CACHE FAILURE. Every other failure here degrades to
 *   a miss. Being told you may not write to the table the author named is a
 *   configuration error, and it fails the step with the datatable error class
 *   the on_error branch already matches — not an http one.
 *
 * Run: node --test --test-force-exit core/automationRunner/execOutbound.cacheInto.test.js
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
// Two module-load side effects a unit test has no business carrying, and that
// BOTH abort libuv on teardown under --test-force-exit — reported as a
// file-level failure with every subtest green.
mock('../../auth/decryptAudit', { trackDecrypt: () => {}, getDecryptStats: () => null });
mock('../llm/pricingService', { ...require('../llm/pricingService'), initPricing: () => {} });
mock('../../stores/configStore', { async getConfig() { return null; }, async setConfig() { return true; } });
mock('./httpAuth', {
    MASK_VALUES: Symbol.for('beeflow.automation.maskValues'),
    resolveHttpAuthHeaders: async () => { throw new Error('not used here'); },
    evictToken: () => {},
});

// ── The guard tail, stubbed so the POST-guard value is observable ───────────
//
// `guardToolOutput` is the whole point of one of these tests: what lands in the
// row must be what the shield produced, never the raw body. A transform the
// test controls is the only way to tell those two apart from out here.
const egressRows = [];
let guardOutputTransform = (v) => v;
mock('./safety', {
    resolveAutomationPolicy: async () => ({ action: 'off', privacyScope: 'external', scope: {} }),
    buildAuditBase: () => ({}),
    guardToolInput: async (value) => ({ value }),
    prepareForEgress: (value) => value,
    guardToolOutput: async (result) => ({ result: guardOutputTransform(result) }),
    restoreForRunState: (value) => value,
    egressMode: () => 'real',
    logEgress: async (row) => { egressRows.push(row); },
});

const safeFetchCalls = [];
let safeFetchImpl = null;
mock('../../utils/ssrfGuard', {
    safeFetch: async (url, opts) => { safeFetchCalls.push({ url, opts }); return safeFetchImpl(url, opts); },
    isPrivateAddressError: () => false,
});

// ── The datatable stores, faked ─────────────────────────────────────────────

const ORG = 'org-a';
const OWNER = 'u1';
const TABLE_ID = 'tbl_answers';
const TABLE_KEY = 'http_answers';

const { normalizeFields } = require('../dataEngine/dataModel/datatableFields');
const { managedKindSpec } = require('../dataEngine/dataModel/managedTables');
const MANAGED = managedKindSpec('http_cache');
const NORM = normalizeFields(MANAGED.fields, []);
assert.ok(NORM.ok, NORM.error);

const TABLE_META = { id: TABLE_ID, key: TABLE_KEY, name: 'Answers', fields: NORM.fields };

/** The rows the fake engine holds, keyed by cache_key. */
const rows = new Map();
const dbCalls = { query: 0, exec: 0, bump: [] };

let table = null;
function resetTable(over = {}) {
    table = {
        id: TABLE_ID, key: TABLE_KEY, name: 'Answers',
        scope: { kind: 'org', id: ORG }, scopeKind: 'org',
        organizationId: ORG, ownerUserId: OWNER,
        managedKind: 'http_cache', rowCount: rows.size, rowScope: 'all',
        retentionDays: 30, retentionField: 'fetched_at',
        scope_kind: 'org', scope_id: ORG, organization_id: ORG, owner_user_id: OWNER,
        is_published: false, shared_groups: [], write_mode: 'grants', row_scope: 'all',
        ...over,
    };
}
resetTable();

let scopeUsage = { tables: 1, rows: 0, bytes: 0 };

mock('../../stores/datatableStore', {
    orgScope: (id) => ({ kind: 'org', id }),
    userScope: (id) => ({ kind: 'user', id }),
    getDatatable: async (id, scope) => (
        (id === TABLE_ID && scope.kind === 'org' && scope.id === ORG) ? table : null
    ),
    listGrants: async () => [],
    getTableMeta: async () => TABLE_META,
    bumpAfterWrite: async (id, scope, delta) => { dbCalls.bump.push(delta); table.rowCount += delta; },
    scopeUsage: async () => scopeUsage,
});

/**
 * The compiled statement, applied. Deliberately reads the INSERT's own column
 * list and its own `DO UPDATE SET` clause rather than a hard-coded idea of
 * them, so a compiler change that stopped refreshing a column would fail here
 * instead of being mirrored by the fake.
 */
function applyUpsert(sql, params) {
    const cols = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')'))
        .split(',').map(c => c.trim().replace(/"/g, ''));
    const incoming = {};
    cols.forEach((c, i) => { incoming[c] = params[i]; });
    const setClause = sql.slice(sql.indexOf('DO UPDATE SET ') + 'DO UPDATE SET '.length, sql.lastIndexOf(' WHERE '));
    const updated = setClause.split(',').map(part => part.trim().split('=')[0].trim().replace(/"/g, ''));

    const existing = rows.get(incoming.cache_key);
    if (existing) {
        for (const c of updated) existing[c] = incoming[c];
        return { changes: 1 };
    }
    rows.set(incoming.cache_key, incoming);
    return { changes: 1 };
}

const HEX64 = /^[0-9a-f]{64}$/;

mock('../../stores/datatableDbStore', {
    scopeKey: (scope) => `${scope.kind}:${scope.id}`,
    query: async (_a, _b, sql, params) => {
        dbCalls.query++;
        const key = (params || []).find(p => typeof p === 'string' && HEX64.test(p));
        const row = key ? rows.get(key) : null;
        // compileKeyIndex is the (key → id) probe; it selects `AS "k"`.
        if (sql.includes('AS "k"')) return { rows: row ? [{ id: row.id, k: key }] : [] };
        return { rows: row ? [row] : [] };
    },
    exec: async (_a, _b, sql, params) => {
        dbCalls.exec++;
        assert.ok(sql.includes('ON CONFLICT ("cache_key") DO UPDATE'),
            'the visible tier writes ONE upsert, never an insert-and-hope');
        assert.ok(sql.includes(' WHERE '), 'the DO UPDATE half must stay access-scoped');
        return applyUpsert(sql, params);
    },
    invalidate: () => {},
});

const { execHttpRequest } = require('../automationRunner');
const { createToolMemo } = require('./toolMemo');

// ── Harness ─────────────────────────────────────────────────────────────────

function fakeResponse({ status = 200, headers = {}, body = '' }) {
    return {
        status, ok: status >= 200 && status < 300,
        headers: new Map(Object.entries(headers)), text: async () => body,
    };
}
function baseState(over = {}) {
    return { trigger: { output: {} }, steps: {}, vars: {}, secrets: {}, loop: {}, _templateWarnings: [], ...over };
}
function ctx(over = {}) {
    return { userId: OWNER, orgId: ORG, _toolMemo: createToolMemo(), ...over };
}
const STEP = {
    id: 'h1', type: 'http_request', method: 'GET',
    url: 'https://api.example.com/rates',
    cacheInto: { datatableId: TABLE_ID, maxAgeDays: 30 },
};

function reset() {
    safeFetchCalls.length = 0;
    egressRows.length = 0;
    rows.clear();
    dbCalls.query = 0; dbCalls.exec = 0; dbCalls.bump.length = 0;
    scopeUsage = { tables: 1, rows: 0, bytes: 0 };
    guardOutputTransform = (v) => v;
    resetTable();
    safeFetchImpl = async () => fakeResponse({
        status: 200, headers: { 'content-type': 'application/json' }, body: '{"rate":1.09}',
    });
}

const settle = () => new Promise(r => setImmediate(r));
afterEach(async () => { await settle(); });

const onlyRow = () => [...rows.values()][0];

// ── It serves, and it is one row ────────────────────────────────────────────

test('a second identical GET in a LATER run reads the row and issues no fetch', async () => {
    reset();
    const first = await execHttpRequest(STEP, ctx(), baseState(), 'live');
    assert.deepStrictEqual(first.output.data, { rate: 1.09 });
    assert.strictEqual(safeFetchCalls.length, 1);
    assert.strictEqual(rows.size, 1);
    assert.deepStrictEqual(first.cacheInto, { stored: true, refreshed: false });

    // A fresh ctx: the run memo is empty, so the answer can only come from the
    // table.
    const second = await execHttpRequest(STEP, ctx(), baseState(), 'live');
    assert.strictEqual(second.reused, 'table');
    assert.strictEqual(safeFetchCalls.length, 1, 'no bytes crossed the boundary on the second run');
    assert.strictEqual(second.output.body, '{"rate":1.09}');
    assert.deepStrictEqual(second.output.data, { rate: 1.09 }, '`data` is re-derived, never stored');
    assert.strictEqual(second.output.status, 200);
    assert.strictEqual(second.output.ok, true);
});

test('ten runs leave exactly ONE row, refreshed in place', async () => {
    reset();
    for (let i = 0; i < 10; i++) {
        // Age the row out every time, so every run takes the WRITE path — which
        // is the path that could produce a duplicate.
        const row = onlyRow();
        if (row) row.fetched_at = new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString();
        await execHttpRequest(STEP, ctx(), baseState(), 'live');
    }
    assert.strictEqual(rows.size, 1, 'the upsert refreshes; it never appends');
    assert.strictEqual(safeFetchCalls.length, 10);
    // row_count moved once, for the one row that was actually added.
    assert.deepStrictEqual(dbCalls.bump, [1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.strictEqual(table.rowCount, 1);
});

test('a row older than maxAgeDays is ignored and refreshed', async () => {
    reset();
    await execHttpRequest(STEP, ctx(), baseState(), 'live');
    const row = onlyRow();
    row.fetched_at = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString();
    row.response_body = '{"rate":0.01}';

    safeFetchImpl = async () => fakeResponse({
        status: 200, headers: { 'content-type': 'application/json' }, body: '{"rate":1.22}',
    });
    const result = await execHttpRequest(STEP, ctx(), baseState(), 'live');
    assert.strictEqual(safeFetchCalls.length, 2, 'past the window it asks again');
    assert.deepStrictEqual(result.output.data, { rate: 1.22 });
    assert.strictEqual(rows.size, 1);
    assert.strictEqual(onlyRow().response_body, '{"rate":1.22}');
});

test('a shorter maxAgeDays on the step narrows the window without touching the table', async () => {
    reset();
    await execHttpRequest(STEP, ctx(), baseState(), 'live');
    onlyRow().fetched_at = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();

    const narrow = { ...STEP, cacheInto: { datatableId: TABLE_ID, maxAgeDays: 1 } };
    await execHttpRequest(narrow, ctx(), baseState(), 'live');
    assert.strictEqual(safeFetchCalls.length, 2, 'three days old is outside a one-day window');
});

// ── The ledger ──────────────────────────────────────────────────────────────

test('a table hit writes exactly one ledger row, flagged served_from_cache', async () => {
    reset();
    await execHttpRequest(STEP, ctx(), baseState(), 'live');
    assert.strictEqual(egressRows.length, 1);
    assert.strictEqual(!!egressRows[0].servedFromCache, false, 'the live call is a real transfer');

    await execHttpRequest(STEP, ctx(), baseState(), 'live');
    assert.strictEqual(egressRows.length, 2,
        'a month-long window must not erase the processor from the Art-30 register');
    assert.strictEqual(egressRows[1].servedFromCache, true,
        'no bytes crossed the boundary, so the Art-44 transfer count excludes it');
});

test('a RUN-MEMO hit writes no ledger row at all', async () => {
    reset();
    const c = ctx();
    await execHttpRequest(STEP, c, baseState(), 'live');
    const before = egressRows.length;
    const second = await execHttpRequest(STEP, c, baseState(), 'live');
    assert.strictEqual(second.reused, 'run');
    assert.strictEqual(egressRows.length, before,
        'the first call in this run already logged the transfer');
});

// ── What is never written down ──────────────────────────────────────────────

test('request_path never carries a query string, and a {{secrets.*}} URL never reaches a column', async () => {
    reset();
    await execHttpRequest(
        { ...STEP, url: 'https://api.example.com/v3/rates?key={{secrets.api_key}}&q=seo' },
        ctx(),
        baseState({ secrets: { api_key: 'sk-live-do-not-write-me-down' } }),
        'live',
    );
    const row = onlyRow();
    assert.strictEqual(row.request_host, 'https://api.example.com');
    assert.strictEqual(row.request_path, '/v3/rates');
    assert.ok(!row.request_path.includes('?'), 'the query is where an API key lives');
    assert.ok(!JSON.stringify(row).includes('sk-live'),
        'not one column may carry the resolved credential');
    assert.ok(!JSON.stringify(row).includes('q=seo'),
        'the query string is represented only inside the hashed key');
});

test('a secret in a PATH segment refuses the whole row rather than writing it', async () => {
    reset();
    const result = await execHttpRequest(
        { ...STEP, url: 'https://api.example.com/v3/{{secrets.api_key}}/rates' },
        ctx(),
        baseState({ secrets: { api_key: 'sk-live-in-the-path' } }),
        'live',
    );
    assert.strictEqual(rows.size, 0);
    assert.strictEqual(result.cacheInto.stored, false);
    assert.strictEqual(result.cacheInto.reason, 'secret_in_answer');
    // The call itself still succeeded — a refusal to remember is never a failed
    // step.
    assert.deepStrictEqual(result.output.data, { rate: 1.09 });
});

test('a service that echoes a secret back is not written down either', async () => {
    reset();
    safeFetchImpl = async () => fakeResponse({
        status: 200, headers: { 'content-type': 'application/json' },
        body: '{"echo":"sk-live-echoed-back"}',
    });
    const result = await execHttpRequest(
        STEP, ctx(), baseState({ secrets: { api_key: 'sk-live-echoed-back' } }), 'live',
    );
    assert.strictEqual(rows.size, 0);
    assert.strictEqual(result.cacheInto.reason, 'secret_in_answer');
});

test('the stored body is the POST-guard value, never the raw one', async () => {
    reset();
    // Stands in for the shield tokenising a person out of a third-party answer.
    guardOutputTransform = (r) => ({ ...r, body: String(r.body).replace('Ada Lovelace', '[person]') });
    safeFetchImpl = async () => fakeResponse({
        status: 200, headers: { 'content-type': 'application/json' },
        body: '{"owner":"Ada Lovelace"}',
    });
    await execHttpRequest(STEP, ctx(), baseState(), 'live');
    const row = onlyRow();
    assert.ok(!row.response_body.includes('Ada Lovelace'),
        'the raw pre-guard body is exactly what the shield exists to tokenise before colleagues see it');
    assert.strictEqual(row.response_body, '{"owner":"[person]"}');
});

// ── The refusal matrix, inherited verbatim ──────────────────────────────────

for (const [name, resp] of [
    ['a 500', { status: 500, headers: {}, body: 'boom' }],
    ['a 401', { status: 401, headers: {}, body: 'no' }],
    ['a no-store response', { status: 200, headers: { 'cache-control': 'no-store' }, body: '{}' }],
    ['a private response', { status: 200, headers: { 'cache-control': 'private' }, body: '{}' }],
    ['one carrying set-cookie', { status: 200, headers: { 'set-cookie': 'sid=1' }, body: '{}' }],
    ['one carrying www-authenticate', { status: 200, headers: { 'www-authenticate': 'Basic' }, body: '{}' }],
    ['Vary: *', { status: 200, headers: { vary: '*' }, body: '{}' }],
]) {
    test(`nothing is written for ${name}`, async () => {
        reset();
        safeFetchImpl = async () => fakeResponse(resp);
        const result = await execHttpRequest(STEP, ctx(), baseState(), 'live');
        assert.strictEqual(rows.size, 0, `${name} must not become a stored answer`);
        assert.strictEqual(result.cacheInto.stored, false);
        assert.strictEqual(result.cacheInto.reason, 'not_cacheable');
    });
}

test('nothing is written for a body over the 1 MiB ceiling — refused, never truncated', async () => {
    reset();
    // Past execOutbound's own cap the step throws before the cache is reached,
    // so the case worth proving is the one the GUARD can create: a shield that
    // expands the body past the ceiling on its way through.
    guardOutputTransform = (r) => ({ ...r, body: 'x'.repeat(1024 * 1024 + 1) });
    const result = await execHttpRequest(STEP, ctx(), baseState(), 'live');
    assert.strictEqual(rows.size, 0);
    assert.strictEqual(result.cacheInto.reason, 'too_large');
});

test('a write METHOD reaches the table like any other', async () => {
    // Was a refusal. The method stopped deciding when POST-as-look-up was
    // allowed in; what remains is the author's judgement plus a validator
    // warning. Everything else about storability is unchanged — 2xx only, not
    // truncated, no credential headers.
    reset();
    const result = await execHttpRequest(
        { ...STEP, method: 'POST', body: '{}' }, ctx(), baseState(), 'live',
    );
    assert.strictEqual(rows.size, 1, 'the answer to a POST look-up is remembered');
    assert.ok(result.cacheInto);
});

test('nothing is remembered while private targets are allowed', async () => {
    reset();
    // With the guard off the step uses the BARE fetch, not safeFetch — which is
    // the whole reason this is a refusal: an answer fetched that way came from
    // a target nobody screened.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => fakeResponse({
        status: 200, headers: { 'content-type': 'application/json' }, body: '{"rate":1.09}',
    });
    try {
        const result = await execHttpRequest(
            { ...STEP, blockPrivateTargets: false }, ctx(), baseState(), 'live',
        );
        assert.deepStrictEqual(result.output.data, { rate: 1.09 });
        assert.strictEqual(rows.size, 0);
        assert.strictEqual(result.cacheInto, undefined);
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('a dry run neither reads the table nor writes to it', async () => {
    reset();
    rows.set('seeded', {});
    const before = dbCalls.query;
    await execHttpRequest(STEP, ctx(), baseState(), 'dry_run');
    assert.strictEqual(dbCalls.query, before, 'a preview must not consult the table');
    assert.strictEqual(dbCalls.exec, 0, 'and must never leave a row behind');
});

// ── Authorisation is not a cache failure ────────────────────────────────────

test('an author with only VIEWER grade fails the step with the datatable error class', async () => {
    reset();
    // Published to the organisation, owned by somebody else: readable, not
    // writable. A step that could serve from the table but never refill it
    // would look like it worked while re-asking the paid API for ever.
    resetTable({ owner_user_id: 'someone-else', ownerUserId: 'someone-else', is_published: true });
    let thrown = null;
    try {
        await execHttpRequest(STEP, ctx({ userId: 'u2', orgRole: 'member' }), baseState(), 'live');
    } catch (e) { thrown = e; }
    assert.ok(thrown, 'this must fail rather than quietly do nothing');
    assert.strictEqual(thrown.errorClass, 'datatable_forbidden');
    assert.ok(!/http_request/.test(thrown.message), 'it is a datatable problem, not an HTTP one');
    assert.strictEqual(safeFetchCalls.length, 0, 'and it refuses BEFORE the call is made');
});

test('a table in another tenant is not found, and the step says so', async () => {
    reset();
    let thrown = null;
    try {
        await execHttpRequest(STEP, ctx({ orgId: 'org-b' }), baseState(), 'live');
    } catch (e) { thrown = e; }
    assert.ok(thrown);
    assert.strictEqual(thrown.errorClass, 'datatable_not_found');
});

// ── The storage envelope ────────────────────────────────────────────────────

test('a full table refuses the row and lets the run carry on', async () => {
    reset();
    // Over MAX_ROWS_PER_TABLE. The step must not fail: the answer is in hand,
    // and the only consequence of not remembering it is asking again.
    resetTable({ rowCount: 100_000 });
    const result = await execHttpRequest(STEP, ctx(), baseState(), 'live');
    assert.deepStrictEqual(result.output.data, { rate: 1.09 });
    assert.strictEqual(rows.size, 0);
    assert.strictEqual(result.cacheInto.stored, false);
    assert.strictEqual(result.cacheInto.reason, 'quota');
});

test('a REFRESH of an existing row is not stopped by the row cap', async () => {
    reset();
    await execHttpRequest(STEP, ctx(), baseState(), 'live');
    onlyRow().fetched_at = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
    // The table is now full — but this write adds no row, so refusing it would
    // freeze every answer in the table at whatever it last held.
    resetTable({ rowCount: 100_000 });
    safeFetchImpl = async () => fakeResponse({
        status: 200, headers: { 'content-type': 'application/json' }, body: '{"rate":9.99}',
    });
    const result = await execHttpRequest(STEP, ctx(), baseState(), 'live');
    assert.deepStrictEqual(result.cacheInto, { stored: true, refreshed: true });
    assert.strictEqual(onlyRow().response_body, '{"rate":9.99}');
});

// ── The key ─────────────────────────────────────────────────────────────────

test('two calls that differ only in a query parameter do not share a row', async () => {
    reset();
    await execHttpRequest({ ...STEP, url: 'https://api.example.com/rates?q=a' }, ctx(), baseState(), 'live');
    await execHttpRequest({ ...STEP, url: 'https://api.example.com/rates?q=b' }, ctx(), baseState(), 'live');
    assert.strictEqual(rows.size, 2, 'the query lives in the key even though it is not in a column');
    assert.strictEqual(safeFetchCalls.length, 2);
    for (const row of rows.values()) assert.strictEqual(row.request_path, '/rates');
});

test('the cache key is a plain sha256 of the identity, not the store HMAC', async () => {
    reset();
    await execHttpRequest(STEP, ctx(), baseState(), 'live');
    const { memoKeyParts, memoKeyFromParts } = require('./toolMemo');
    const expected = memoKeyFromParts(memoKeyParts({
        toolName: 'http_request',
        stepUserId: OWNER,
        stepOrgId: ORG,
        connectionId: null,
        grantId: null,
        integrationServer: 'https://api.example.com',
        destination: 'external',
        policyAction: 'off',
        policyScope: 'external',
        args: { method: 'GET', url: STEP.url, headers: {}, body: null },
    }));
    assert.strictEqual(onlyRow().cache_key, expected,
        'the row belongs to the org that can already read request_host beside it — obscuring the key from its owner would only make the table useless');
});
