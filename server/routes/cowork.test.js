/**
 * Route tests for /api/cowork.
 *
 * Two things carry real risk here:
 *
 *   - Ownership. Every path takes an :id from the URL, and the history
 *     endpoint returns whatever that schedule produced — including the model's
 *     output over the user's mail and calendar. A missing ownership check on
 *     GET /:id/runs leaks that to anyone with a valid session and a guessed id.
 *
 *   - The double-run hazard on `startNow`, inherited from /api/ai-tasks: a
 *     fresh row is inserted active with next_run_at = now, so firing it
 *     manually while leaving it on the scheduler makes the next tick run the
 *     same row again. A one-off is deactivated first; a repeating one keeps
 *     its schedule.
 *
 * Stores, auth and the runner are mocked via the Module._resolveFilename
 * harness (same pattern as routes/aiTasks.startNow.test.js) — no DB touched.
 *
 * The request schemas answer a refusal through the terminal error handler,
 * so the harness mounts it after the router, as index.js does.
 *
 * Run: node --test routes/cowork.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const Module = require('module');

// ── Fixtures ────────────────────────────────────────────────────────

const state = {
    created: [],
    updates: [],
    executed: [],
    deleted: [],
    listedRuns: [],
    statsFor: [],
    count: 0,
    // Welke schema's een open run hebben, per id → starttijd.
    openRuns: {},
    schedules: [],
};

function reset() {
    state.created = [];
    state.updates = [];
    state.executed = [];
    state.deleted = [];
    state.listedRuns = [];
    state.statsFor = [];
    state.count = 0;
    state.openRuns = {};
    state.schedules = [];
}

// Owned by 'u1'. Anything else asking for it must get a 403.
// Een SCHEMA zoals de store hem teruggeeft — inclusief de velden die tekst
// over andermans post dragen. `lastResult` staat hier met opzet in en met een
// herkenbare zin erin: de "stats lekt geen tekst"-test hieronder loopt over de
// waarden van het antwoord, dus een veld dat niet in deze fixture staat kan
// ongezien meelekken. Dat is precies wat er met last_result gebeurde — een
// echt schemaveld (coworkStore.rowToSchedule) dat de fixture niet kende.
const OWNED = {
    id: 'cw-1',
    userId: 'u1',
    title: 'Morning digest',
    prompt: 'Summarise overnight',
    isActive: true,
    lastStatus: 'success',
    lastResult: 'Anna Bakker asked about invoice 4471 — reply before Friday.',
    lastRunAt: '2026-09-09T06:00:00.000Z',
    runCount: 42,
    createdAt: '2026-07-08T06:00:00.000Z',
};

const mockCoworkStore = {
    async getSchedules() { return state.schedules.map(x => ({ ...x })); },
    async getOpenRunStarts() { return { ...state.openRuns }; },
    async getOpenRunStart(id) { return state.openRuns[id] || null; },
    async getRunStats(id) {
        state.statsFor.push(id);
        return { total: 12, success: 10, failed: 2, avgDurationMs: 72000 };
    },
    async getScheduleCount() { return state.count; },
    async createSchedule(args) {
        state.created.push(args);
        return { ...OWNED, ...args, id: 'cw-1', isActive: true };
    },
    async updateSchedule(id, patch) { state.updates.push({ id, patch }); return true; },
    async getSchedule(id) { return id === OWNED.id ? { ...OWNED } : null; },
    async deleteSchedule(id) { state.deleted.push(id); return true; },
    async listRuns(id, opts) {
        state.listedRuns.push({ id, opts });
        return [{ id: 'run-1', status: 'success', result: 'private output' }];
    },
    async getRunCount() { return 1; },
};

const composeCalls = [];
const mockCompose = {
    async composeCowork(args) {
        composeCalls.push(args);
        return { title: 'T', prompt: 'P', repeatInterval: 'daily', timeOfDay: '08:00', agentId: null, composed: true };
    },
};

const MOCKS = {
    '../stores/coworkStore': mockCoworkStore,
    '../core/cowork/coworkCompose': mockCompose,
    // routes/cowork.js requires this lazily inside the handler.
    './coworkCompose': mockCompose,
    '../stores/agentStore': {
        async getAgent(id) { return { id, owner_id: 'u1', name: 'A' }; },
        async getAgents() {
            return [
                { id: 'a-mine', owner_id: 'u1', name: 'Mine', description: 'd' },
                { id: 'a-system', owner_id: 'system', name: 'System agent' },
            ];
        },
    },
    '../stores/configStore': { async getConfig() { return null; } },
    '../core/cowork/coworkRunner': {
        async executeCowork(schedule, opts) {
            state.executed.push({ id: schedule.id, isActive: schedule.isActive, opts });
        },
    },
    '../core/entitlements/betaFeatures': { async userHasBetaFeature() { return true; } },
    '../auth/permissions': {
        requireAuth: (req, res, next) => {
            if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
            next();
        },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:cowork:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) return MOCK_IDS[request];
    return originalResolve.call(this, request, parent, ...rest);
};

const express = require('express');
const router = require('./cowork');
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

// ── HTTP harness ────────────────────────────────────────────────────

let server;
let baseUrl;

test.before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        const uid = req.headers['x-test-user'];
        if (uid) req.session = { isAuthenticated: true, user: { id: uid } };
        next();
    });
    app.use('/api/cowork', router);
    app.use(terminalErrorHandler);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/api/cowork`;
});

test.after(async () => {
    await new Promise((resolve) => server.close(resolve));
});

async function call(path, { method = 'GET', body, user = 'u1' } = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
            ...(user ? { 'x-test-user': user } : {}),
            ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
}

const flush = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

const BASE = { title: 'Morning digest', prompt: 'Summarise overnight', nextRunAt: new Date().toISOString() };

// ── Auth + ownership ────────────────────────────────────────────────

test('every route needs a session', async () => {
    for (const [path, method] of [
        ['', 'GET'], ['', 'POST'], ['/cw-1', 'PUT'], ['/cw-1', 'DELETE'],
        ['/cw-1/toggle', 'POST'], ['/cw-1/run-now', 'POST'], ['/cw-1/runs', 'GET'],
        ['/cw-1/stats', 'GET'],
    ]) {
        const r = await call(path, { method, user: null });
        assert.strictEqual(r.status, 401, `${method} ${path || '/'} should be 401 without a session`);
    }
});

test('run history is refused to anyone but the owner', async () => {
    reset();
    const r = await call('/cw-1/runs', { user: 'someone-else' });
    assert.strictEqual(r.status, 403);
    assert.deepStrictEqual(state.listedRuns, [], 'must not read the runs before the ownership check');
});

test('the owner gets the run history', async () => {
    reset();
    const r = await call('/cw-1/runs', { user: 'u1' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.runs.length, 1);
    assert.strictEqual(r.json.total, 1);
});

test('the run history pages as the web asks, and refuses what it used to clamp', async () => {
    reset();
    const ok = await call('/cw-1/runs?limit=25&offset=50');
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(state.listedRuns[0].opts, { limit: 25, offset: 50 });

    for (const qs of ['limit=500', 'limit=abc', 'offset=-1', 'limt=5']) {
        const r = await call(`/cw-1/runs?${qs}`);
        assert.strictEqual(r.status, 400, qs);
    }
});

test('a missing schedule is 404, not 500', async () => {
    const r = await call('/nope/runs', { user: 'u1' });
    assert.strictEqual(r.status, 404);
});

test('mutations are refused to non-owners', async () => {
    reset();
    for (const [path, method] of [['/cw-1', 'PUT'], ['/cw-1', 'DELETE'], ['/cw-1/toggle', 'POST'], ['/cw-1/run-now', 'POST']]) {
        const r = await call(path, { method, body: method === 'PUT' ? { title: 'x' } : undefined, user: 'someone-else' });
        assert.strictEqual(r.status, 403, `${method} ${path} should be 403`);
    }
    await flush();
    assert.deepStrictEqual(state.executed, [], 'a non-owner must never start a run');
    assert.deepStrictEqual(state.deleted, []);
});

// ── Validation ──────────────────────────────────────────────────────

test('title, prompt and nextRunAt are required', async () => {
    reset();
    assert.strictEqual((await call('', { method: 'POST', body: { prompt: 'p', nextRunAt: 'x' } })).status, 400);
    assert.strictEqual((await call('', { method: 'POST', body: { title: 't', nextRunAt: 'x' } })).status, 400);
    assert.strictEqual((await call('', { method: 'POST', body: { title: 't', prompt: 'p' } })).status, 400);
    assert.deepStrictEqual(state.created, []);
});

test('an unknown repeat interval is rejected', async () => {
    reset();
    const r = await call('', { method: 'POST', body: { ...BASE, repeatInterval: 'fortnightly' } });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /repeatInterval/);
});

test('an unknown timezone is rejected — it would silently break the tick', async () => {
    reset();
    const r = await call('', { method: 'POST', body: { ...BASE, timezone: 'Mars/Olympus' } });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /timezone/i);
});

test('the schedule limit is enforced before anything is created', async () => {
    reset();
    state.count = 10;
    const r = await call('', { method: 'POST', body: BASE });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /Maximum number/);
    assert.deepStrictEqual(state.created, []);
});

// ── startNow: the double-run hazard ─────────────────────────────────

test('without startNow nothing runs — it is only scheduled', async () => {
    reset();
    assert.strictEqual((await call('', { method: 'POST', body: BASE })).status, 200);
    await flush();
    assert.deepStrictEqual(state.executed, []);
    assert.deepStrictEqual(state.updates, []);
});

test('startNow on a one-off takes it off the scheduler before firing', async () => {
    reset();
    assert.strictEqual((await call('', { method: 'POST', body: { ...BASE, startNow: true } })).status, 200);
    await flush();
    assert.deepStrictEqual(state.updates, [{ id: 'cw-1', patch: { isActive: false } }]);
    assert.strictEqual(state.executed.length, 1);
    assert.strictEqual(state.executed[0].isActive, false);
    assert.strictEqual(state.executed[0].opts.manual, true);
});

test('startNow on a repeating one keeps it active and keeps its schedule', async () => {
    reset();
    const r = await call('', { method: 'POST', body: { ...BASE, repeatInterval: 'daily', startNow: true } });
    assert.strictEqual(r.status, 200);
    await flush();
    assert.deepStrictEqual(state.updates, [], 'a repeating schedule stays on the scheduler');
    assert.strictEqual(state.executed.length, 1);
    assert.strictEqual(state.executed[0].opts.manual, true);
});

test('startNow is a boolean: "true" is refused, not a 200 that starts nothing', async () => {
    // It used to fire only for a literal true and answer anything else with
    // a 200, so a repeating item asked to start now ran an interval late.
    reset();
    const r = await call('', { method: 'POST', body: { ...BASE, startNow: 'true' } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error, 'startNow is true or false.');
    await flush();
    assert.deepStrictEqual(state.executed, []);
    assert.deepStrictEqual(state.created, [], 'nothing is scheduled either');
});

test('startNow: false schedules without running', async () => {
    reset();
    assert.strictEqual((await call('', { method: 'POST', body: { ...BASE, startNow: false } })).status, 200);
    await flush();
    assert.deepStrictEqual(state.executed, []);
    assert.strictEqual(state.created.length, 1);
});

// ── Schedule vocabulary ─────────────────────────────────────────────

test('a weekday that is not one is refused, instead of turning "Mon and Tue" into every day', async () => {
    // ['ma', 'di'] used to normalise to no days at all: stored as null, so a
    // daily item ran every day and a non-repeating one became a one-off.
    reset();
    const r = await call('', { method: 'POST', body: { ...BASE, repeatInterval: 'daily', daysOfWeek: ['ma', 'di'] } });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /"ma" is not a weekday/);
    assert.deepStrictEqual(state.created, []);
});

test('weekday tokens and English names are accepted and stored as tokens', async () => {
    reset();
    const r = await call('', { method: 'POST', body: { ...BASE, daysOfWeek: ['Monday', 'tues', 'mon', 'FRI'] } });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(state.created[0].daysOfWeek, ['mon', 'tue', 'fri']);
});

test('a word that merely starts like a weekday is not one', async () => {
    reset();
    const r = await call('', { method: 'POST', body: { ...BASE, daysOfWeek: ['month'] } });
    assert.strictEqual(r.status, 400);
});

test('an empty day list still means "no day restriction"', async () => {
    reset();
    await call('', { method: 'POST', body: { ...BASE, daysOfWeek: [] } });
    assert.strictEqual(state.created[0].daysOfWeek, null);
});

test('nextRunAt must be a timestamp with a zone, not text Postgres guesses at', async () => {
    reset();
    for (const nextRunAt of ['tomorrow', '2026-09-24 08:00']) {
        const r = await call('', { method: 'POST', body: { ...BASE, nextRunAt } });
        assert.strictEqual(r.status, 400, nextRunAt);
        assert.ok(r.json.details.some((d) => d.path === 'body.nextRunAt'));
    }
    assert.deepStrictEqual(state.created, []);
});

test('timeOfDay must be a real 24-hour time', async () => {
    reset();
    const bad = await call('', { method: 'POST', body: { ...BASE, timeOfDay: '25:99' } });
    assert.strictEqual(bad.status, 400);
    await call('', { method: 'POST', body: { ...BASE, timeOfDay: '07:30' } });
    assert.strictEqual(state.created[0].timeOfDay, '07:30');
});

test('an unknown key is refused by name', async () => {
    reset();
    const r = await call('', { method: 'POST', body: { ...BASE, repeat: 'daily' } });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /repeat/);
    assert.deepStrictEqual(state.created, []);
});

test('the Work composer\'s own payload is accepted as it is sent', async () => {
    reset();
    const r = await call('', {
        method: 'POST',
        body: {
            title: 'Weekoverzicht', prompt: 'Vat mijn week samen', nextRunAt: '2026-09-28T07:00:00.000Z',
            repeatInterval: 'weekly', modelTier: 'auto', timezone: 'Europe/Amsterdam',
            daysOfWeek: ['mon'], timeOfDay: '09:00', agentId: 'a-mine', enabledApps: ['gmail'],
        },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(state.created[0].modelTier, 'auto');
});

test('an update cannot blank the title or the prompt', async () => {
    reset();
    for (const body of [{ title: '  ' }, { prompt: '' }]) {
        const r = await call('/cw-1', { method: 'PUT', body });
        assert.strictEqual(r.status, 400, JSON.stringify(body));
    }
    assert.deepStrictEqual(state.updates, []);
});

test('the edit form\'s own payload is accepted as it is sent', async () => {
    reset();
    const r = await call('/cw-1', {
        method: 'PUT',
        body: {
            title: 'Renamed', prompt: 'P', repeatInterval: null, daysOfWeek: null,
            nextRunAt: '2026-09-28T07:00:00.000Z', timeOfDay: null, agentId: null, enabledApps: null,
        },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(state.updates[0].patch.title, 'Renamed');
});

test('toggle and run-now take no body', async () => {
    reset();
    const r = await call('/cw-1/toggle', { method: 'POST', body: { isActive: true } });
    assert.strictEqual(r.status, 400);
    assert.deepStrictEqual(state.updates, []);
});

// ── run-now ─────────────────────────────────────────────────────────

test('run-now refuses to stack a second run on a running schedule', async () => {
    reset();
    const original = mockCoworkStore.getSchedule;
    mockCoworkStore.getSchedule = async () => ({ ...OWNED, lastStatus: 'running' });
    try {
        const r = await call('/cw-1/run-now', { method: 'POST' });
        assert.strictEqual(r.status, 400);
        await flush();
        assert.deepStrictEqual(state.executed, []);
    } finally {
        mockCoworkStore.getSchedule = original;
    }
});

test('run-now answers without waiting for the run to finish', async () => {
    reset();
    // The run is dispatched via setImmediate, so the 200 does not depend on it
    // completing — a cowork run can take minutes. Proven by the handler
    // resolving while executeCowork is still only queued: it never awaits it.
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    const original = MOCKS['../core/cowork/coworkRunner'].executeCowork;
    MOCKS['../core/cowork/coworkRunner'].executeCowork = async (schedule, opts) => {
        state.executed.push({ id: schedule.id, isActive: schedule.isActive, opts });
        await blocked;
    };
    try {
        const r = await call('/cw-1/run-now', { method: 'POST' });
        assert.strictEqual(r.status, 200, 'responds while the run is still in flight');
        assert.strictEqual(r.json.success, true);
        await flush();
        assert.strictEqual(state.executed.length, 1);
        assert.strictEqual(state.executed[0].opts.manual, true);
    } finally {
        release();
        MOCKS['../core/cowork/coworkRunner'].executeCowork = original;
    }
});

// ── compose ─────────────────────────────────────────────────────────

test('compose returns a spec and creates nothing', async () => {
    reset();
    composeCalls.length = 0;
    const r = await call('/compose', { method: 'POST', body: { brief: 'elke ochtend een goede morgen' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.repeatInterval, 'daily');
    assert.deepStrictEqual(state.created, [], 'compose must not schedule anything');
});

test('compose rejects an empty brief', async () => {
    const r = await call('/compose', { method: 'POST', body: { brief: '   ' } });
    assert.strictEqual(r.status, 400);
});

test('compose only offers agents the create call would accept', async () => {
    reset();
    composeCalls.length = 0;
    await call('/compose', { method: 'POST', body: { brief: 'iets' } });
    const ids = composeCalls[0].agents.map(a => a.id);
    assert.deepStrictEqual(ids, ['a-mine'], 'system agents are not assignable and must not be offered');
});

test('compose falls back to a sane timezone rather than 400ing on a bad one', async () => {
    reset();
    composeCalls.length = 0;
    const r = await call('/compose', { method: 'POST', body: { brief: 'iets', timezone: 'Mars/Olympus' } });
    assert.strictEqual(r.status, 200, 'a bad clock hint should not block composing');
    assert.strictEqual(composeCalls[0].timezone, 'Europe/Amsterdam');
});

test('compose keeps a known timezone', async () => {
    reset();
    composeCalls.length = 0;
    await call('/compose', { method: 'POST', body: { brief: 'iets', timezone: 'America/New_York' } });
    assert.strictEqual(composeCalls[0].timezone, 'America/New_York');
});

// ── toggle ──────────────────────────────────────────────────────────

test('GET /:id returns the schedule so a result can find its way back', async () => {
    // The notification a finished run produces needs the agent + conversation
    // to know whether to continue in that agent's chat or in direct chat.
    reset();
    const r = await call('/cw-1');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.id, 'cw-1');
});

test('GET /:id is ownership-checked like every other :id route', async () => {
    reset();
    const mine = await call('/cw-1', { user: 'u2' });
    assert.strictEqual(mine.status, 403, 'someone else must not read my schedule');
    const missing = await call('/nope');
    assert.strictEqual(missing.status, 404);
    const anon = await call('/cw-1', { user: null });
    assert.strictEqual(anon.status, 401);
});

test('enabledApps: a per-item app list is stored on create', async () => {
    reset();
    const r = await call('/', {
        method: 'POST',
        body: { ...BASE, enabledApps: ['gmail', 'google-calendar'] },
    });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(state.created[0].enabledApps, ['gmail', 'google-calendar']);
});

test('enabledApps: absent means "follow the workspace list", not "no apps"', async () => {
    reset();
    await call('/', { method: 'POST', body: { ...BASE } });
    assert.strictEqual(state.created[0].enabledApps, null);
});

test('enabledApps: an empty list is a real answer and survives', async () => {
    // "this one may touch nothing" must not collapse into "unset".
    reset();
    await call('/', { method: 'POST', body: { ...BASE, enabledApps: [] } });
    assert.deepStrictEqual(state.created[0].enabledApps, []);
});

test('enabledApps: junk is rejected, duplicates and blanks are cleaned', async () => {
    reset();
    const bad = await call('/', {
        method: 'POST',
        body: { ...BASE, enabledApps: 'gmail' },
    });
    assert.strictEqual(bad.status, 400);

    // A non-string entry used to be dropped in silence: [7] stored "no apps".
    const junk = await call('/', {
        method: 'POST',
        body: { ...BASE, enabledApps: ['gmail', 7] },
    });
    assert.strictEqual(junk.status, 400);
    assert.deepStrictEqual(state.created, []);

    await call('/', {
        method: 'POST',
        body: { ...BASE, enabledApps: ['gmail', 'gmail', '  ', ' onedrive '] },
    });
    assert.deepStrictEqual(state.created[0].enabledApps, ['gmail', 'onedrive']);
});

test('enabledApps: PUT can set a list and hand it back to the workspace default', async () => {
    reset();
    await call('/cw-1', { method: 'PUT', body: { enabledApps: ['gmail'] } });
    assert.deepStrictEqual(state.updates[0].patch.enabledApps, ['gmail']);

    reset();
    await call('/cw-1', { method: 'PUT', body: { enabledApps: null } });
    assert.strictEqual(state.updates[0].patch.enabledApps, null);

    // Untouched by a PUT that says nothing about apps.
    reset();
    await call('/cw-1', { method: 'PUT', body: { title: 'Renamed' } });
    assert.strictEqual(state.updates[0].patch.enabledApps, undefined);
});

test('toggle flips the active flag and reports the new value', async () => {
    reset();
    const r = await call('/cw-1/toggle', { method: 'POST' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.isActive, false, 'OWNED starts active, so toggling pauses it');
    assert.deepStrictEqual(state.updates, [{ id: 'cw-1', patch: { isActive: false } }]);
});

// ── CW-06: currentRunStartedAt ──────────────────────────────────────
//
// "Loopt sinds 08:00:04" is een uitspraak over de run die NU open staat, dus
// hij hoort uit de open historierij te komen — niet uit lastStatus. De payload
// mag er alleen bij winnen: niets wat de Expo-app leest verandert van naam.

test('GET / carries the start time of each open run, and null for the rest', async () => {
    reset();
    state.schedules = [
        { ...OWNED, id: 'cw-running' },
        { ...OWNED, id: 'cw-idle' },
    ];
    state.openRuns = { 'cw-running': '2026-09-10T08:00:04.000Z' };

    const r = await call('');
    assert.strictEqual(r.status, 200);
    const byId = Object.fromEntries(r.json.schedules.map(s => [s.id, s]));
    assert.strictEqual(byId['cw-running'].currentRunStartedAt, '2026-09-10T08:00:04.000Z');
    assert.strictEqual(byId['cw-idle'].currentRunStartedAt, null,
        'a schedule with nothing open says so explicitly — the field is always present');
});

test('GET / keeps every field it already sent — the field is added, nothing renamed', async () => {
    // De Expo-app leest deze payload; een hernoeming hier is een kapotte APK
    // zonder rode test. Daarom: alles wat de store levert komt er ongewijzigd
    // uit, plus het nieuwe veld.
    reset();
    state.schedules = [{ ...OWNED }];
    const r = await call('');
    for (const [k, v] of Object.entries(OWNED)) {
        assert.deepStrictEqual(r.json.schedules[0][k], v, `${k} must survive the enrichment`);
    }
    assert.ok('currentRunStartedAt' in r.json.schedules[0]);
});

test('GET /:id carries currentRunStartedAt too', async () => {
    reset();
    state.openRuns = { 'cw-1': '2026-09-10T08:00:04.000Z' };
    const r = await call('/cw-1');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.currentRunStartedAt, '2026-09-10T08:00:04.000Z');

    reset();
    const idle = await call('/cw-1');
    assert.strictEqual(idle.json.currentRunStartedAt, null);
});

// ── CW-11: GET /:id/stats ───────────────────────────────────────────

test('the stats route is ownership-checked exactly like the run history', async () => {
    reset();
    const other = await call('/cw-1/stats', { user: 'someone-else' });
    assert.strictEqual(other.status, 403, 'someone else must not read my figures');
    assert.deepStrictEqual(state.statsFor, [],
        'must not aggregate before the ownership check');

    const missing = await call('/nope/stats');
    assert.strictEqual(missing.status, 404);

    const anon = await call('/cw-1/stats', { user: null });
    assert.strictEqual(anon.status, 401);
});

test('the owner gets the aggregate plus the schedule\'s own lifetime figures', async () => {
    reset();
    const r = await call('/cw-1/stats');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(state.statsFor, ['cw-1']);
    assert.strictEqual(r.json.total, 12);
    assert.strictEqual(r.json.success, 10);
    assert.strictEqual(r.json.failed, 2);
    assert.strictEqual(r.json.avgDurationMs, 72000);
    // "42 keer gedraaid · sinds 8 juli" komt van het SCHEMA, niet van de
    // bewaarde rijen: de retentiesweep laat `total` na 90 dagen krimpen en
    // run_count niet.
    assert.strictEqual(r.json.runCount, 42);
    assert.strictEqual(r.json.createdAt, '2026-07-08T06:00:00.000Z');
});

test('a broken open-runs query costs the live times, not the whole list', async () => {
    // De .catch op getOpenRunStarts stond er ongedekt: zonder hem verandert
    // één kapotte query de hele lijst in een 500, en de gebruiker ziet niets
    // meer van zijn werk omdat "loopt sinds …" niet uit te rekenen was.
    // Eerlijk erbij: dit is dezelfde vorm van fail-open die elders in deze
    // batch juist is dichtgezet — "onbekend" wordt hier "niets loopt". Dat is
    // hier de goede kant op (het scherm claimt géén live run, en de rij zelf
    // zegt nog steeds wat de status is), maar de keuze hoort zichtbaar te zijn
    // in plaats van in een stille .catch te staan.
    reset();
    state.schedules = [{ ...OWNED, id: 'cw-1' }];
    const original = mockCoworkStore.getOpenRunStarts;
    mockCoworkStore.getOpenRunStarts = async () => { throw new Error('db down'); };
    try {
        const r = await call('/');
        assert.strictEqual(r.status, 200, 'de lijst blijft leesbaar');
        assert.strictEqual(r.json.schedules.length, 1);
        assert.strictEqual(r.json.schedules[0].currentRunStartedAt, null,
            'geen verzonnen starttijd, en het veld blijft bestaan');
    } finally {
        mockCoworkStore.getOpenRunStarts = original;
    }
});

test('a broken open-run query costs one item its live time, not its detail', async () => {
    reset();
    const original = mockCoworkStore.getOpenRunStart;
    mockCoworkStore.getOpenRunStart = async () => { throw new Error('db down'); };
    try {
        const r = await call('/cw-1');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json.currentRunStartedAt, null);
    } finally {
        mockCoworkStore.getOpenRunStart = original;
    }
});

test('the stats answer carries no cost or token field to render as € 0,00', async () => {
    // Kosten per cowork bestaan niet (CW-12: het runpad logt geen usage). Een
    // leeg veld zou als "€ 0,00 deze maand" op het scherm komen — een getal
    // dat niemand heeft gemeten.
    reset();
    const r = await call('/cw-1/stats');
    for (const key of Object.keys(r.json)) {
        assert.ok(!/cost|token|eur|price/i.test(key), `${key} claims a figure nothing measures`);
    }
});

test('the stats route never returns run results, only counts', async () => {
    // Dezelfde reden waarom /runs eigendom-gecontroleerd is: het resultaat gaat
    // over andermans post en agenda. Een aggregaat hoort geen tekst te dragen.
    reset();
    const r = await call('/cw-1/stats');
    for (const v of Object.values(r.json)) {
        assert.ok(typeof v !== 'string' || /^\d{4}-\d{2}-\d{2}T/.test(v),
            `unexpected free text in the stats answer: ${v}`);
    }
});

test('the stats route names its fields, rather than spreading the schedule', async () => {
    // De vorige test kijkt naar WAARDEN, en dekt daarmee alleen de velden die
    // deze fixture toevallig vult. Deze kijkt naar de SLEUTELS: het antwoord is
    // een opsomming, geen doorgeefluik. Zo blijft een kolom die volgend jaar
    // aan cowork_schedules wordt toegevoegd buiten dit aggregaat — dezelfde
    // allow-list-regel als voor uitgaande payloads.
    reset();
    const r = await call('/cw-1/stats');
    assert.deepStrictEqual(
        Object.keys(r.json).sort(),
        ['avgDurationMs', 'createdAt', 'failed', 'runCount', 'success', 'total'],
    );
});

test('the stats route does not carry the last result along', async () => {
    // last_result is een echt schemaveld met de tekst van de laatste run erin.
    // Het staat in de fixture, dus het kan hier alleen ontbreken doordat de
    // route het niet meestuurt.
    reset();
    const r = await call('/cw-1/stats');
    assert.strictEqual(r.json.lastResult, undefined);
    assert.ok(!JSON.stringify(r.json).includes('Anna Bakker'), 'run text reached the aggregate');
});
