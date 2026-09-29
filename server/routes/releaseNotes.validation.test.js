/**
 * What the release-notes routes accept, and what they say when they refuse
 * (routes/releaseNotes.js).
 *
 * Both bodies were destructured with defaults, and the defaults filed things
 * in the wrong place: `{"chanel": "prod"}` became a dev ingest that rewrote the
 * rolling Unreleased entry instead of freezing the release, a misspelled field
 * on the admin PUT answered `{ success: true }` over an untouched row, and
 * items went into the changelog verbatim — an item of kind "Feature" vanished
 * from the admin panel and went public under "Fixed". What this file pins:
 *
 *   - the 400 NAMES the field (`body.items.0.kind`), not just "invalid request";
 *   - the message is a sentence;
 *   - the store is never reached, so a refused request files nothing;
 *   - the CI payload and the panel's edits still pass, and the ingest token is
 *     still checked before the body.
 *
 * Run: cd server && node --test routes/releaseNotes.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.RELEASE_NOTES_TOKEN = 'release-notes-validation-token';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store write lands in `touched`. A refused request must leave it empty.
const touched = [];

const MOCKS = {
    '../stores/releaseNotesStore': {
        upsertUnreleased: async (p) => { touched.push({ what: 'upsertUnreleased', args: [p] }); return { id: 'e1', ...p }; },
        finaliseRelease: async (p) => { touched.push({ what: 'finaliseRelease', args: [p] }); return { id: 'e1', ...p }; },
        updateEntry: async (id, p) => { touched.push({ what: 'updateEntry', args: [id, p] }); return { id, ...p }; },
        listPublished: async () => [],
        listAll: async () => [],
    },
    '../core/releaseNotesDrafter': {
        draftReleaseNotes: async () => { touched.push({ what: 'draftReleaseNotes' }); return { title: 'T', lead: 'L', items: [] }; },
    },
    './cmsShared': { requireAdmin: (req, res, next) => next() },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:release-notes-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]releaseNotes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./releaseNotes');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

const BEARER = `Bearer ${process.env.RELEASE_NOTES_TOKEN}`;

function dispatch({ method, url, body, authorization }) {
    return new Promise((resolve, reject) => {
        const headers = authorization ? { authorization } : {};
        const req = {
            method, url, originalUrl: url, path: url, body, query: {}, headers,
            session: { user: { id: 'admin' } }, get(name) { return headers[String(name).toLowerCase()]; },
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

async function refuses(request, field) {
    const res = await dispatch(request);
    assert.strictEqual(res.statusCode, 400, `${request.method} ${request.url} -> ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the changelog');
    return res;
}

// ═══ POST /ingest ════════════════════════════════════════════════════

test('a misspelled channel is refused, not filed as a dev build over the Unreleased entry', async () => {
    await refuses({
        method: 'POST', url: '/ingest', authorization: BEARER,
        body: { chanel: 'prod', version: 'prod-2026.09.22-1', commitSubjects: 'feat: x' },
    }, 'body');
});

test('a channel with a capital is refused in the words this route always used', async () => {
    const res = await refuses({ method: 'POST', url: '/ingest', authorization: BEARER, body: { channel: 'Prod' } }, 'body.channel');
    assert.strictEqual(res.body.error, 'channel must be "dev" or "prod"');
});

test('the payload the CI job builds with jq still files a draft', async () => {
    const res = await dispatch({
        method: 'POST', url: '/ingest', authorization: BEARER,
        body: {
            channel: 'dev', version: null,
            commitSubjects: 'feat: x\nfix: y', prTitles: 'Merge #1', diffstat: ' 2 files changed',
            services: 'server,agent-hub', fromSha: '', toSha: 'abc123',
            entry: { title: 'Drafted in CI', lead: 'Lead', items: [{ kind: 'fix', title: 'A', body: 'B' }] },
        },
    });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.draftedBy, 'ci');
    assert.strictEqual(touched.find((t) => t.what === 'upsertUnreleased').args[0].services, 'server,agent-hub');
});

test('the token is still checked before the body is judged', async () => {
    const res = await dispatch({ method: 'POST', url: '/ingest', authorization: 'Bearer nope', body: { chanel: 'prod' } });
    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(touched, []);
});

// ═══ PUT /admin/:id ══════════════════════════════════════════════════

test('a misspelled field is refused, not answered "success" over an untouched row', async () => {
    await refuses({ method: 'PUT', url: '/admin/e1', body: { titel: 'New headline' } }, 'body');
});

test('an empty edit is refused', async () => {
    const res = await refuses({ method: 'PUT', url: '/admin/e1', body: {} }, 'body');
    assert.strictEqual(res.body.error, 'Say what to change: title, lead, items or version.');
});

test('an emptied version is refused, not turned into the rolling Unreleased entry', async () => {
    for (const version of ['', '   ', null]) {
        const res = await refuses({ method: 'PUT', url: '/admin/e1', body: { version } }, 'body.version');
        assert.match(res.body.error, /^A version can be renamed, not emptied/);
    }
});

test('a version can still be renamed', async () => {
    const res = await dispatch({ method: 'PUT', url: '/admin/e1', body: { version: ' prod-2026.09.23-1 ' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'updateEntry').args[1].version, 'prod-2026.09.23-1');
});

test('an item of a kind the changelog does not group is refused, not published under "Fixed"', async () => {
    const res = await refuses({
        method: 'PUT', url: '/admin/e1', body: { items: [{ kind: 'Feature', title: 'Dark mode', body: '' }] },
    }, 'body.items.0.kind');
    assert.strictEqual(res.body.error, 'Each item\'s kind is one of: feature, improvement, fix.');
});

test('the panel\'s headline and lead edits still save', async () => {
    const res = await dispatch({ method: 'PUT', url: '/admin/e1', body: { title: 'New headline' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'updateEntry').args[1].title, 'New headline');
});

test('items in the stored shape still save', async () => {
    const items = [{ kind: 'feature', title: 'Dark mode', body: 'Easier on the eyes.' }];
    const res = await dispatch({ method: 'PUT', url: '/admin/e1', body: { items } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'updateEntry').args[1].items, items);
});
