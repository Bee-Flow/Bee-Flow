/**
 * What the calendar approval card may post back, and what it says when it
 * refuses (routes/integrations/calendar.js).
 *
 * `_provider` picks the calendar, and it was read as `=== 'microsoft'`, so
 * every other spelling fell through to GOOGLE. `_provider: 'Microsoft'` —
 * one capital — took a draft the user had approved in Outlook and handed it
 * to the Google executor, under a 200. What this file pins is that the
 * provider and the action are both named values now, and that a refused
 * request reaches neither executor.
 *
 * Run: cd server && node --test routes/integrations/calendar.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every executor call lands in `touched`. A refused request must leave it empty.
const touched = [];

const MOCKS = {
    '../../integrations/calendarTools': {
        executeCalendarAction: async (a) => { touched.push({ what: 'google', args: [a] }); return { ok: 'google' }; },
    },
    '../../integrations/msCalendarTools': {
        executeMsCalendarAction: async (verb, a) => { touched.push({ what: 'microsoft', args: [verb, a] }); return { ok: 'microsoft' }; },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:integrations-calendar-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /integrations[\\/]calendar\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./calendar');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, body = {}, session = { accessToken: 'tok', user: { id: 'u1' } } }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query: {}, headers: {},
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

const MS_DELETE = { action: 'delete', _provider: 'microsoft', eventId: 'evt_1', title: 'Standup' };

test.beforeEach(() => { touched.length = 0; });

test('a mis-cased provider is refused, instead of running the draft against Google', async () => {
    const res = await dispatch({ method: 'POST', url: '/execute', body: { ...MS_DELETE, _provider: 'Microsoft' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, '_provider is google or microsoft.');
    assert.ok(res.body.details.some((d) => d.path === 'body._provider'));
    assert.deepStrictEqual(touched, [], 'neither calendar was touched');
});

test('a misspelled provider KEY is refused rather than silently meaning Google', async () => {
    const { _provider, ...rest } = MS_DELETE;
    const res = await dispatch({ method: 'POST', url: '/execute', body: { ...rest, _providr: _provider } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/_providr/.test(res.body.error), `the 400 names the key: ${res.body.error}`);
    assert.deepStrictEqual(touched, []);
});

test('an unknown action is answered in words, not with a 500 from the executor', async () => {
    const res = await dispatch({ method: 'POST', url: '/execute', body: { ...MS_DELETE, action: 'cancel' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'action is create, update or delete.');
    assert.deepStrictEqual(touched, []);
});

test('a missing action is refused in words, not with "Required"', async () => {
    const res = await dispatch({ method: 'POST', url: '/execute', body: { eventId: 'evt_1' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'action is create, update or delete.');
    assert.deepStrictEqual(touched, []);
});

test('a delete without the event it deletes is refused, not sent to the calendar', async () => {
    const res = await dispatch({ method: 'POST', url: '/execute', body: { action: 'delete', _provider: 'microsoft' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'eventId says which event to change.');
    assert.deepStrictEqual(touched, []);
});

test('the Microsoft card still reaches the Microsoft executor, verb first', async () => {
    const res = await dispatch({ method: 'POST', url: '/execute', body: MS_DELETE });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched[0].what, 'microsoft');
    assert.strictEqual(touched[0].args[0], 'delete');
});

test("the Google card — which carries no _provider — still reaches Google's executor", async () => {
    const draft = {
        action: 'create', title: 'Review', startTime: '2026-10-01T09:00:00Z', endTime: '2026-10-01T10:00:00Z',
        timeZone: 'Europe/Amsterdam', description: null, location: null, attendees: null,
        allDay: false, addGoogleMeet: true,
    };
    const res = await dispatch({ method: 'POST', url: '/execute', body: draft });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched[0].what, 'google');
    assert.deepStrictEqual(touched[0].args[0], draft);
});

test('an unauthenticated caller still reads 401, not a 400 about its body', async () => {
    const res = await dispatch({ method: 'POST', url: '/execute', body: { action: 'nonsense' }, session: {} });
    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(touched, []);
});
