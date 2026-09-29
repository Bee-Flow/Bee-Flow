/**
 * /api/nc-scope — the wire for "What Bee Flow may access".
 *
 * Owns the HTTP layer only (core semantics live in
 * core/integrations/ncScope.test.js): auth required on every verb, a user
 * reads/writes their OWN scope, revoke-all vs reset stay distinct, writes
 * are audited, and the resource picker maps family list results to
 * { id, label, color } without scope-filtering them (a user must be able to
 * re-widen their own narrowing — the org ceiling binds at call time, not in
 * the picker).
 *
 * require.cache fakes for the stores AND the tool dispatcher — the real
 * dispatcher would drag the whole tool graph into a settings-route test.
 * Requests go over real HTTP against app.listen(0).
 *
 * Run: node --test server/routes/ncScope.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const store = new Map();
const audits = [];
let dispatcherCalls = [];
let dispatcherResult = null;

function inject(rel, exports) {
    const resolved = require.resolve(path.join(__dirname, rel));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
inject('../stores/configStore.js', {
    getConfig: async (k) => store.get(k) ?? null,
    setConfig: async (k, v) => { store.set(k, v); },
    deleteConfig: async (k) => { store.delete(k); },
});
inject('../stores/guardrailEventStore.js', {
    logGuardrailEvent: async (e) => { audits.push(e); },
});
inject('../auth/permissions.js', {
    requireAuth: (req, res, next) => (req.session?.user?.id ? next() : res.status(401).json({ error: 'Not authenticated' })),
});
inject('../core/tools/toolDispatcher.js', {
    executeTool: async () => ({ error: 'not under test' }),
    executeNextcloudFamilyTool: async (toolName, toolArgs) => {
        dispatcherCalls.push({ toolName, toolArgs });
        return dispatcherResult;
    },
});
// The guard is only poked for cache invalidation from this route.
inject('../core/integrations/ncScopeGuard.js', { invalidateScopeCache: () => {} });

const express = require('express');
const ncScopeRouter = require('./ncScope');

let server; let base;
before(async () => {
    const app = express();
    app.use((req, _res, next) => {
        const uid = req.headers['x-test-user'];
        req.session = uid ? { user: { id: String(uid), organizationId: 'org-1' } } : {};
        next();
    });
    app.use('/api/nc-scope', ncScopeRouter);
    server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

beforeEach(() => { store.clear(); audits.length = 0; dispatcherCalls = []; dispatcherResult = null; });

async function call(method, urlPath, { user, body } = {}) {
    const res = await fetch(`${base}${urlPath}`, {
        method,
        headers: {
            ...(user ? { 'x-test-user': user } : {}),
            ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
}

test('every verb requires auth', async () => {
    for (const [method, p] of [['GET', '/api/nc-scope'], ['PUT', '/api/nc-scope'], ['POST', '/api/nc-scope/revoke-all'], ['POST', '/api/nc-scope/reset'], ['GET', '/api/nc-scope/resources/nextcloud-calendar']]) {
        const { status } = await call(method, p, { body: method === 'PUT' ? {} : undefined });
        assert.equal(status, 401, `${method} ${p} must 401 unauthenticated`);
    }
});

test('GET default: all 14 catalog integrations, mode all, scopability flagged', async () => {
    const { status, json } = await call('GET', '/api/nc-scope', { user: 'u-1' });
    assert.equal(status, 200);
    assert.equal(Object.keys(json.integrations).length, 14);
    assert.equal(json.integrations['nextcloud'].mode, 'all');
    assert.equal(json.integrations['nextcloud'].scopable, true);
    assert.equal(json.integrations['nextcloud'].resource.kind, 'folder');
    assert.equal(json.integrations['nextcloud-status'].scopable, false);
});

test('PUT narrows the CALLER\'s scope, audited; another user is untouched', async () => {
    const { status, json } = await call('PUT', '/api/nc-scope', {
        user: 'u-1',
        body: { integrations: { 'nextcloud': { mode: 'selected', selected: ['/Projects'] } } },
    });
    assert.equal(status, 200);
    assert.deepEqual(json.integrations['nextcloud'].selected, ['/Projects']);
    assert.ok(store.has('user_nc_scope_u-1'));
    assert.ok(!store.has('user_nc_scope_u-2'), 'no cross-user writes possible');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].user_id, 'u-1');
    const other = await call('GET', '/api/nc-scope', { user: 'u-2' });
    assert.equal(other.json.integrations['nextcloud'].mode, 'all');
});

test('revoke-all turns every integration off; reset returns to default', async () => {
    await call('POST', '/api/nc-scope/revoke-all', { user: 'u-1' });
    let { json } = await call('GET', '/api/nc-scope', { user: 'u-1' });
    for (const [id, entry] of Object.entries(json.integrations)) {
        assert.equal(entry.mode, 'off', `${id} must be off after revoke-all`);
    }
    await call('POST', '/api/nc-scope/reset', { user: 'u-1' });
    ({ json } = await call('GET', '/api/nc-scope', { user: 'u-1' }));
    for (const entry of Object.values(json.integrations)) assert.equal(entry.mode, 'all');
    assert.equal(audits.length, 2);
});

test('resources: family list mapped to {id,label,color}, NOT scope-filtered', async () => {
    // The user has narrowed to 'work' — the picker must still show everything
    // their NC account can see, or they could never re-widen.
    store.set('user_nc_scope_u-1', { v: 1, integrations: { 'nextcloud-calendar': { mode: 'selected', selected: ['work'] } } });
    dispatcherResult = { count: 2, calendars: [{ slug: 'work', displayName: 'Work', color: '#0082C9' }, { slug: 'personal', displayName: 'Personal' }] };
    const { status, json } = await call('GET', '/api/nc-scope/resources/nextcloud-calendar', { user: 'u-1' });
    assert.equal(status, 200);
    assert.equal(dispatcherCalls[0].toolName, 'nextcloud_calendar_list');
    assert.deepEqual(json.resources, [
        { id: 'work', label: 'Work', color: '#0082C9' },
        { id: 'personal', label: 'Personal', color: null },
    ]);
});

test('resources: folder picker lists one level of folders, lazily by ?path=', async () => {
    dispatcherResult = {
        path: '/Projects', count: 3,
        items: [
            { name: 'Bee Flow', path: '/Projects/Bee Flow', type: 'folder' },
            { name: 'notes.md', path: '/Projects/notes.md', type: 'file' },
            { name: 'Archive', path: '/Projects/Archive', type: 'folder' },
        ],
    };
    const { json } = await call('GET', '/api/nc-scope/resources/nextcloud?path=%2FProjects', { user: 'u-9' });
    assert.equal(dispatcherCalls[0].toolArgs.path, '/Projects');
    assert.deepEqual(json.resources.map(r => r.id), ['/Projects/Bee Flow', '/Projects/Archive']);
});

test('resources: unscopable integration 404s; upstream error surfaces as 502', async () => {
    const nf = await call('GET', '/api/nc-scope/resources/nextcloud-status', { user: 'u-1' });
    assert.equal(nf.status, 404);
    dispatcherResult = { error: 'Nextcloud unreachable' };
    const up = await call('GET', '/api/nc-scope/resources/nextcloud-forms', { user: 'u-1' });
    assert.equal(up.status, 502);
});
