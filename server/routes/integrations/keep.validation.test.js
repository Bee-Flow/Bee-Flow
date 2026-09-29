/**
 * What the Keep approval card may post back, and what it says when it refuses
 * (routes/integrations/keep.js).
 *
 * `type` decided what the note became, through
 * `action.type === 'list' && action.listItems`. Any other value — or the key
 * simply dropped — took the text branch, so an approved CHECKLIST was created
 * as a note whose body was `action.content || ''`, i.e. empty, and the card
 * turned green on `Note "…" created!`. The items were never written and
 * nothing said so.
 *
 * Run: cd server && node --test routes/integrations/keep.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every executor call lands in `touched`. A refused request must leave it empty.
const touched = [];

const MOCKS = {
    '../../integrations/keepTools': {
        executeKeepAction: async (a) => { touched.push({ what: 'executeKeepAction', args: [a] }); return { success: true }; },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:integrations-keep-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /integrations[\\/]keep\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./keep');
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

const LIST = {
    action: 'create', title: 'Groceries', type: 'list',
    listItems: [{ text: 'Coffee', checked: false }, { text: 'Bread', checked: false }],
};

test.beforeEach(() => { touched.length = 0; });

test('a mis-cased type is refused, instead of writing the checklist out as an empty note', async () => {
    const res = await dispatch({ method: 'POST', url: '/execute', body: { ...LIST, type: 'List' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'type is text or list.');
    assert.ok(res.body.details.some((d) => d.path === 'body.type'));
    assert.deepStrictEqual(touched, [], 'nothing was written to Keep');
});

test('a misspelled listItems is refused rather than turning the note empty', async () => {
    const { listItems, ...rest } = LIST;
    const res = await dispatch({ method: 'POST', url: '/execute', body: { ...rest, listitems: listItems } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/listitems/.test(res.body.error), `the 400 names the key: ${res.body.error}`);
    assert.deepStrictEqual(touched, []);
});

test('a checklist with no items is refused, not created empty', async () => {
    const { listItems, ...rest } = LIST;
    const res = await dispatch({ method: 'POST', url: '/execute', body: rest });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A checklist needs its items.');
    assert.deepStrictEqual(touched, []);
});

test('a delete without the note it deletes is refused', async () => {
    const res = await dispatch({ method: 'POST', url: '/execute', body: { action: 'delete', title: 'Groceries' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'noteId says which note to delete.');
    assert.deepStrictEqual(touched, []);
});

test('an unknown action is answered in words, not with a 500 from the executor', async () => {
    const res = await dispatch({ method: 'POST', url: '/execute', body: { action: 'update', title: 'x' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'action is create or delete.');
    assert.deepStrictEqual(touched, []);
});

test('the checklist card keepTools builds still reaches the executor intact', async () => {
    const res = await dispatch({ method: 'POST', url: '/execute', body: LIST });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched[0].args[0], LIST);
});

test('the plain-text card still reaches the executor intact', async () => {
    const draft = { action: 'create', title: 'Idea', type: 'text', content: 'Try the other thing' };
    const res = await dispatch({ method: 'POST', url: '/execute', body: draft });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched[0].args[0], draft);
});

test('an unauthenticated caller still reads 401, not a 400 about its body', async () => {
    const res = await dispatch({ method: 'POST', url: '/execute', body: { action: 'nonsense' }, session: {} });
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.body.error, 'Not authenticated with Google');
    assert.deepStrictEqual(touched, []);
});
