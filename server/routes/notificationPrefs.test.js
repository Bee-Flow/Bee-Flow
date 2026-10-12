/**
 * routes/notificationPrefs.js: who may call it, what it accepts, what it answers.
 *
 * Run: cd server && node --test routes/notificationPrefs.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const touched = [];
const EVENTS = ['chat_mention', 'comment_mention', 'added', 'role_changed', 'removed', 'left', 'owner_changed', 'task_assigned'];
const MOCKS = {
    '../stores/notificationPrefsStore': {
        EVENTS,
        getPrefs: async (userId) => { touched.push({ what: 'getPrefs', args: [userId] }); return { bell: {}, email: {} }; },
        setPrefs: async (userId, partial) => { touched.push({ what: 'setPrefs', args: [userId, partial] }); },
    },
};
// Dependencies are injected by patching the exports the router reads (restored after the run); no module-system hooks.
const patched = [];
function inject(request, overrides) {
    const real = require(request);
    for (const [key, value] of Object.entries(overrides)) {
        patched.push([real, key, real[key]]);
        real[key] = value;
    }
}
for (const [request, exportsObj] of Object.entries(MOCKS)) inject(request, exportsObj);

const router = require('./notificationPrefs');
test.after(() => { for (const [mod, key, orig] of patched.reverse()) mod[key] = orig; });

const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ method, body, session = { user: { id: 'u1' } } }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url: '/', originalUrl: '/', path: '/', body, query: {}, headers: {},
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
            if (!err) return reject(new Error(`fell through: ${method}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { touched.length = 0; });

test('an anonymous caller gets 401 and the store is not touched', async () => {
    assert.strictEqual((await dispatch({ method: 'GET', session: {} })).statusCode, 401);
    assert.strictEqual((await dispatch({ method: 'PUT', body: {}, session: {} })).statusCode, 401);
    assert.deepStrictEqual(touched, []);
});

test('GET answers my preferences', async () => {
    const res = await dispatch({ method: 'GET' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { bell: {}, email: {} });
    assert.deepStrictEqual(touched[0].args, ['u1']);
});

test('PUT stores the given keys for me and answers the merged preferences', async () => {
    const res = await dispatch({ method: 'PUT', body: { email: { role_changed: true } } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.map((t) => t.what), ['setPrefs', 'getPrefs']);
    assert.deepStrictEqual(touched[0].args, ['u1', { bell: undefined, email: { role_changed: true } }]);
});

test('unknown channels and events, and non-booleans, are refused before the store', async () => {
    for (const body of [
        { sms: { added: true } },
        { bell: { fireworks: true } },
        { bell: { added: 'yes' } },
        { userId: 'someone-else', bell: {} },
    ]) {
        const res = await dispatch({ method: 'PUT', body });
        assert.strictEqual(res.statusCode, 400, JSON.stringify(body));
    }
    assert.deepStrictEqual(touched, []);
});
