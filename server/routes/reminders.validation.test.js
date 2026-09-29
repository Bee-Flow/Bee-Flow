/**
 * What the reminder routes accept, and what they say when they refuse
 * (routes/reminders.js).
 *
 * The routes handed whatever arrived to the store, and a wrong value never
 * showed there: `repeatInterval: "biweekly"` was stored, fired once, and — the
 * checker only advances daily, weekly and monthly — was then marked completed,
 * so a repeating reminder quietly became a one-off. `?completed=1` listed the
 * open ones only, and a misspelled field on PUT answered `{ success: false }`
 * under a 200. What this file pins is the part a caller can act on:
 *
 *   - the 400 NAMES the field (`body.repeatInterval`), not just "invalid request";
 *   - the message is a sentence;
 *   - the store is never reached, so a refused request changes nothing;
 *   - a request without a session is still a 401 first.
 *
 * Run: cd server && node --test routes/reminders.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store call lands in `touched`. A refused request must leave it empty.
const touched = [];

const MOCKS = {
    '../stores/reminderStore': {
        getReminders: async (userId, opts) => { touched.push({ what: 'getReminders', args: [userId, opts] }); return []; },
        getReminder: async (id) => ({ id, userId: 'u1' }),
        createReminder: async (p) => { touched.push({ what: 'createReminder', args: [p] }); return { id: 'r1', ...p }; },
        updateReminder: async (id, u) => { touched.push({ what: 'updateReminder', args: [id, u] }); return true; },
        deleteReminder: async () => true,
        markCompleted: async () => true,
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:reminders-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]reminders\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./reminders');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ method, url, body, session = { user: { id: 'u1' } } }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method, url, originalUrl: url, path: pathname, body, query, headers: {},
            session, get() { return undefined; },
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

test.beforeEach(() => { touched.length = 0; });

const WHEN = '2026-09-23T09:00:00.000Z';

async function refuses(request, field) {
    const res = await dispatch(request);
    assert.strictEqual(res.statusCode, 400, `${request.method} ${request.url} -> ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
    return res;
}

// ═══ POST / ══════════════════════════════════════════════════════════

test('an interval the checker cannot advance is refused, not stored as a one-off in disguise', async () => {
    const res = await refuses({
        method: 'POST', url: '/', body: { title: 'Timesheet', remindAt: WHEN, repeatInterval: 'biweekly' },
    }, 'body.repeatInterval');
    assert.strictEqual(res.body.error, 'repeatInterval is "daily", "weekly" or "monthly" — or null for once.');
});

test('a time that is not a timestamp is refused in words, not a 500 from the database', async () => {
    const res = await refuses({ method: 'POST', url: '/', body: { title: 'Timesheet', remindAt: 'tomorrow' } }, 'body.remindAt');
    assert.match(res.body.error, /^remindAt is a date and time/);
});

test('a title that is not text is refused, not a 500 from .trim()', async () => {
    await refuses({ method: 'POST', url: '/', body: { title: 42, remindAt: WHEN } }, 'body.title');
});

test('a reminder without a title is refused in words, not with "Required"', async () => {
    const res = await refuses({ method: 'POST', url: '/', body: { remindAt: WHEN } }, 'body.title');
    assert.strictEqual(res.body.error, 'A reminder needs a title.');
});

test('what the phone\'s reminder sheet sends still creates the reminder, trimmed', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { title: '  Timesheet  ', remindAt: WHEN, repeatInterval: 'weekly' } });
    assert.strictEqual(res.statusCode, 200);
    const args = touched.find((t) => t.what === 'createReminder').args[0];
    assert.strictEqual(args.title, 'Timesheet');
    assert.strictEqual(args.remindAt, WHEN);
    assert.strictEqual(args.repeatInterval, 'weekly');
    assert.strictEqual(args.userId, 'u1');
});

test('"once" is null, as the sheet sends it', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { title: 'Call', remindAt: WHEN, repeatInterval: null } });
    assert.strictEqual(res.statusCode, 200);
});

// ═══ PUT /:id ════════════════════════════════════════════════════════

test('a misspelled field on update is refused, not answered 200 { success: false }', async () => {
    await refuses({ method: 'PUT', url: '/r1', body: { remind_at: WHEN } }, 'body');
});

test('an empty title on update is refused — POST would never have accepted it', async () => {
    await refuses({ method: 'PUT', url: '/r1', body: { title: '' } }, 'body.title');
});

test('snoozing — the one edit the phone makes — still moves the time', async () => {
    const res = await dispatch({ method: 'PUT', url: '/r1', body: { remindAt: WHEN } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'updateReminder').args[1].remindAt, WHEN);
});

// ═══ GET / ══════════════════════════════════════════════════════════

test('?completed=1 now includes the completed reminders, like ?completed=true', async () => {
    for (const url of ['/?completed=1', '/?completed=true']) {
        touched.length = 0;
        const res = await dispatch({ method: 'GET', url });
        assert.strictEqual(res.statusCode, 200, url);
        assert.deepStrictEqual(touched[0].args[1], { includeCompleted: true }, url);
    }
});

test('a word that is not a flag is refused, not read as "leave them out"', async () => {
    await refuses({ method: 'GET', url: '/?completed=yes' }, 'query.completed');
});

test('without a session it is still a 401, before any body is judged', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { title: 42 }, session: null });
    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(touched, []);
});
