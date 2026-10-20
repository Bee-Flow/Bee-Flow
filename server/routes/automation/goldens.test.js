/**
 * Golden runs: mark, unmark, list and replay, with fakes for the stores, the
 * run door and the replayer.
 *
 * The cast, all on automation a1: owner, ed (edit), vic (view).
 *
 * Run: cd server && node --test routes/automation/goldens.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { serve } = require('../../testUtils/routeHarness');
const { HttpError } = require('../../core/http/errors');
const { accessByRole } = require('./testing/accessByRole');
const { makeGoldensRouter } = require('./goldens');

const USERS = {
    owner: { id: 'owner', organizationId: 'org1' },
    ed: { id: 'ed', organizationId: 'org1' },
    vic: { id: 'vic', organizationId: 'org1' },
};
const T = '2026-10-01T10:00:00.000Z';
const NOW = () => new Date().toISOString();
const A1 = { id: 'a1', userId: 'owner', organizationId: 'org1' };

let RUNS;
let LATEST;
let goldens;
let replays;
let door;
let rejectCapture;
let blockPrd;

const fakeStore = {
    getAutomation: async (id) => (id === 'a1' ? { ...A1 } : null),
    getRun: async (id) => (RUNS[id] ? { ...RUNS[id] } : null),
    getLatestRunInChain: async (id) => (LATEST[id] || RUNS[id] || null),
};
const fakeTesting = {
    listGoldens: async (aid) => goldens.filter(g => g.automationId === aid),
    countGoldens: async (aid) => goldens.filter(g => g.automationId === aid).length,
    getGoldenByRun: async (runId) => goldens.find(g => g.runId === runId) || null,
    createGolden: async ({ automationId, runId, label, ignorePaths, createdBy }) => {
        let g = goldens.find(x => x.runId === runId);
        if (g) { g.label = label; g.ignorePaths = ignorePaths; return g; }
        g = { id: `gold_${goldens.length + 1}`, automationId, runId, label, ignorePaths, createdBy, createdAt: T, lastReplay: null };
        goldens.push(g);
        return g;
    },
    deleteGoldenByRun: async (runId) => {
        const i = goldens.findIndex(g => g.runId === runId);
        if (i < 0) return false;
        goldens.splice(i, 1);
        return true;
    },
    setGoldenReplay: async (id, { status, summary, replayRunId, errorCode }) => {
        const g = goldens.find(x => x.id === id);
        g.lastReplay = { status, summary, errorCode, replayRunId, at: NOW() };
    },
};

let api;
before(() => {
    door = {
        async readableRun(_req, _res, runId) {
            const run = RUNS[runId];
            if (!run) throw new HttpError(404, 'run_not_found', 'Not found');
            const root = RUNS[run.rootRunId || run.id];
            return { run, root, legs: [root, ...(run.id !== root.id ? [run] : [])], runIds: [root.id, run.id] };
        },
        async assertCapturable() { if (rejectCapture) throw new HttpError(409, rejectCapture, 'no'); },
        async assertTestDataAllowed() { if (blockPrd) throw new HttpError(409, 'test_data_not_on_prd', 'no'); },
    };
    api = serve('/', makeGoldensRouter({
        store: fakeStore,
        testingStore: fakeTesting,
        access: accessByRole({ owner: 'owner', ed: 'edit', vic: 'view' }),
        runDataAccess: door,
        replayGoldens: async (input) => { replays.push(input); return []; },
        defer: (fn) => fn(),
        limiter: (_req, _res, next) => next(),
    }));
});
after(async () => { await api.close(); });

beforeEach(() => {
    RUNS = {
        r1: { id: 'r1', automationId: 'a1', userId: 'owner', status: 'success', mode: 'live', version: 3, triggerKind: 'manual', startedAt: T, rootRunId: 'r1' },
        r1b: { id: 'r1b', automationId: 'a1', userId: 'owner', status: 'success', mode: 'live', version: 3, triggerKind: 'manual', startedAt: T, rootRunId: 'r1' },
        rErr: { id: 'rErr', automationId: 'a1', userId: 'owner', status: 'error', mode: 'live', version: 3, triggerKind: 'manual', startedAt: T, rootRunId: 'rErr' },
        rStep: { id: 'rStep', automationId: 'a1', userId: 'owner', status: 'success', mode: 'live', version: 3, triggerKind: 'manual_step', startedAt: T, rootRunId: 'rStep' },
        r2: { id: 'r2', automationId: 'a1', userId: 'owner', status: 'success', mode: 'live', version: 3, triggerKind: 'manual', startedAt: T, rootRunId: 'r2' },
    };
    LATEST = {};
    goldens = [];
    replays = [];
    rejectCapture = null;
    blockPrd = false;
});

const call = (method, path, { as = 'owner', body } = {}) => api.call(method, path, { user: USERS[as], body });

// ── mark ────────────────────────────────────────────────────────────

test('a successful run becomes a golden: 201 with the item, label trimmed, paths de-duplicated', async () => {
    const res = await call('POST', '/runs/r1/golden', { body: { label: '  Baseline  ', ignorePaths: ['meta.at', 'meta.at', 'id'] } });
    assert.strictEqual(res.status, 201);
    assert.deepStrictEqual(res.body.golden, {
        goldenId: 'gold_1', runId: 'r1', label: 'Baseline', ignorePaths: ['meta.at', 'id'], createdAt: T, createdBy: 'owner',
        run: { status: 'success', mode: 'live', version: 3, triggerKind: 'manual', startedAt: T },
        lastReplay: null,
    });
});

test('a leg id is normalised to the journey root; marking twice updates the one golden', async () => {
    const first = await call('POST', '/runs/r1b/golden', { body: {} });
    assert.strictEqual(first.status, 201);
    assert.strictEqual(first.body.golden.runId, 'r1');
    assert.strictEqual(first.body.golden.label, null);
    const again = await call('POST', '/runs/r1/golden', { body: { label: 'Renamed' } });
    assert.strictEqual(again.status, 201);
    assert.strictEqual(goldens.length, 1);
    assert.strictEqual(goldens[0].label, 'Renamed');
});

test('a run that did not succeed is refused: golden_needs_success (also when only the latest leg failed)', async () => {
    const res = await call('POST', '/runs/rErr/golden', { body: {} });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'golden_needs_success');
    LATEST.r1 = { ...RUNS.r1b, status: 'error' };
    assert.strictEqual((await call('POST', '/runs/r1/golden', { body: {} })).body.code, 'golden_needs_success');
    assert.deepStrictEqual(goldens, []);
});

test('a partial run (one step) is refused: partial_run_not_golden', async () => {
    const res = await call('POST', '/runs/rStep/golden', { body: {} });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'partial_run_not_golden');
});

test('the limit is enforced for a new golden, not for updating an existing one', async () => {
    process.env.AUTOMATION_GOLDENS_MAX = '1';
    try {
        assert.strictEqual((await call('POST', '/runs/r1/golden', { body: {} })).status, 201);
        const over = await call('POST', '/runs/r2/golden', { body: {} });
        assert.strictEqual(over.status, 409);
        assert.strictEqual(over.body.code, 'golden_limit');
        assert.strictEqual((await call('POST', '/runs/r1/golden', { body: { label: 'again' } })).status, 201);
        process.env.AUTOMATION_GOLDENS_MAX = '0';
        assert.strictEqual((await call('POST', '/runs/r2/golden', { body: {} })).status, 201);
    } finally { delete process.env.AUTOMATION_GOLDENS_MAX; }
});

test('capture refusals of the shared door pass through: caller-mode run, PRD stage', async () => {
    rejectCapture = 'caller_run_not_capturable';
    assert.strictEqual((await call('POST', '/runs/r1/golden', { body: {} })).body.code, 'caller_run_not_capturable');
    rejectCapture = null;
    blockPrd = true;
    assert.strictEqual((await call('POST', '/runs/r1/golden', { body: {} })).body.code, 'test_data_not_on_prd');
    assert.deepStrictEqual(goldens, []);
});

test('roles: a viewer cannot mark, unmark or replay; an editor can', async () => {
    for (const [method, path, body] of [['POST', '/runs/r1/golden', {}], ['DELETE', '/runs/r1/golden'], ['POST', '/a1/goldens/replay', {}]]) {
        const res = await call(method, path, { as: 'vic', body });
        assert.strictEqual(res.status, 403, `${method} ${path}`);
    }
    assert.strictEqual((await call('POST', '/runs/r1/golden', { as: 'ed', body: {} })).status, 201);
    assert.strictEqual((await call('DELETE', '/runs/r1/golden', { as: 'ed' })).status, 200);
});

test('a run that does not exist is a 404', async () => {
    assert.strictEqual((await call('POST', '/runs/nope/golden', { body: {} })).status, 404);
    assert.strictEqual((await call('DELETE', '/runs/nope/golden')).status, 404);
});

test('bodies are strict: unknown keys, a long label, too many or too long paths', async () => {
    const bad = [
        { extra: 1 },
        { label: 'x'.repeat(81) },
        { ignorePaths: Array.from({ length: 51 }, (_, i) => `p${i}`) },
        { ignorePaths: ['x'.repeat(501)] },
        { ignorePaths: 'a' },
        { ignorePaths: [1] },
    ];
    for (const body of bad) {
        const res = await call('POST', '/runs/r1/golden', { body });
        assert.strictEqual(res.status, 400, JSON.stringify(body).slice(0, 40));
    }
    assert.deepStrictEqual(goldens, []);
});

// ── unmark and list ───────────────────────────────────────────────

test('unmarking removes the golden; a leg id works; the answer says whether there was one', async () => {
    await call('POST', '/runs/r1/golden', { body: {} });
    const res = await call('DELETE', '/runs/r1b/golden');
    assert.deepStrictEqual(res.body, { deleted: true });
    assert.deepStrictEqual((await call('DELETE', '/runs/r1/golden')).body, { deleted: false });
});

test('a viewer reads the list, with the run facts and the replay verdict', async () => {
    await call('POST', '/runs/r1/golden', { body: { label: 'A' } });
    await call('POST', '/runs/r2/golden', { body: {} });
    goldens[0].lastReplay = { status: 'changed', summary: { changed: 2 }, errorCode: null, replayRunId: 'rp1', at: NOW() };
    delete RUNS.r2;   // its run is gone: the item still lists, without run facts
    const res = await call('GET', '/a1/goldens', { as: 'vic' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.limits, { max: 50 });
    assert.strictEqual(res.body.goldens.length, 2);
    const first = res.body.goldens[0];
    assert.strictEqual(first.run.status, 'success');
    assert.strictEqual(first.lastReplay.status, 'changed');
    assert.strictEqual(first.lastReplay.replayRunId, 'rp1');
    assert.deepStrictEqual(first.lastReplay.summary, { changed: 2 });
    assert.strictEqual(res.body.goldens[1].run, null);
    assert.match(res.headers.get('cache-control'), /no-store/);
});

test('a replay still running long ago lists as interrupted', async () => {
    await call('POST', '/runs/r1/golden', { body: {} });
    goldens[0].lastReplay = { status: 'running', summary: null, errorCode: null, replayRunId: null, at: new Date(Date.now() - 3 * 3_600_000).toISOString() };
    const res = await call('GET', '/a1/goldens');
    assert.strictEqual(res.body.goldens[0].lastReplay.status, 'interrupted');
});

test('an unknown automation is a 404 on the list', async () => {
    assert.strictEqual((await call('GET', '/nope/goldens')).status, 404);
});

// ── replay ────────────────────────────────────────────────────────

test('replay answers 202 first and starts the background replay for every golden', async () => {
    await call('POST', '/runs/r1/golden', { body: {} });
    await call('POST', '/runs/r2/golden', { body: {} });
    const res = await call('POST', '/a1/goldens/replay', { as: 'ed', body: { aiAnswers: 'cache' } });
    assert.strictEqual(res.status, 202);
    assert.deepStrictEqual(res.body, { replaying: ['gold_1', 'gold_2'] });
    assert.strictEqual(replays.length, 1);
    assert.deepStrictEqual(replays[0].goldens.map(g => g.id), ['gold_1', 'gold_2']);
    assert.strictEqual(replays[0].aiAnswers, 'cache');
    assert.strictEqual(replays[0].userId, 'ed');
    assert.strictEqual(replays[0].automation.id, 'a1');
    // marked running before the answer
    assert.deepStrictEqual(goldens.map(g => g.lastReplay.status), ['running', 'running']);
});

test('replay takes chosen goldens only; aiAnswers defaults to live', async () => {
    await call('POST', '/runs/r1/golden', { body: {} });
    await call('POST', '/runs/r2/golden', { body: {} });
    const res = await call('POST', '/a1/goldens/replay', { body: { goldenIds: ['gold_2', 'gold_2'] } });
    assert.deepStrictEqual(res.body, { replaying: ['gold_2'] });
    assert.strictEqual(replays[0].aiAnswers, 'live');
});

test('an unknown golden id is a 404 and nothing starts', async () => {
    await call('POST', '/runs/r1/golden', { body: {} });
    const res = await call('POST', '/a1/goldens/replay', { body: { goldenIds: ['gold_1', 'gold_nope'] } });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.code, 'golden_not_found');
    assert.deepStrictEqual(replays, []);
    assert.strictEqual(goldens[0].lastReplay, null);
});

test('a replay already running is a 409; a stale one is not', async () => {
    await call('POST', '/runs/r1/golden', { body: {} });
    await call('POST', '/a1/goldens/replay', { body: {} });
    const second = await call('POST', '/a1/goldens/replay', { body: {} });
    assert.strictEqual(second.status, 409);
    assert.strictEqual(second.body.code, 'replay_in_progress');
    assert.strictEqual(replays.length, 1);
    goldens[0].lastReplay.at = new Date(Date.now() - 3 * 3_600_000).toISOString();
    assert.strictEqual((await call('POST', '/a1/goldens/replay', { body: {} })).status, 202);
});

test('replay with no goldens starts nothing; a PRD automation refuses', async () => {
    const none = await call('POST', '/a1/goldens/replay', { body: {} });
    assert.deepStrictEqual(none.body, { replaying: [] });
    assert.deepStrictEqual(replays, []);
    blockPrd = true;
    assert.strictEqual((await call('POST', '/a1/goldens/replay', { body: {} })).body.code, 'test_data_not_on_prd');
});

test('replay bodies are strict', async () => {
    await call('POST', '/runs/r1/golden', { body: {} });
    const bad = [{ extra: 1 }, { aiAnswers: 'maybe' }, { goldenIds: 'gold_1' }, { goldenIds: Array.from({ length: 51 }, (_, i) => `g${i}`) }, { goldenIds: [''] }];
    for (const body of bad) {
        assert.strictEqual((await call('POST', '/a1/goldens/replay', { body })).status, 400, JSON.stringify(body).slice(0, 40));
    }
    assert.deepStrictEqual(replays, []);
});

test('a replayer that throws marks the goldens as error and does not break the answer', async () => {
    const boom = serve('/', makeGoldensRouter({
        store: fakeStore, testingStore: fakeTesting,
        access: accessByRole({ owner: 'owner' }), runDataAccess: door,
        replayGoldens: async () => { throw Object.assign(new Error('x'), { code: 'broken' }); },
        limiter: (_req, _res, next) => next(),
    }));
    try {
        await call('POST', '/runs/r1/golden', { body: {} });
        const res = await boom.call('POST', '/a1/goldens/replay', { user: USERS.owner, body: {} });
        assert.strictEqual(res.status, 202);
        await new Promise(r => setTimeout(r, 50));
        assert.strictEqual(goldens[0].lastReplay.status, 'error');
        assert.strictEqual(goldens[0].lastReplay.errorCode, 'replay_failed');
    } finally { await boom.close(); }
});

test('the replay route is rate limited per user (AUTOMATION_GOLDEN_REPLAY_RPM)', async () => {
    process.env.AUTOMATION_GOLDEN_REPLAY_RPM = '2';
    const limited = serve('/', makeGoldensRouter({
        store: fakeStore, testingStore: fakeTesting, access: accessByRole({ owner: 'owner' }), runDataAccess: door,
        replayGoldens: async () => [],
    }));
    try {
        const codes = [];
        for (let i = 0; i < 3; i++) codes.push((await limited.call('POST', '/a1/goldens/replay', { user: USERS.owner, body: {} })).status);
        assert.deepStrictEqual(codes, [202, 202, 429]);
    } finally { delete process.env.AUTOMATION_GOLDEN_REPLAY_RPM; await limited.close(); }
});
