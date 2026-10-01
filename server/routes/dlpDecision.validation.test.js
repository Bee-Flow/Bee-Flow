/**
 * What the DLP decision route accepts, and what it says when it refuses
 * (routes/dlpDecision.js).
 *
 * Two fields used to be read in a way that let personal data out of a
 * conversation the person was protecting:
 *
 *   - `rememberForConversation: "false"` — the STRING — was read as `!!value`,
 *     i.e. yes. A remembered 'allow' makes every later message in the
 *     conversation skip the question and go out raw;
 *   - a manual mark with `offset: "12"` was dropped without a word, and the
 *     redaction went ahead without it: the marked text left unredacted under
 *     a 200 `{ ok: true }`.
 *
 * What this file pins:
 *
 *   - the 400 NAMES the field (`body.rememberForConversation`);
 *   - the message is a sentence, including for a field simply left out;
 *   - a refused decision never reaches the queue, so the stream keeps
 *     waiting and times out as a block — the fail-closed answer.
 *
 * Run: cd server && node --test routes/dlpDecision.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every queue call lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../core/dlp/decisionQueue': {
        resolve: (id, decision, userId) => { touched.push({ what: 'resolve', args: [id, decision, userId] }); return id === 'dec-1'; },
        touch: (id, userId) => { touched.push({ what: 'touch', args: [id, userId] }); return id === 'dec-1'; },
    },
    '../auth/permissions': { requireAuth: pass },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:dlp-decision-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]dlpDecision\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./dlpDecision');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ body, url = '/' }) {
    return new Promise((resolve, reject) => {
        const req = {
            method: 'POST', url, originalUrl: url, path: url, body, query: {}, headers: {},
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
            if (!err) return reject(new Error('fell through: POST /'));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { touched.length = 0; });

test('"false" as text is refused, instead of remembering an allow for the whole conversation', async () => {
    const res = await dispatch({ body: { decisionId: 'dec-1', choice: 'allow', rememberForConversation: 'false' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'rememberForConversation is true or false.');
    assert.ok(res.body.details.some((d) => d.path === 'body.rememberForConversation'));
    assert.deepStrictEqual(touched, [], 'the stream keeps waiting — nothing was resolved');
});

test('a mark whose offset is text is refused, instead of redacting without it', async () => {
    const res = await dispatch({
        body: { decisionId: 'dec-1', choice: 'redact', manualAdditions: [{ offset: '12', length: 5 }] },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.manualAdditions.0.offset'));
    assert.deepStrictEqual(touched, []);
});

test('more marks than the cap are refused rather than cut to the first 200', async () => {
    const marks = Array.from({ length: 201 }, (_, i) => ({ offset: i * 2, length: 1 }));
    const res = await dispatch({ body: { decisionId: 'dec-1', choice: 'redact', manualAdditions: marks } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.manualAdditions'));
    assert.deepStrictEqual(touched, []);
});

test('marks under a misspelled key are refused, instead of redacting with none of them', async () => {
    const res = await dispatch({
        body: { decisionId: 'dec-1', choice: 'redact', manualAddition: [{ offset: 12, length: 5 }] },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/manualAddition/.test(res.body.error), `the 400 names the key: ${res.body.error}`);
    assert.deepStrictEqual(touched, [], 'the text the person marked is not sent unredacted');
});

test('a mark carrying its own text is refused — only offset and length are read', async () => {
    const res = await dispatch({
        body: { decisionId: 'dec-1', choice: 'redact', manualAdditions: [{ offset: 0, length: 5, text: 'other' }] },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
});

test('a missing decision id and a misspelled choice are each refused in words', async () => {
    let res = await dispatch({ body: { choice: 'redact' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'decisionId is the id of the decision the chat is waiting on.');

    res = await dispatch({ body: { decisionId: 'dec-1', choice: 'Redact' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'choice is "redact", "block" or "allow".');

    res = await dispatch({ body: undefined });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Send the decision as { decisionId, choice }.');
    assert.deepStrictEqual(touched, []);
});

test('the web modal\'s body still resolves the decision, marks and all', async () => {
    const res = await dispatch({
        body: { decisionId: 'dec-1', choice: 'redact', rememberForConversation: true, manualAdditions: [{ offset: 3, length: 4 }] },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { ok: true });
    assert.deepStrictEqual(touched, [{
        what: 'resolve',
        args: ['dec-1', { choice: 'redact', rememberForConversation: true, manualAdditions: [{ offset: 3, length: 4 }] }, 'u1'],
    }]);
});

test('the phone\'s body — no marks — resolves with an empty list and "remember" only when it is true', async () => {
    const res = await dispatch({ body: { decisionId: 'dec-1', choice: 'block', rememberForConversation: false } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched[0].args[1], { choice: 'block', rememberForConversation: false, manualAdditions: [] });
});

test('an unknown decision is still a 404 once the body is well-formed', async () => {
    const res = await dispatch({ body: { decisionId: 'dec-gone', choice: 'allow' } });
    assert.strictEqual(res.statusCode, 404);
});

test('POST /touch heartbeats a pending decision with the caller\'s user id', async () => {
    const res = await dispatch({ url: '/touch', body: { decisionId: 'dec-1' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { ok: true });
    assert.deepStrictEqual(touched, [{ what: 'touch', args: ['dec-1', 'u1'] }]);
});

test('POST /touch is a 404 once the decision is gone, and refuses a malformed body', async () => {
    let res = await dispatch({ url: '/touch', body: { decisionId: 'dec-gone' } });
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.body.error, 'Decision not found, expired, or not owned by this user.');

    res = await dispatch({ url: '/touch', body: { decisionId: 'dec-1', choice: 'allow' } });
    assert.strictEqual(res.statusCode, 400, 'a touch carrying a choice is refused, not silently read as a decision');
    assert.deepStrictEqual(touched, [{ what: 'touch', args: ['dec-gone', 'u1'] }], 'only the well-formed beats reached the queue');
});
