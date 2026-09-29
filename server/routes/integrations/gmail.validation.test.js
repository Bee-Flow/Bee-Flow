/**
 * What the Gmail routes accept, and what they say when they refuse
 * (routes/integrations/gmail.js).
 *
 * /send and /draft read nine named keys off the approval card's draft and
 * dropped everything else. A `bcc` misspelled `bbc` therefore sent the
 * message to everyone EXCEPT the blind copies, and answered
 * `{ success: true }` — the card turns green, the recipient list is wrong,
 * and nothing in the answer says a recipient went missing. On the read side
 * `pageSize` had a ceiling but no floor, and `label = 'INBOX'` is a
 * DESTRUCTURING default, which `?label=` does not trigger: the picker asking
 * for the INBOX was quietly answered with every label — Sent, Drafts,
 * Archive and the rest.
 *
 * Run: cd server && node --test routes/integrations/gmail.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every Gmail API call lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const gmailClient = {
    users: {
        messages: {
            list: async (p) => { touched.push({ what: 'list', args: [p] }); return { data: { messages: [] } }; },
            get: async (p) => {
                touched.push({ what: 'get', args: [p] });
                return { data: { id: p.id, threadId: 't1', payload: { headers: [] }, labelIds: [] } };
            },
            send: async (p) => { touched.push({ what: 'send', args: [p] }); return { data: { id: 'm1', threadId: 't1' } }; },
        },
        drafts: {
            create: async (p) => { touched.push({ what: 'draft', args: [p] }); return { data: { id: 'd1', message: { id: 'm1' } } }; },
        },
    },
};

const MOCKS = {
    '../../auth/permissions': { loadConfig: async () => ({ providers: {} }), requireAuth: pass },
    '../../integrations/googleClient': { createGoogleApiClient: async () => gmailClient },
    '../../services/email/parse': { extractTextBody: () => '', getGmailHeader: () => '' },
    '../../integrations/gmailTools': {
        buildRawMessage: (p) => { touched.push({ what: 'buildRawMessage', args: [p] }); return 'cmF3'; },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:integrations-gmail-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /integrations[\\/]gmail\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./gmail');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, query = {}, body = {} }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query, headers: {},
            session: { user: { id: 'u1', email: 'u1@example.test' }, accessToken: 'tok', oauthProvider: 'google' },
            get() { return undefined; },
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

/** The draft gmailTools builds, minus whatever this test wants to break. */
const draft = (over = {}) => ({
    to: 'ada@example.test', cc: null, bcc: 'audit@example.test', subject: 'Invoice',
    body: 'Attached.', replyToMessageId: null, threadId: null, inReplyTo: null, references: null,
    ...over,
});

test.beforeEach(() => { touched.length = 0; });

test('a misspelled bcc is refused, instead of sending without the blind copy', async () => {
    const { bcc, ...rest } = draft();
    const res = await dispatch({ method: 'POST', url: '/send', body: { ...rest, bbc: bcc } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => /bbc/.test(d.message)),
        `the refusal names the key it did not expect: ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'nothing was sent');
});

test('a misspelled threadId is refused rather than turning a reply into a new thread', async () => {
    const res = await dispatch({ method: 'POST', url: '/send', body: draft({ threadID: 't1' }) });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
});

test('a recipient of the wrong JSON type is refused by name, not treated as present', async () => {
    const res = await dispatch({ method: 'POST', url: '/send', body: draft({ to: 42 }) });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'to is required — who the message goes to.');
    assert.ok(res.body.details.some((d) => d.path === 'body.to'));
    assert.deepStrictEqual(touched, []);
});

test('the three old required fields are still required, in sentences', async () => {
    const res = await dispatch({ method: 'POST', url: '/send', body: { to: 'ada@example.test', subject: 'Hi' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'body is required — the message itself.');
    assert.deepStrictEqual(touched, []);
});

test("the card's own draft still sends, replyToMessageId accepted and unread", async () => {
    const res = await dispatch({ method: 'POST', url: '/send', body: draft({ replyToMessageId: 'm0', threadId: 't1' }) });
    assert.strictEqual(res.statusCode, 200);
    const built = touched.find((t) => t.what === 'buildRawMessage').args[0];
    assert.strictEqual(built.bcc, 'audit@example.test');
    assert.strictEqual(touched.find((t) => t.what === 'send').args[0].requestBody.threadId, 't1');
});

test('the same body still saves as a draft', async () => {
    const res = await dispatch({ method: 'POST', url: '/draft', body: draft() });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(touched.some((t) => t.what === 'draft'));
});

test('an empty label is refused, instead of listing every label', async () => {
    const res = await dispatch({ method: 'GET', url: '/messages', query: { label: '' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'label must be a Gmail label id.');
    assert.deepStrictEqual(touched, []);
});

test('a negative page size is refused rather than handed to the Gmail API', async () => {
    const res = await dispatch({ method: 'GET', url: '/messages', query: { pageSize: '-5' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'pageSize must be at least 1.');
    assert.deepStrictEqual(touched, []);
});

test('a page size above the ceiling is still clamped, not refused', async () => {
    const res = await dispatch({ method: 'GET', url: '/messages', query: { pageSize: '500' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'list').args[0].maxResults, 50);
});

test("the picker's own listing still reaches Gmail, defaulting to the inbox", async () => {
    const res = await dispatch({ method: 'GET', url: '/messages', query: { query: 'invoice', pageSize: '20' } });
    assert.strictEqual(res.statusCode, 200);
    const args = touched.find((t) => t.what === 'list').args[0];
    assert.deepStrictEqual(args.labelIds, ['INBOX']);
    assert.strictEqual(args.q, 'invoice');
    assert.strictEqual(args.maxResults, 20);
});

test('a message id that is not one is refused before it reaches the Gmail API', async () => {
    const res = await dispatch({ method: 'GET', url: `/messages/${encodeURIComponent('../labels')}` });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'That is not a Gmail message id.');
    assert.deepStrictEqual(touched, []);
});
