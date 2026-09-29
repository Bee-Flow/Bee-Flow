/**
 * Mount order is correctness here, not style.
 *
 * `GET /:id` in routes/transcriptions/notes.js swallows every literal path
 * that is not in its RESERVED_GET_PATHS. `routes/transcriptions/tags.js` was
 * written, tested and never mounted; when it finally was mounted below
 * ./notes, `GET /api/transcriptions/tags` answered 404 with "tags" read as a
 * note id, and the client silently fell back to counting the tags on the one
 * page of 50 it had loaded. Both of its test files drive the sub-router
 * DIRECTLY, so 39 green tests proved the handler right about a route nobody
 * could reach.
 *
 * This file exists to close that gap: it drives the COMPOSED router the app
 * actually mounts, so a sub-router that is unmounted — or mounted in the
 * wrong place — fails here.
 *
 * Run: cd server && node --test --test-force-exit routes/transcriptions.mount.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const tagRows = [{ tag: 'sales', count: 4 }];
let storedNote = null;
const dbCalls = [];

stub('../auth/permissions', { requireAuth: (req, res, next) => next() });
stub('../auth', { resolveUserOrgIds: async () => new Set(['org-1']) });
stub('../stores/userStore', { getUser: async () => ({ groups: [] }), getAllGroups: async () => [] });
stub('../stores/summaryTemplateStore', { resolveDefaultPrompt: async () => null, resolveDefaultTemplate: async () => null });
stub('../stores/configStore', { getConfig: async () => null, getSecret: async () => null });
stub('../stores/storageStore', { isAvailable: () => false, getStatus: () => ({ configured: false }) });
stub('../core/llm/llmClient', {});
stub('../core/meetingNotes/talkNotesSettings', { getOrgSettings: async () => ({}) });
stub('../stores/transcriptionStore', {
    getTranscription: async (id) => (storedNote && storedNote.id === id ? { ...storedNote } : null),
    deleteTranscription: async () => true,
    updateTranscription: async () => ({}),
    timeoutStuckTranscriptions: async () => 0,
});
stub('../db', {
    getAll: async (sql, params) => { dbCalls.push({ sql, params }); return tagRows; },
    getOne: async () => null,
    run: async () => ({ rowCount: 1 }),
    exec: async () => {},
    // The usage derivation reads through `pool`; nothing here exercises it —
    // usage.test.js does that — but it must exist or requiring the module
    // would throw on the destructure.
    pool: { query: async () => ({ rows: [] }) },
});

const router = require('./transcriptions');

function dispatch({ method = 'GET', url, user = 'owner-1' }) {
    return new Promise((resolve, reject) => {
        const [pathname, search] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search || '')) query[k] = v;
        const req = {
            method, url, originalUrl: url, path: pathname, query, headers: {},
            session: { isAuthenticated: true, user: { id: user } },
            get(n) { return this.headers[String(n).toLowerCase()]; },
            setTimeout() {},
        };
        const res = {
            statusCode: 200, headers: {}, body: undefined,
            set(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
            setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
            setTimeout() {},
        };
        router(req, res, (err) => reject(err || new Error(`fell through: ${method} ${url}`)));
    });
}

test('GET /tags is reachable through the composed router', async () => {
    // Below ./notes this is a 404 with "tags" read as a note id. That is the
    // bug this file exists for, and it shipped once.
    const res = await dispatch({ url: '/tags' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, [{ tag: 'sales', count: 4 }]);
    assert.ok(dbCalls.length > 0, 'the tag query ran — this was not notes.js answering');
});

test('GET /:id/usage is reachable through the composed router', async () => {
    storedNote = { id: 'm-1', tags: [], ownerId: 'owner-1', isOwner: true };
    const res = await dispatch({ url: '/m-1/usage' });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(Array.isArray(res.body.usage));
    assert.ok(Array.isArray(res.body.unchecked));
});

test('a note id that happens to look like a sub-path still resolves to the note', async () => {
    // The other half of the ordering rule: putting literal routes first must
    // not shadow GET /:id for ordinary ids.
    storedNote = { id: 'usage', title: 'A note called usage', tags: [] };
    const res = await dispatch({ url: '/usage' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.title, 'A note called usage');
});

// ── Is every sub-router on disk actually part of the composed router? ──
// The other half of the original bug: a file that exists, is tested, and is
// never referenced at all. Asked of the composed ROUTER rather than of the
// require list in the source, so a sub-router that exports nothing routable,
// or that is required without being mounted, fails here as well. Which
// PREFIX each one hangs under is what the dispatch tests above settle.

/** Every `${METHOD} ${path}` an express router answers, nested routers included. */
function routesOf(r, prefix = '') {
    const out = [];
    for (const layer of (r.stack || [])) {
        if (layer.route) {
            for (const method of Object.keys(layer.route.methods)) {
                out.push(`${method.toUpperCase()} ${prefix}${layer.route.path}`);
            }
        } else if (layer.handle && layer.handle.stack) {
            out.push(...routesOf(layer.handle, prefix));
        }
    }
    return out;
}

test('every sub-router on disk answers through the composed router', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, 'transcriptions');
    const composed = new Set(routesOf(router));
    assert.ok(composed.size > 10, 'the composed router exposes almost nothing — did the mount break?');

    // The two modules in this folder that are NOT sub-routers: `shared.js` is
    // the access-context and payload helpers, `schemas.js` the zod vocabulary
    // every request schema is built from. Named rather than detected, so a
    // sub-router that stopped declaring routes still fails loudly here.
    const NOT_ROUTERS = new Set(['shared.js', 'schemas.js']);
    const missing = [];
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.js') || file.includes('.test.') || NOT_ROUTERS.has(file)) continue;
        const sub = require(path.join(dir, file));
        const own = routesOf(sub);
        assert.ok(own.length > 0, `${file} declares no routes at all`);
        for (const route of own) if (!composed.has(route)) missing.push(`${file}: ${route}`);
    }
    assert.deepStrictEqual(missing, [],
        'these routes exist and are tested, but they are not in the router the app mounts');
});
