/**
 * What the token-vault routes accept, and what they say when they refuse
 * (routes/piiVault.js).
 *
 * The vault is the reverse dictionary of a user's Privacy Shield, and two of
 * its silent fallbacks were about exactly that data: `DELETE /?id=<entry>` —
 * the single-entry delete with its id in the wrong place — emptied the whole
 * vault, and `GET /?serach=jan` answered with every decrypted entry instead of
 * the ones matching a name. What this file pins is the part a caller can act on:
 *
 *   - the 400 NAMES the field (`query.search`), not just "invalid request";
 *   - the message is a sentence;
 *   - the store is never reached, so a refused request reads and deletes nothing.
 *
 * Run: cd server && node --test routes/piiVault.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store call lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../stores/piiVaultStore': {
        MAX_ENTRIES_PER_USER: 20000,
        listForUser: async (userId, opts) => { touched.push({ what: 'listForUser', args: [userId, opts] }); return { entries: [], total: 0 }; },
        deleteEntry: async (userId, id) => { touched.push({ what: 'deleteEntry', args: [userId, id] }); return true; },
        clearForUser: async (userId) => { touched.push({ what: 'clearForUser', args: [userId] }); return 3; },
    },
    '../stores/userStore': { logAccessAudit: () => {} },
    '../auth/permissions': { requireAuth: pass },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:pii-vault-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]piiVault\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./piiVault');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ method, url, body }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method, url, originalUrl: url, path: pathname, body, query, headers: {},
            session: { user: { id: 'u1', organizationId: 'org1' } }, get() { return undefined; },
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
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the vault');
    return res;
}

// ═══ DELETE / — the whole vault ═════════════════════════════════════

test('an entry id in the query of the wipe-all route is refused, not read as "delete everything"', async () => {
    await refuses({ method: 'DELETE', url: '/?id=entry-1' }, 'query');
});

test('an entry id in the body of the wipe-all route is refused too', async () => {
    await refuses({ method: 'DELETE', url: '/', body: { id: 'entry-1' } }, 'body');
});

test('emptying the vault the way the settings screen does still works', async () => {
    const res = await dispatch({ method: 'DELETE', url: '/' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { ok: true, removed: 3 });
    assert.deepStrictEqual(touched.map((t) => t.what), ['clearForUser']);
});

test('deleting one entry by its path still deletes that one entry', async () => {
    const res = await dispatch({ method: 'DELETE', url: '/entry-1' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched, [{ what: 'deleteEntry', args: ['u1', 'entry-1'] }]);
});

// ═══ GET / ══════════════════════════════════════════════════════════

test('a misspelled search is refused, not answered with the whole decrypted vault', async () => {
    await refuses({ method: 'GET', url: '/?serach=jan' }, 'query');
});

test('a negative limit is refused in words instead of reaching the store as a 500', async () => {
    const res = await refuses({ method: 'GET', url: '/?limit=-5' }, 'query.limit');
    assert.strictEqual(res.body.error, 'limit must be at least 1.');
});

test('a limit that is not a number is refused in words', async () => {
    const res = await refuses({ method: 'GET', url: '/?limit=veel' }, 'query.limit');
    assert.strictEqual(res.body.error, 'limit must be a number.');
});

test('a search longer than the vault searches is refused rather than cut short', async () => {
    const res = await refuses({ method: 'GET', url: `/?search=${'a'.repeat(201)}` }, 'query.search');
    assert.strictEqual(res.body.error, 'A vault search is at most 200 characters.');
});

test('the query the settings screen sends still pages and searches', async () => {
    const res = await dispatch({ method: 'GET', url: '/?limit=100&offset=100&search=jan' });
    assert.strictEqual(res.statusCode, 200);
    const [userId, opts] = touched.find((t) => t.what === 'listForUser').args;
    assert.strictEqual(userId, 'u1');
    assert.strictEqual(opts.limit, 100);
    assert.strictEqual(opts.offset, 100);
    assert.strictEqual(opts.search, 'jan');
});

test('a limit above the ceiling is answered at the ceiling, and the answer says so', async () => {
    const res = await dispatch({ method: 'GET', url: '/?limit=900' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.limit, 500);
    assert.strictEqual(touched.find((t) => t.what === 'listForUser').args[1].limit, 500);
});
