/**
 * What the memory routes accept, and what they say when they refuse
 * (routes/memory.js). The older guards — authentication, the type vocabulary,
 * the content cap, the import limits — stay pinned in memory.guards.test.js.
 *
 * What the hand-written checks let through under a 200: `POST /clear` with
 * `{"agentId": …}` deleted every memory the person had; `PUT /:id` validated a
 * new `type` and then dropped it; a PUT of the importance alone overwrote the
 * stored summary with 50 characters of content; `?type=instuction` listed
 * nothing, and `?projectid=` listed the wrong bucket. What this file pins:
 *
 *   - the 400 NAMES the field (`body.type`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - the store is never reached, so a refused request changes nothing.
 *
 * Run: cd server && node --test routes/memory.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store call lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();
const rec = (what) => (...args) => { touched.push({ what, args }); };
const STORED = { id: 'm1', user_id: 'bob', project_id: null, content: 'I live in Utrecht', summary: 'Lives in Utrecht', importance: 0.5 };

const MOCKS = {
    '../stores/memoryStore': {
        getMemoryById: async (id) => { touched.push({ what: 'getMemoryById', args: [id] }); return id === 'm1' ? { ...STORED } : null; },
        createMemory: async (...args) => { touched.push({ what: 'createMemory', args }); return 'new-id'; },
        updateMemory: async (...args) => { touched.push({ what: 'updateMemory', args }); return true; },
        deleteMemory: async (...args) => { rec('deleteMemory')(...args); },
        clearAllMemories: async (...args) => { rec('clearAllMemories')(...args); },
        searchUserMemories: async (userId, opts) => {
            touched.push({ what: 'searchUserMemories', args: [userId, opts] });
            return { items: [], total: 0, limit: opts.limit, offset: opts.offset };
        },
        getMemoryStats: async () => ({ total: 0 }),
        getMemories: async () => [],
    },
    '../auth/projectAccess': { hasProjectRole: async () => true },
    '../auth': { requireAuth: pass },
    './agents': { getEffectiveUserId: (req) => req.session.user.id },
    '../utils/perUserRateLimit': { perUserRateLimit: () => pass },
    '../pipeline/llmHelpers': { extractJSON: () => ({ memories: [] }) },
    '../core/llm/llmClient': { chat: async () => ({ content: '{}' }) },
    '../core/llm/modelResolver': { resolveModelForTier: async () => 'm', getTierConfig: async () => ({}) },
    '../compliance/dataPortability/stampExport': () => pass,
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:memory-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]memory\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./memory');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ method, url, body }) {
    const [pathname, search = ''] = url.split('?');
    const query = Object.fromEntries(new URLSearchParams(search));
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: pathname, body, query, headers: {},
            session: { user: { id: 'bob' } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            setHeader() { return this; },
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
    assert.notStrictEqual(res.body.error, 'Required');
    assert.deepStrictEqual(touched, [], 'a refused request reaches no store');
};
const lastCall = (what) => [...touched].reverse().find((t) => t.what === what);

test.beforeEach(() => { touched.length = 0; });

// ── the destructive one ─────────────────────────────────────────────

test('clear refuses a body that reads as a narrowing, instead of clearing everything', async () => {
    refusedAt(await dispatch({ method: 'POST', url: '/clear', body: { agentId: 'a1' } }), 'body');
    const ok = await dispatch({ method: 'POST', url: '/clear', body: undefined });
    assert.strictEqual(ok.statusCode, 200);
    assert.deepStrictEqual(lastCall('clearAllMemories').args, ['bob']);
});

test('clear names a project with a real id, or not at all: a blank one is never read as "personal"', async () => {
    // `{"projectId": ""}` and `{"projectId": null}` come from a caller that
    // meant a project and lost the id on the way. Read as "no project", they
    // would clear the person's PERSONAL memory, the very bug the project
    // clear exists to end; so they are refused, and nothing is cleared.
    for (const projectId of ['', '   ', null, 42]) {
        refusedAt(await dispatch({ method: 'POST', url: '/clear', body: { projectId } }), 'body.projectId');
    }
    refusedAt(await dispatch({ method: 'POST', url: '/clear', body: { projectId: 'p1', agentId: 'a1' } }), 'body');
    refusedAt(await dispatch({ method: 'POST', url: '/clear', body: ['p1'] }), 'body');
});

// ── PUT /:id ────────────────────────────────────────────────────────

test('a type change is refused with the reason, instead of a success that changed nothing', async () => {
    const res = await dispatch({ method: 'PUT', url: '/m1', body: { type: 'instruction' } });
    refusedAt(res, 'body.type');
    assert.match(res.body.error, /type cannot be changed/);
});

test('changing only the importance keeps the stored summary', async () => {
    const res = await dispatch({ method: 'PUT', url: '/m1', body: { importance: 0.9 } });
    assert.strictEqual(res.statusCode, 200);
    // updateMemory(id, content, summary, importance)
    assert.deepStrictEqual(lastCall('updateMemory').args, ['m1', STORED.content, STORED.summary, 0.9]);
});

test('changing the content still lets the store derive a fresh summary', async () => {
    await dispatch({ method: 'PUT', url: '/m1', body: { content: '  I moved to Delft  ' } });
    assert.deepStrictEqual(lastCall('updateMemory').args, ['m1', 'I moved to Delft', null, null]);
});

test('an importance that is not a number is refused on PUT instead of being ignored', async () => {
    refusedAt(await dispatch({ method: 'PUT', url: '/m1', body: { importance: 'high' } }), 'body.importance');
});

test('a PUT cannot move a memory to another project', async () => {
    const res = await dispatch({ method: 'PUT', url: '/m1', body: { content: 'x', projectId: 'p2' } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
});

// ── POST / ──────────────────────────────────────────────────────────

test('a memory without content is refused in the sentence it always had', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: {} });
    refusedAt(res, 'body.content');
    assert.strictEqual(res.body.error, 'Content is required');
});

test('the Agent Hub and mobile create payloads pass', async () => {
    const hub = await dispatch({ method: 'POST', url: '/', body: { content: 'Prefers Dutch', type: 'preference', projectId: 'p1' } });
    assert.strictEqual(hub.statusCode, 200);
    const phone = await dispatch({ method: 'POST', url: '/', body: { content: 'Lives in Utrecht', type: 'fact' } });
    assert.strictEqual(phone.statusCode, 200);
    // createMemory(userId, agentId, type, content, summary, importance, …, projectId)
    const args = lastCall('createMemory').args;
    assert.deepStrictEqual([args[0], args[1], args[2], args[3], args[5], args[10]], ['bob', null, 'fact', 'Lives in Utrecht', 0.5, null]);
});

// ── GET / ───────────────────────────────────────────────────────────

test('a misspelled type filter is refused instead of listing nothing', async () => {
    refusedAt(await dispatch({ method: 'GET', url: '/?type=instuction' }), 'query.type');
});

test('a misspelled projectId is refused instead of listing the person\'s own memories', async () => {
    const res = await dispatch({ method: 'GET', url: '/?projectid=p1' });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
});

test('paging: not a number is refused, out of range is clamped, the product\'s own type is listable', async () => {
    refusedAt(await dispatch({ method: 'GET', url: '/?limit=all' }), 'query.limit');
    const res = await dispatch({ method: 'GET', url: '/?limit=500&offset=0&type=schedule_coverage&search=%20kaas%20' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(lastCall('searchUserMemories').args[1], { limit: 200, offset: 0, search: 'kaas', type: 'schedule_coverage' });
});

// ── the rest ────────────────────────────────────────────────────────

test('bulk delete refuses ids that are not a list of ids', async () => {
    refusedAt(await dispatch({ method: 'POST', url: '/bulk-delete', body: { ids: 'm1' } }), 'body.ids');
    refusedAt(await dispatch({ method: 'POST', url: '/bulk-delete', body: { ids: [1] } }), 'body.ids.0');
});

test('import refuses a misspelled or blank text before any model is asked', async () => {
    refusedAt(await dispatch({ method: 'POST', url: '/import', body: { txt: 'hello' } }), 'body.text');
    const blank = await dispatch({ method: 'POST', url: '/import', body: { text: '   ' } });
    refusedAt(blank, 'body.text');
    assert.strictEqual(blank.body.error, 'text is required');
});

test('the reads and the export take no query options', async () => {
    for (const url of ['/export/all?format=csv', '/stats?since=2026', '/types?lang=nl', '/m1?full=1']) {
        const res = await dispatch({ method: 'GET', url });
        assert.strictEqual(res.statusCode, 400, url);
    }
    assert.deepStrictEqual(touched, []);
});
