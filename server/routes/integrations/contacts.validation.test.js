/**
 * What the contacts approval card may post back, and what it says when it
 * refuses (routes/integrations/contacts.js).
 *
 * This is the sharpest edge of the `_provider === 'microsoft'` fall-through,
 * because the two executors read DIFFERENT field names. A Microsoft draft
 * (givenName/surname/emailAddress) that landed in the Google executor was
 * built from `action.firstName`, which it does not have — so the address book
 * got a contact with no name and no address, and the caller got a 200 reading
 * `Contact "undefined" created!`.
 *
 * Run: cd server && node --test routes/integrations/contacts.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every executor call lands in `touched`. A refused request must leave it empty.
const touched = [];

const MOCKS = {
    '../../integrations/contactsTools': {
        executeContactsAction: async (a) => {
            touched.push({ what: 'google', args: [a] });
            return { success: true, message: `Contact "${a.firstName} ${a.lastName || ''}" created!` };
        },
    },
    '../../integrations/msContactsTools': {
        executeMsContactsAction: async (verb, a) => { touched.push({ what: 'microsoft', args: [verb, a] }); return { success: true }; },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:integrations-contacts-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /integrations[\\/]contacts\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./contacts');
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

// Exactly what msContactsTools builds for ms_contacts_create.
const MS_CREATE = {
    action: 'create', _provider: 'microsoft', givenName: 'Ada', surname: 'Lovelace',
    emailAddress: 'ada@example.test', phone: null, companyName: null, jobTitle: null,
};

test.beforeEach(() => { touched.length = 0; });

test('a mis-cased provider is refused, instead of creating an empty Google contact', async () => {
    const res = await dispatch({ method: 'POST', url: '/execute', body: { ...MS_CREATE, _provider: 'Microsoft' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, '_provider is google or microsoft.');
    assert.deepStrictEqual(touched, [], 'neither address book was touched');
});

test('a misspelled provider KEY is refused rather than silently meaning Google', async () => {
    const { _provider, ...rest } = MS_CREATE;
    const res = await dispatch({ method: 'POST', url: '/execute', body: { ...rest, provider: _provider } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/provider/.test(res.body.error), `the 400 names the key: ${res.body.error}`);
    assert.deepStrictEqual(touched, []);
});

test('an unknown action is answered in words, not with a 500 from the executor', async () => {
    const res = await dispatch({ method: 'POST', url: '/execute', body: { ...MS_CREATE, action: 'delete' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'action is create or update.');
    assert.deepStrictEqual(touched, []);
});

test('a misspelled field name is refused instead of writing a contact without it', async () => {
    const res = await dispatch({
        method: 'POST', url: '/execute',
        body: { action: 'create', firstName: 'Ada', emailAdress: 'ada@example.test' },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/emailAdress/.test(res.body.error), `the 400 names the key: ${res.body.error}`);
    assert.deepStrictEqual(touched, []);
});

test('the Microsoft card still reaches the Microsoft executor, verb first', async () => {
    const res = await dispatch({ method: 'POST', url: '/execute', body: MS_CREATE });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched[0].what, 'microsoft');
    assert.strictEqual(touched[0].args[0], 'create');
    assert.strictEqual(touched[0].args[1].givenName, 'Ada');
});

test("the Google card — which carries no _provider — still reaches Google's executor", async () => {
    const draft = {
        action: 'create', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test',
        phone: null, company: null, jobTitle: null, notes: null,
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
