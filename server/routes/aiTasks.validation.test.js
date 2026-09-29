/**
 * What the AI task routes accept, and what they say when they refuse
 * (routes/aiTasks.js).
 *
 * The hand-rolled readers answered 200 to a filter sent twice (and listed
 * every task), to weekday tokens they did not know (and dropped them — a
 * routine with nothing left became a one-off that switched itself off), and
 * to a `startNow` that was not a boolean (and started nothing). What this
 * pins is the part a caller can act on:
 *
 *   - the 400 names the field, and says what it takes;
 *   - the store is never reached, so a refused request changes nothing;
 *   - a routine that repeats by weekday stays on the scheduler after
 *     `startNow`, the way the runner's own isRepeating reads it.
 *
 * Run: cd server && node --test routes/aiTasks.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store call lands in `touched`. A refused request must leave it empty.
const touched = [];
const executed = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../stores/aiTaskStore': {
        getTasks: async (...a) => { touched.push({ what: 'getTasks', args: a }); return []; },
        getTasksByAgent: async (...a) => { touched.push({ what: 'getTasksByAgent', args: a }); return []; },
        getTaskCount: async () => 0,
        createTask: async (p) => { touched.push({ what: 'createTask', args: [p] }); return { id: 't1', isActive: true, ...p }; },
        updateTask: async (id, p) => { touched.push({ what: 'updateTask', args: [id, p] }); return true; },
        getTask: async (id) => ({ id, userId: 'u1', isActive: true, lastStatus: 'success' }),
        deleteTask: async () => true,
    },
    '../stores/agentStore': { getAgent: async (id) => ({ id, owner_id: 'u1', name: 'A' }) },
    '../stores/configStore': { getConfig: async () => null },
    '../core/aiTaskRunner': { executeTask: async (task) => { executed.push(task.id); } },
    '../core/entitlements/betaFeatures': { userHasBetaFeature: async () => true },
    '../auth/permissions': { requireAuth: pass },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:ai-tasks-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]aiTasks\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./aiTasks');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ method, url, body = {}, query = {} }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query, headers: {},
            session: { user: { id: 'u1' } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

const flush = () => new Promise((r) => setImmediate(() => setImmediate(r)));
const BASE = { title: 'Weekly digest', prompt: 'Summarise the week', nextRunAt: '2026-10-05T07:00:00.000Z' };
const created = () => touched.find((t) => t.what === 'createTask')?.args[0];

test.beforeEach(() => { touched.length = 0; executed.length = 0; });

test('an agent filter sent twice is refused, instead of listing every task', async () => {
    const res = await dispatch({ method: 'GET', url: '/', query: { agentId: ['a1', 'a2'] } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'query.agentId'));
    assert.deepStrictEqual(touched, []);
});

test('a misspelled or empty agent filter is refused too', async () => {
    for (const query of [{ agentid: 'a1' }, { agentId: '' }]) {
        const res = await dispatch({ method: 'GET', url: '/', query });
        assert.strictEqual(res.statusCode, 400, JSON.stringify(query));
    }
    assert.deepStrictEqual(touched, []);
});

test('a real agent filter narrows the list', async () => {
    const res = await dispatch({ method: 'GET', url: '/', query: { agentId: 'a1' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched, [{ what: 'getTasksByAgent', args: ['u1', 'a1'] }]);
});

test('weekday tokens it does not know are refused, not dropped into a one-off', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { ...BASE, daysOfWeek: ['mo', 'di'] } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /weekdays: sun, mon/);
    assert.ok(res.body.details.some((d) => d.path === 'body.daysOfWeek.0'));
    assert.deepStrictEqual(touched, []);
});

test('full English day names still map onto their tokens', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { ...BASE, daysOfWeek: ['Monday', 'wed', 'mon'] } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(created().daysOfWeek, ['mon', 'wed']);
});

test('startNow keeps a weekday routine on the scheduler — it repeats', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { ...BASE, daysOfWeek: ['mon'], startNow: true } });
    assert.strictEqual(res.statusCode, 200);
    await flush();
    assert.ok(!touched.some((t) => t.what === 'updateTask'), 'an every-Monday routine is not switched off');
    assert.deepStrictEqual(executed, ['t1']);
});

test('startNow still takes a real one-off off the scheduler before firing it', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { ...BASE, startNow: true } });
    assert.strictEqual(res.statusCode, 200);
    await flush();
    assert.ok(touched.some((t) => t.what === 'updateTask' && t.args[1].isActive === false));
    assert.deepStrictEqual(executed, ['t1']);
});

test('startNow as text is refused instead of starting nothing under a 200', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { ...BASE, startNow: 'true' } });
    assert.strictEqual(res.statusCode, 400);
    await flush();
    assert.deepStrictEqual(touched, []);
    assert.deepStrictEqual(executed, []);
});

test('a time of day that is no time, a date that is no date, a zone that is no zone', async () => {
    const cases = [
        [{ timeOfDay: '25:99' }, 'body.timeOfDay'],
        [{ nextRunAt: 'next tuesday-ish' }, 'body.nextRunAt'],
        [{ timezone: 'Mars/Olympus_Mons' }, 'body.timezone'],
        [{ repeatInterval: 'fortnightly' }, 'body.repeatInterval'],
        [{ repeatIntervall: 'weekly' }, 'body'],
    ];
    for (const [extra, path] of cases) {
        const res = await dispatch({ method: 'POST', url: '/', body: { ...BASE, ...extra } });
        assert.strictEqual(res.statusCode, 400, JSON.stringify(extra));
        assert.ok(res.body.details.some((d) => d.path === path), `${JSON.stringify(extra)} → ${JSON.stringify(res.body.details)}`);
    }
    assert.deepStrictEqual(touched, []);
});

test('a missing title is answered in words, not with "Required"', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { prompt: 'x', nextRunAt: BASE.nextRunAt } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Title is required');
});

test('a PUT cannot blank the title or the prompt, and isActive is a boolean', async () => {
    for (const body of [{ title: '   ' }, { prompt: '' }, { isActive: 'false' }]) {
        const res = await dispatch({ method: 'PUT', url: '/t1', body });
        assert.strictEqual(res.statusCode, 400, JSON.stringify(body));
    }
    assert.deepStrictEqual(touched, []);
});

test('a PUT with an empty repeat and no days clears both, as before', async () => {
    const res = await dispatch({ method: 'PUT', url: '/t1', body: { repeatInterval: '', daysOfWeek: [], timeOfDay: '' } });
    assert.strictEqual(res.statusCode, 200);
    const patch = touched.find((t) => t.what === 'updateTask').args[1];
    assert.strictEqual(patch.repeatInterval, null);
    assert.strictEqual(patch.daysOfWeek, null);
    assert.strictEqual(patch.timeOfDay, null);
});
