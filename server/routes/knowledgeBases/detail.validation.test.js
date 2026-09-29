/**
 * What the single-KB routes accept, and what they say when they refuse
 * (routes/knowledgeBases/detail.js).
 *
 * The publish route read its body with `!!isPublished`, so the STRING
 * "false" published a knowledge base to the whole organisation, and a body
 * that left the flag out unpublished it. A shared-group list of one blank
 * entry lost that entry to `filter(Boolean)` and arrived as `[]` — which on a
 * knowledge base means everyone in the organisation. The settings route
 * filtered unknown usage contexts away and answered 200 with nothing changed.
 * What this file pins:
 *
 *   - the 400 NAMES the field (`body.isPublished`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - the store is never reached, so a refused request changes nothing.
 *
 * Run: cd server && node --test routes/knowledgeBases/detail.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const { SURFACES } = require('../../core/kb/usageContexts');

// Every store call that writes lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();
const KB = { id: 'kb1', tenant_id: 'u1', name: 'Handbook', organization_id: 'orgA' };

const MOCKS = {
    '../../stores/knowledgeBases': {
        getKB: async (id) => (id === KB.id ? { ...KB } : null),
        listDocuments: async () => [],
        countDocumentsByStatus: async () => ({ documentCount: 0, documentCountAll: 0, totalChunks: 0 }),
        updateKB: async (id, patch) => { touched.push({ what: 'updateKB', args: [id, patch] }); return { ...KB, ...patch }; },
        setPublished: async (id, isPublished, groups) => { touched.push({ what: 'setPublished', args: [id, isPublished, groups] }); return { ...KB }; },
        snapshotKBVersion: async () => {},
        deleteKB: async (id) => { touched.push({ what: 'deleteKB', args: [id] }); },
    },
    '../../auth': {
        requireAuth: pass,
        requirePermission: () => pass,
        validateSharedGroupsForOrg: async (orgId, groups) => {
            touched.push({ what: 'validateSharedGroupsForOrg', args: [orgId, groups] });
            return groups === undefined || groups === null ? undefined : groups;
        },
        assertUserCanUseOrg: async (req, orgId) => orgId,
    },
    './shared': {
        getUserId: (req) => req.session?.user?.id || null,
        canAccessKB: async () => true,
        canManageKB: async () => true,
        blockIfSystemKB: () => false,
        sanitizeUsageContexts: (v) => (Array.isArray(v) && v.length ? Array.from(new Set(v)) : null),
        VALID_USAGE_CONTEXTS: new Set(SURFACES),
    },
    '../../stores/kbSources': { countsByKb: async () => ({}) },
    '../../core/kb/kbUsage': {
        usageForKb: async () => ({ rows: [{ kind: 'agent', id: 'a1' }], partial: [] }),
        scrubReferences: async () => ({}),
    },
    '../../core/kb/resolveProvider': { resolveKbProvider: async () => 'local' },
    '../../core/kb/localKBIngest': { deleteChunksLocally: async () => {} },
    '../../stores/datatableStore': { purgeUsageFor: async () => 0 },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:kb-detail-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /knowledgeBases[\\/]detail\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./detail');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, body }) {
    const [pathname, search = ''] = url.split('?');
    const query = Object.fromEntries(new URLSearchParams(search));
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: pathname, body, query, headers: {},
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
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

const refusedAt = (res, path) => {
    assert.strictEqual(res.statusCode, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.ok(res.body.details.some((d) => d.path === path), `the refusal names ${path}: ${JSON.stringify(res.body.details)}`);
    assert.notStrictEqual(res.body.error, 'Required', 'the caller reads a sentence, not zod\'s bare word');
    assert.deepStrictEqual(touched, [], 'a refused request reaches no store');
};

test.beforeEach(() => { touched.length = 0; });

// ── PATCH /:id/publish ──────────────────────────────────────────────

test('publish: the STRING "false" is refused instead of publishing to the organisation', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/kb1/publish', body: { isPublished: 'false' } });
    refusedAt(res, 'body.isPublished');
});

test('publish: a body without isPublished is refused instead of unpublishing', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/kb1/publish', body: { sharedGroups: ['g1'] } });
    refusedAt(res, 'body.isPublished');
    assert.match(res.body.error, /isPublished is true or false/);
});

test('publish: no body at all is a 400 in words, not a TypeError 500', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/kb1/publish', body: undefined });
    refusedAt(res, 'body.isPublished');
});

test('publish: a blank group is refused rather than dropped into "the whole organisation"', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/kb1/publish', body: { isPublished: true, sharedGroups: [''] } });
    refusedAt(res, 'body.sharedGroups.0');
});

test('publish: a misspelled sharedGroups is refused rather than ignored', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/kb1/publish', body: { isPublished: true, sharedGroup: ['g1'] } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
});

test('publish: an explicit empty list still means the whole organisation', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/kb1/publish', body: { isPublished: true, sharedGroups: [] } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'setPublished').args, ['kb1', true, []]);
});

test('publish: unpublishing leaves the groups as they are', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/kb1/publish', body: { isPublished: false } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'setPublished').args, ['kb1', false, undefined]);
});

// ── PATCH /:id ──────────────────────────────────────────────────────

test('settings: an unknown usage context is refused by name, not filtered into a no-op 200', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/kb1', body: { usageContexts: ['agnet'] } });
    refusedAt(res, 'body.usageContexts.0');
    assert.match(res.body.error, /usage context is one of/);
});

test('settings: an empty usage-context list is refused — the store never wrote one', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/kb1', body: { usageContexts: [] } });
    refusedAt(res, 'body.usageContexts');
});

test('settings: a blank categoryId is refused; null still clears the category', async () => {
    refusedAt(await dispatch({ method: 'PATCH', url: '/kb1', body: { categoryId: '' } }), 'body.categoryId');
    const res = await dispatch({ method: 'PATCH', url: '/kb1', body: { categoryId: null } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'updateKB').args[1].categoryId, null);
});

test('settings: a blank name is refused; a name is trimmed once, by the schema', async () => {
    refusedAt(await dispatch({ method: 'PATCH', url: '/kb1', body: { name: '   ' } }), 'body.name');
    const res = await dispatch({ method: 'PATCH', url: '/kb1', body: { name: '  Handboek  ' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'updateKB').args[1].name, 'Handboek');
});

test('settings: a publish flag sent to the settings route is refused, not silently ignored', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/kb1', body: { name: 'X', isPublished: true } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
});

test('settings: the known contexts pass and reach the store', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/kb1', body: { usageContexts: ['agent', 'ai_step'] } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'updateKB').args[1].usageContexts, ['agent', 'ai_step']);
});

// ── DELETE /:id and GET /:id ────────────────────────────────────────

test('delete: a confirm that is not a yes or a no is refused, and nothing is deleted', async () => {
    refusedAt(await dispatch({ method: 'DELETE', url: '/kb1?confirm=yes' }), 'query.confirm');
    const typo = await dispatch({ method: 'DELETE', url: '/kb1?confrim=1' });
    assert.strictEqual(typo.statusCode, 400);
    assert.deepStrictEqual(touched, []);
});

test('delete: confirm=true still goes through a base that is in use', async () => {
    const res = await dispatch({ method: 'DELETE', url: '/kb1?confirm=true' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'deleteKB').args, ['kb1']);
});

test('delete: without confirm, a base in use still answers 409 with the list', async () => {
    const res = await dispatch({ method: 'DELETE', url: '/kb1' });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'in_use');
});

test('detail: GET takes no query options', async () => {
    const res = await dispatch({ method: 'GET', url: '/kb1?documents=0' });
    assert.strictEqual(res.statusCode, 400);
    const ok = await dispatch({ method: 'GET', url: '/kb1' });
    assert.strictEqual(ok.statusCode, 200);
});
