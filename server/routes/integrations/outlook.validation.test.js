/**
 * What the Outlook routes accept, and what they say when they refuse
 * (routes/integrations/outlook.js).
 *
 * `?folder=` is CONCATENATED into the Graph path this server calls on the
 * caller's behalf (`/me/mailFolders/${folder}/messages?$top=…`), so a value
 * carrying a `/` or a `?` appended its own segments and query parameters to
 * that request. `replyToMessageId` lands in `/me/messages/${id}/reply` the
 * same way. And /send hands the whole body to outlookTools, which reads five
 * named keys — so a `bcc` misspelled `bbc` sent the mail to everyone EXCEPT
 * the blind copies, on a 200 reading `Email sent via Outlook`.
 *
 * Run: cd server && node --test routes/integrations/outlook.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every Graph call lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../../auth/permissions': { requireAuth: pass },
    '../../integrations/msGraphClient': {
        isMicrosoftConnected: () => true,
        graphFetch: async (path) => { touched.push({ what: 'graphFetch', args: [path] }); return { value: [] }; },
    },
    '../../integrations/outlookTools': {
        executeOutlookSend: async (d) => { touched.push({ what: 'send', args: [d] }); return { success: true }; },
        executeOutlookSaveDraft: async (d) => { touched.push({ what: 'draft', args: [d] }); return { success: true }; },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:integrations-outlook-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /integrations[\\/]outlook\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./outlook');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, query = {}, body = {} }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query, headers: {},
            session: { user: { id: 'u1' }, accessToken: 'tok', oauthProvider: 'microsoft' },
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

/** The draft outlookTools builds, minus whatever this test wants to break. */
const draft = (over = {}) => ({
    _provider: 'microsoft', to: 'ada@example.test', cc: null, bcc: 'audit@example.test',
    subject: 'Invoice', body: 'Attached.', replyToMessageId: null, conversationId: null,
    ...over,
});

test.beforeEach(() => { touched.length = 0; });

test('a folder carrying its own path or query cannot reach the Graph URL', async () => {
    for (const folder of ['inbox/messages?$top=999&x=', '../../users/someone', 'in box']) {
        const res = await dispatch({ method: 'GET', url: '/messages', query: { folder } });
        assert.strictEqual(res.statusCode, 400, `refused: ${folder}`);
        assert.ok(res.body.details.some((d) => d.path === 'query.folder'));
    }
    assert.deepStrictEqual(touched, [], 'Graph was never called');
});

test('a misspelled listing key is refused rather than dropped', async () => {
    const res = await dispatch({ method: 'GET', url: '/messages', query: { fulder: 'sentitems' } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => /fulder/.test(d.message)),
        `the refusal names the key it did not expect: ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, []);
});

test('a non-numeric page size is refused, not silently turned into 20', async () => {
    const res = await dispatch({ method: 'GET', url: '/messages', query: { top: 'all' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'top must be a number.');
    assert.deepStrictEqual(touched, []);
});

test('a page size above the ceiling is still clamped, not refused', async () => {
    const res = await dispatch({ method: 'GET', url: '/messages', query: { top: '500' } });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(/\$top=50&/.test(touched[0].args[0]), touched[0].args[0]);
});

test('the sent-items listing still reaches Graph, sorted by sentDateTime', async () => {
    const res = await dispatch({ method: 'GET', url: '/messages', query: { folder: 'sentitems', top: '20' } });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(touched[0].args[0].startsWith('/me/mailFolders/sentitems/messages'), touched[0].args[0]);
    assert.ok(/orderby=sentDateTime desc/.test(touched[0].args[0]));
});

test('a misspelled bcc is refused, instead of sending without the blind copy', async () => {
    const { bcc, ...rest } = draft();
    const res = await dispatch({ method: 'POST', url: '/send', body: { ...rest, bbc: bcc } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => /bbc/.test(d.message)),
        `the refusal names the key it did not expect: ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'nothing was sent');
});

test('a reply id that is not a Graph id cannot reach the reply URL', async () => {
    const res = await dispatch({ method: 'POST', url: '/send', body: draft({ replyToMessageId: '../../me/sendMail' }) });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'That is not an Outlook message id.');
    assert.deepStrictEqual(touched, []);
});

test('a recipient-less draft is refused here, instead of inside the tools layer', async () => {
    const res = await dispatch({ method: 'POST', url: '/send', body: draft({ to: '' }) });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'to is required — who the message goes to.');
    assert.deepStrictEqual(touched, []);
});

test("the card's own draft still sends and still saves", async () => {
    const sent = await dispatch({ method: 'POST', url: '/send', body: draft({ replyToMessageId: 'AAMkAGI2_x' }) });
    assert.strictEqual(sent.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'send').args[0].bcc, 'audit@example.test');

    touched.length = 0;
    const saved = await dispatch({ method: 'POST', url: '/draft', body: draft() });
    assert.strictEqual(saved.statusCode, 200);
    assert.ok(touched.some((t) => t.what === 'draft'));
});

test('a message id that is not a Graph id is refused before the read', async () => {
    const res = await dispatch({ method: 'GET', url: `/messages/${encodeURIComponent('../mailFolders')}` });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'That is not an Outlook message id.');
    assert.deepStrictEqual(touched, []);
});
