'use strict';

/**
 * The tables a run produced: a page of rows and a CSV download.
 *
 * The router takes its store and table store injected, so this mounts the real
 * router on a real Express app and talks to it over HTTP. The table store is the
 * real one over a fake ledger and an in-memory storage, so the bytes in the
 * answers went through the real writer and reader.
 *
 * The cast, all in org1 unless said otherwise:
 *   owner     owns a1 and started every run
 *   vic       share on a1, view
 *   ron       share on a1, run-only (reads only the runs they started)
 *   stranger  same organisation, no share
 *   outsider  another organisation
 *
 * Run: cd server && node --test routes/automation/runTables.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { Readable } = require('node:stream');

const { serve } = require('../../testUtils/routeHarness');
const { makeRunTablesRouter } = require('./runTables');
const { makeTableStore } = require('../../core/automationRunner/tables/tableStore');
const { tableLimits } = require('../../core/automationRunner/tables/limits');

const USERS = {
    owner: { id: 'owner', organizationId: 'org1', groups: [] },
    vic: { id: 'vic', organizationId: 'org1', groups: [] },
    ron: { id: 'ron', organizationId: 'org1', groups: [] },
    stranger: { id: 'stranger', organizationId: 'org1', groups: [] },
    outsider: { id: 'outsider', organizationId: 'org2', groups: [] },
};
const AUTOMATIONS = {
    a1: { id: 'a1', userId: 'owner', organizationId: 'org1' },
    a2: { id: 'a2', userId: 'owner', organizationId: 'org1' },
    a3: { id: 'a3', userId: 'outsider', organizationId: 'org2' },
};
const SHARES = {
    a1: [
        { principalType: 'user', principalId: 'vic', role: 'view' },
        { principalType: 'user', principalId: 'ron', role: 'run' },
        { principalType: 'user', principalId: 'outsider', role: 'edit' },
    ],
};
const RUNS = {
    r1: { id: 'r1', automationId: 'a1', userId: 'owner', startedByUserId: 'owner', status: 'success' },
    r1b: { id: 'r1b', automationId: 'a1', userId: 'owner', startedByUserId: 'owner', status: 'success', rootRunId: 'r1' },
    rRon: { id: 'rRon', automationId: 'a1', userId: 'owner', startedByUserId: 'ron', status: 'success' },
    rCaller: { id: 'rCaller', automationId: 'a1', userId: 'owner', startedByUserId: 'ron', status: 'success', connectionsMode: 'caller' },
    r2: { id: 'r2', automationId: 'a2', userId: 'owner', startedByUserId: 'owner', status: 'success' },
    r3: { id: 'r3', automationId: 'a3', userId: 'outsider', startedByUserId: 'outsider', status: 'success' },
};
const CHAINS = { r1: ['r1', 'r1b'], r1b: ['r1', 'r1b'] };
const COLS = [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'score', label: 'Score', type: 'number' },
];
const named = (n) => Array.from({ length: n }, (_, i) => ({ name: `row ${i}`, score: i }));

let LEDGER;
let BLOBS;
let limits;
let T; // table ids by label

const fakeStore = {
    getRun: async (id) => (RUNS[id] ? { ...RUNS[id] } : null),
    getAutomation: async (id) => (AUTOMATIONS[id] ? { ...AUTOMATIONS[id] } : null),
    getRunsInChain: async (id) => (CHAINS[id] || [id]).map(x => ({ ...RUNS[x] })),
    listSharesForAutomation: async (id) => SHARES[id] || [],
    // Same contract as the real ledger: live rows only, scoped to the runs or the automation given.
    getRunTableForRuns: async (id, runIds) => LEDGER.find(t => t.id === id && runIds.includes(t.runId) && t.expiresAt > new Date()) || null,
    getRunTableForAutomation: async (id, automationId) => LEDGER.find(t => t.id === id && t.automationId === automationId && t.expiresAt > new Date()) || null,
    countRunTablesForRun: async (runId) => LEDGER.filter(t => t.runId === runId).length,
    recordRunTable: async (r) => { LEDGER.push({ ...r, createdAt: new Date(), expiresAt: new Date(Date.now() + r.ttlMs) }); },
};
const fakeStorage = {
    isAvailable: () => true,
    buildAutomationFileKey: (o, a, n) => `automation-forms/${o}/${a}/${n}`,
    uploadFileFromPath: async (key, path) => { BLOBS[key] = fs.readFileSync(path); },
    streamFile: async (key) => {
        if (!(key in BLOBS)) { const e = new Error('Object not found'); e.name = 'NoSuchKey'; throw e; }
        return { stream: Readable.from([BLOBS[key]]), contentLength: BLOBS[key].length };
    },
    deleteFile: async (key) => { delete BLOBS[key]; },
};
const tableStore = makeTableStore({
    store: fakeStore, storage: fakeStorage, limits: () => limits,
    journeyRunIds: async (s) => CHAINS[s.runId] || [s.runId],
});

async function put(label, runId, automationId, rows, name = 'Scores') {
    const h = await tableStore.writeTable({ ctx: { userId: 'owner', automationId, runId, rootRunId: runId }, name, columns: COLS, rows });
    T[label] = h.tableId;
}

let api;
before(() => {
    limits = tableLimits({});
    api = serve('/', makeRunTablesRouter({
        store: fakeStore,
        tableStore,
        limits: () => limits,
        getUser: async (id) => USERS[id] || null,
        hasPermission: async () => false,
    }));
});
after(async () => { await api.close(); });

beforeEach(async () => {
    limits = tableLimits({});
    LEDGER = []; BLOBS = {}; T = {};
    await put('t1', 'r1', 'a1', named(120));
    await put('t1b', 'r1b', 'a1', named(3), 'Second leg');
    await put('tRon', 'rRon', 'a1', named(2));
    await put('tCaller', 'rCaller', 'a1', named(2));
    await put('tA2', 'r2', 'a2', named(2));
    await put('tA3', 'r3', 'a3', named(2));
    await put('tOld', 'r1', 'a1', named(2));
    LEDGER.find(t => t.id === T.tOld).expiresAt = new Date('2020-01-01');
    await put('tGone', 'r1', 'a1', named(2));
    delete BLOBS[LEDGER.find(t => t.id === T.tGone).storageKey];
});

const get = (path, as = 'owner') => api.call('GET', path, { user: USERS[as] });

// ── a page ────────────────────────────────────────────────────────────

test('a page has the documented shape and nothing else', async () => {
    const res = await get(`/runs/r1/tables/${T.t1}`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(Object.keys(res.body).sort(), ['columns', 'expiresAt', 'hasMore', 'limit', 'name', 'offset', 'rowCount', 'rows', 'runId', 'tableId']);
    assert.strictEqual(res.body.tableId, T.t1);
    assert.strictEqual(res.body.name, 'Scores');
    assert.strictEqual(res.body.runId, 'r1');
    assert.deepStrictEqual(res.body.columns, COLS);
    assert.strictEqual(res.body.rowCount, 120);
    assert.strictEqual(res.body.offset, 0);
    assert.strictEqual(res.body.limit, 50);
    assert.strictEqual(res.body.rows.length, 50);
    assert.deepStrictEqual(res.body.rows[0], { name: 'row 0', score: 0 });
    assert.strictEqual(res.body.hasMore, true);
    assert.match(res.headers.get('cache-control'), /private, no-store/);
    assert.ok(!('storageKey' in res.body) && !('automationId' in res.body));
});

test('offset and limit move the window; the last page has no more', async () => {
    const res = await get(`/runs/r1/tables/${T.t1}?offset=100&limit=50`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.rows.length, 20);
    assert.strictEqual(res.body.rows[0].name, 'row 100');
    assert.strictEqual(res.body.hasMore, false);
});

test('the second leg\'s table opens through the first run', async () => {
    assert.strictEqual((await get(`/runs/r1/tables/${T.t1b}`)).status, 200);
    assert.strictEqual((await get(`/runs/r1b/tables/${T.t1}`)).status, 200);
});

test('a bad offset or limit is 400 invalid_page', async () => {
    for (const q of ['offset=-1', 'offset=abc', 'offset=1.5', 'limit=0', 'limit=abc', 'limit=501', 'limit=-3', 'limit=']) {
        const res = await get(`/runs/r1/tables/${T.t1}?${q}`);
        assert.strictEqual(res.status, 400, q);
        assert.strictEqual(res.body.code, 'invalid_page', q);
    }
});

test('the page size cap is configurable, and 0 lifts it', async () => {
    limits = { ...limits, pageMaxRows: 10 };
    assert.strictEqual((await get(`/runs/r1/tables/${T.t1}?limit=11`)).status, 400);
    assert.strictEqual((await get(`/runs/r1/tables/${T.t1}?limit=10`)).body.rows.length, 10);
    limits = { ...limits, pageMaxRows: 0 };
    assert.strictEqual((await get(`/runs/r1/tables/${T.t1}?limit=100`)).body.rows.length, 100);
});

// ── access ────────────────────────────────────────────────────────────

test('an unknown id, a malformed id, an expired row and a row without bytes are all 404', async () => {
    for (const id of [`rtb_${'0'.repeat(32)}`, 'nope', T.tOld, T.tGone]) {
        const res = await get(`/runs/r1/tables/${id}`);
        assert.strictEqual(res.status, 404, id);
        assert.strictEqual(res.body.code, 'run_table_not_found', id);
    }
});

test('a table id never crosses runs, automations or organisations', async () => {
    assert.strictEqual((await get(`/runs/r1/tables/${T.tA2}`)).status, 404);
    assert.strictEqual((await get(`/runs/r1/tables/${T.tA3}`)).status, 404);
    assert.strictEqual((await get(`/runs/r2/tables/${T.t1}`)).status, 404);
    assert.strictEqual((await get(`/runs/r1/tables/${T.tRon}`)).status, 404);
    assert.strictEqual((await get(`/runs/r3/tables/${T.tA3}`)).status, 404);
});

test('a caller with no role on the automation gets a 404; a run that does not exist too', async () => {
    for (const who of ['stranger', 'outsider']) {
        assert.strictEqual((await get(`/runs/r1/tables/${T.t1}`, who)).status, 404, who);
        assert.strictEqual((await get(`/runs/r1/tables/${T.t1}/csv`, who)).status, 404, who);
    }
    assert.strictEqual((await get(`/runs/nope/tables/${T.t1}`)).status, 404);
});

test('a viewer reads; a run-only caller reads only the runs they started', async () => {
    assert.strictEqual((await get(`/runs/r1/tables/${T.t1}`, 'vic')).status, 200);
    const denied = await get(`/runs/r1/tables/${T.t1}`, 'ron');
    assert.strictEqual(denied.status, 403);
    assert.strictEqual(denied.body.code, 'automation_forbidden');
    assert.strictEqual((await get(`/runs/rRon/tables/${T.tRon}`, 'ron')).status, 200);
});

test('a run on the starter\'s own connections keeps its tables from everybody else', async () => {
    const other = await get(`/runs/rCaller/tables/${T.tCaller}`, 'owner');
    assert.strictEqual(other.status, 403);
    assert.strictEqual(other.body.code, 'caller_run_private');
    assert.strictEqual((await get(`/runs/rCaller/tables/${T.tCaller}/csv`, 'owner')).status, 403);
    assert.strictEqual((await get(`/runs/rCaller/tables/${T.tCaller}`, 'ron')).status, 200);
});

test('without a session the answer is not a table', async () => {
    const res = await api.call('GET', `/runs/r1/tables/${T.t1}`, { user: null });
    assert.ok(res.status >= 400 && res.status < 500 || res.status === 500);
    assert.ok(!res.text.includes('row 0'));
});

// ── csv ───────────────────────────────────────────────────────────────

test('the CSV is an attachment, nosniff, no-store, with a header and every row', async () => {
    const res = await get(`/runs/r1/tables/${T.t1}/csv`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.match(res.headers.get('content-disposition'), /^attachment; filename="Scores\.csv"/);
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('cache-control'), /no-store/);
    // fetch drops a leading BOM when it decodes text; tableStore.test.js checks the bytes.
    assert.ok(res.text.replace(/^\uFEFF/, '').startsWith('Name,Score\r\n'));
    assert.strictEqual(res.text.trim().split('\r\n').length, 121);
});

test('the CSV name cannot break out of the header', async () => {
    await put('tEvil', 'r1', 'a1', named(1), 'a"; x=1\r\nSet-Cookie: s=1/../');
    const res = await get(`/runs/r1/tables/${T.tEvil}/csv`);
    assert.strictEqual(res.status, 200);
    const cd = res.headers.get('content-disposition');
    assert.ok(!/[\r\n]/.test(cd));
    assert.match(cd, /^attachment; filename="[^"]*\.csv"; filename\*=UTF-8''/);
    assert.strictEqual(res.headers.get('set-cookie'), null);
});

test('a formula-shaped cell in the CSV is neutralised', async () => {
    await put('tF', 'r1', 'a1', [{ name: '=cmd()', score: -1 }]);
    const res = await get(`/runs/r1/tables/${T.tF}/csv`);
    assert.ok(res.text.includes("'=cmd(),-1"));
});

test('the CSV of a missing blob is a clean 404 with no CSV headers', async () => {
    const res = await get(`/runs/r1/tables/${T.tGone}/csv`);
    assert.strictEqual(res.status, 404);
    assert.match(res.headers.get('content-type'), /json/);
    assert.strictEqual(res.headers.get('content-disposition'), null);
});

test('the CSV download is rate limited per user, and 0 turns the limit off', async () => {
    limits = { ...limits, csvRpm: 2 };
    const url = `/runs/r1/tables/${T.t1b}/csv`;
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await get(url, 'vic')).status);
    assert.deepStrictEqual(statuses, [200, 200, 429, 429]);
    // Another user has their own budget.
    assert.strictEqual((await get(url, 'owner')).status, 200);
    limits = { ...limits, csvRpm: 0 };
    for (let i = 0; i < 5; i++) assert.strictEqual((await get(url, 'vic')).status, 200);
});
