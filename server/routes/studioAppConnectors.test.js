/**
 * App Studio connectors bridge — security model + run semantics.
 *
 * Exercises the real Express router with stubbed stores via the require-cache
 * trick and a stubbed req/res dispatch harness (same pattern as
 * studioAppsRun.test.js) — no HTTP listener, no DB. The connectors module is
 * loaded for real (listConnectors/findConnector are the safe-projection +
 * resolution logic under test); runConnector is patched so the route's
 * acts-as-owner wiring is observed without dispatching a real fetch.
 *
 * Run: cd server && node --test routes/studioAppConnectors.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

// Small connector-run budget so the rate-limit test is fast (read at load).
process.env.STUDIO_APP_CONNECTOR_RATE = '3';

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const apps = new Map();

// Faithful copy of the store's pure predicate (the real module eagerly connects
// to Postgres at require time).
function canReadStudioApp(app, userId, userGroupIds = [], userOrgIds = []) {
    if (!app) return false;
    if (app.userId === userId) return true;
    if (!app.isPublished) return false;
    if (!app.organizationId) return false;
    const orgIds = Array.isArray(userOrgIds) ? userOrgIds : [...(userOrgIds || [])];
    if (!orgIds.includes(app.organizationId)) return false;
    const groups = Array.isArray(app.sharedGroups) ? app.sharedGroups : [];
    if (groups.length === 0) return true;
    return groups.some((g) => userGroupIds.includes(g));
}

stub('../stores/studioAppStore', {
    getStudioApp: async (id) => apps.get(id) || null,
    canReadStudioApp,
    // Project widening (canReadStudioAppAsync): no fixture here is filed into
    // a Studio Project, so the async predicate is the sync one — which is
    // exactly what the real store answers for project_id NULL.
    canReadStudioAppAsync: async (...a) => canReadStudioApp(...a),
});
stub('../stores/userStore', { getUser: async (id) => ({ id }) });
stub('../auth/audience', {
    resolveAudienceContext: async (req) => ({
        userId: req.session?.user?.id || null,
        orgIds: new Set(req._testOrgIds || []),
        userGroups: req._testGroups || [],
    }),
});

// getDataModel is stubbed per-app; the connectors bridge reads the OWNER's live
// model (there is no published snapshot of the data model).
let dataModelFor = () => null;
// Membership + sync state drive the two RUNTIME endpoints (status/refresh),
// which answer to app members rather than to the owner.
let memberRoles = new Map();      // `${appId}:${userId}` → roleKey
let syncStatesFor = () => [];
stub('../stores/studioAppDataStore', {
    getDataModel: async (appId, ownerId) => {
        const model = dataModelFor(appId, ownerId);
        return model ? { appId, ownerUserId: ownerId, model, modelVersion: 1 } : null;
    },
    getMemberRole: async (appId, userId) => memberRoles.get(`${appId}:${userId}`) || null,
    listSyncStates: async (appId) => syncStatesFor(appId),
});

// The connection probe asks the integration layer a session question; stubbed
// so these tests stay about the ROUTE (its gate and its projection) rather than
// about session resolution, which has its own suite.
let probeAnswer = true;
stub('../appStudio/mailboxIdentity', {
    INTEGRATION_BY_MAILBOX_PROVIDER: { gmail: 'gmail', outlook: 'outlook' },
    _viewerHasIntegration: async () => probeAnswer,
});

// Real connectors module — its object methods are patched here so the route's
// call sites (connectors.listConnectors / findConnector / runConnector) observe
// our doubles while the projection logic stays real for the secret-leak test.
const connectors = require('../appStudio/connectors');
const runCalls = [];
let runImpl = async () => ({ rows: [{ id: 1 }], nextPage: null });
const realRunConnector = connectors.runConnector;
connectors.runConnector = (connector, opts) => { runCalls.push({ connector, opts }); return runImpl(connector, opts); };

const router = require('./studioAppConnectors');

// ── Dispatch harness ────────────────────────────────────────────────
function dispatch({ method = 'GET', url, user = 'viewer-1', orgIds = [], groups = [], body, query = {} }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, query,
            ip: '203.0.113.7',
            headers: {},
            session: user ? { isAuthenticated: true, user: { id: user } } : null,
            _testOrgIds: orgIds,
            _testGroups: groups,
            get(name) { return this.headers[String(name).toLowerCase()]; },
        };
        if (body !== undefined) req.body = body;
        const res = {
            statusCode: 200, headers: {}, body: undefined,
            set(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
            setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
            getHeader(k) { return this.headers[String(k).toLowerCase()]; },
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(req, res, (err) => reject(err || new Error(`fell through router: ${method} ${url}`)));
    });
}

// ── Fixtures ────────────────────────────────────────────────────────
const OWNER = 'owner-1';
const ORG = 'org-1';

// A connector carrying every secret-bearing field the projection must strip.
const REST_CONNECTOR = {
    id: 'conn_rest01', kind: 'rest', name: 'Items',
    params: [{ key: 'q', type: 'text', required: false }],
    url: 'https://api.example.com/items?q={q}',
    headers: { 'X-Api-Version': '2' },
    auth: { type: 'bearer', credentialProvider: 'example' },
    rowsPath: 'data.items', maxRows: 50,
};
const TOOL_CONNECTOR = {
    id: 'conn_tool01', kind: 'integration_tool', name: 'Recent emails',
    tool: 'gmail_list_messages', fixedArgs: { labelIds: ['INBOX'] },
};

let seq = 0;
function makeApp({ published = true, connectorsList = [REST_CONNECTOR, TOOL_CONNECTOR], org = ORG, owner = OWNER } = {}) {
    const id = `capp-${++seq}`;
    const app = { id, userId: owner, organizationId: org, name: 'Test app', isPublished: published, sharedGroups: [] };
    apps.set(id, app);
    dataModelFor = (aid) => (aid === id ? { modelVersion: 1, tables: [], connectors: connectorsList } : null);
    return app;
}

// A mailbox connector that DOES fill a table — the runtime pair only speaks
// about connectors with a sync.
const MAIL_CONNECTOR = {
    id: 'conn_mail01', kind: 'mailbox', name: 'Intake mailbox',
    provider: 'gmail', mode: 'personal', runAs: 'viewer', query: 'label:intake',
    sync: { tableId: 'tbl_x', mode: 'upsert', keyField: 'thread_key', schedule: { everyMinutes: 2 } },
};

test.beforeEach(() => {
    runCalls.length = 0;
    runImpl = async () => ({ rows: [{ id: 1 }], nextPage: null });
    memberRoles = new Map();
    syncStatesFor = () => [];
});

// ── GET projection: NO secrets ──────────────────────────────────────
test('GET connectors returns a safe projection — never fixedArgs / url / creds', async () => {
    const app = makeApp();
    const r = await dispatch({ url: `/${app.id}/data/connectors`, user: 'viewer-1', orgIds: [ORG] });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.body.connectors.length, 2);
    const serialized = JSON.stringify(r.body);
    for (const leak of ['fixedArgs', 'INBOX', 'api.example.com', 'credentialProvider', 'X-Api-Version', 'gmail_list_messages', 'rowsPath']) {
        assert.ok(!serialized.includes(leak), `projection must not leak ${leak}`);
    }
    const rest = r.body.connectors.find((c) => c.id === 'conn_rest01');
    assert.deepStrictEqual(Object.keys(rest).sort(), ['id', 'kind', 'name', 'params']);
    assert.deepStrictEqual(rest.params, [{ key: 'q', type: 'text', required: false }]);
});

// ── IDOR uniform-404 ────────────────────────────────────────────────
test('unknown app id answers 404', async () => {
    const r = await dispatch({ url: `/does-not-exist/data/connectors`, user: 'viewer-1', orgIds: [ORG] });
    assert.strictEqual(r.statusCode, 404);
});

test('unpublished app + non-owner answers 404 (no existence leak) on GET and run', async () => {
    const app = makeApp({ published: false });
    const g = await dispatch({ url: `/${app.id}/data/connectors`, user: 'stranger', orgIds: [ORG] });
    assert.strictEqual(g.statusCode, 404);
    const p = await dispatch({ method: 'POST', url: `/${app.id}/data/connectors/conn_rest01/run`, user: 'stranger', orgIds: [ORG], body: {} });
    assert.strictEqual(p.statusCode, 404);
    assert.strictEqual(runCalls.length, 0, 'connector must not run for an invisible app');
});

test('owner reaches an unpublished app', async () => {
    const app = makeApp({ published: false });
    const r = await dispatch({ url: `/${app.id}/data/connectors`, user: OWNER });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.body.connectors.length, 2);
});

// ── Run: acts-as-owner ──────────────────────────────────────────────
test('a visible non-owner viewer runs a connector ACTS-AS-OWNER', async () => {
    const app = makeApp();
    runImpl = async () => ({ rows: [{ id: 'a' }, { id: 'b' }], nextPage: 'cursor-2' });
    const r = await dispatch({
        method: 'POST', url: `/${app.id}/data/connectors/conn_rest01/run`,
        user: 'viewer-9', orgIds: [ORG], body: { params: { q: 'hello' } },
    });
    assert.strictEqual(r.statusCode, 200);
    assert.deepStrictEqual(r.body.rows, [{ id: 'a' }, { id: 'b' }]);
    assert.strictEqual(r.body.nextPage, 'cursor-2');
    assert.strictEqual(runCalls.length, 1);
    const { connector, opts } = runCalls[0];
    assert.strictEqual(connector.id, 'conn_rest01');
    assert.strictEqual(opts.app.userId, OWNER, 'runs as the app OWNER');
    assert.strictEqual(opts.viewerId, 'viewer-9', 'viewer id carried for audit only');
    assert.deepStrictEqual(opts.params, { q: 'hello' });
});

test('a tool connector only forwards its DECLARED params — undeclared viewer keys are dropped', async () => {
    const declaring = { ...TOOL_CONNECTOR, params: [{ key: 'q', type: 'text', required: false }] };
    const app = makeApp({ connectorsList: [declaring] });
    const r = await dispatch({
        method: 'POST', url: `/${app.id}/data/connectors/conn_tool01/run`,
        user: 'viewer-9', orgIds: [ORG],
        body: { params: { q: 'invoice', to: 'attacker@example.com', includeSpamTrash: true } },
    });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(runCalls.length, 1);
    assert.deepStrictEqual(runCalls[0].opts.params, { q: 'invoice' });
});

test('a tool connector declaring no params reaches the runtime with an empty param bag', async () => {
    const app = makeApp({ connectorsList: [TOOL_CONNECTOR] });
    const r = await dispatch({
        method: 'POST', url: `/${app.id}/data/connectors/conn_tool01/run`,
        user: 'viewer-9', orgIds: [ORG], body: { params: { to: 'attacker@example.com' } },
    });
    assert.strictEqual(r.statusCode, 200);
    assert.deepStrictEqual(runCalls[0].opts.params, {});
});

test('unknown connectorId answers 404', async () => {
    const app = makeApp();
    const r = await dispatch({ method: 'POST', url: `/${app.id}/data/connectors/conn_nope/run`, user: OWNER, body: {} });
    assert.strictEqual(r.statusCode, 404);
    assert.strictEqual(runCalls.length, 0);
});

test('a connectorError status/code is surfaced to the client', async () => {
    const app = makeApp();
    runImpl = async () => { const e = new Error('connector target refused (private/internal address)'); e.status = 403; e.code = 'forbidden_host'; throw e; };
    const r = await dispatch({ method: 'POST', url: `/${app.id}/data/connectors/conn_rest01/run`, user: OWNER, body: {} });
    assert.strictEqual(r.statusCode, 403);
    assert.strictEqual(r.body.code, 'forbidden_host');
});

test('a 409 connection_required also surfaces the provider (runAs:viewer connectors)', async () => {
    const app = makeApp();
    runImpl = async () => {
        const e = new Error('this data source needs a connected account');
        e.status = 409; e.code = 'connection_required'; e.provider = 'gmail';
        throw e;
    };
    const r = await dispatch({ method: 'POST', url: `/${app.id}/data/connectors/conn_rest01/run`, user: OWNER, body: {} });
    assert.strictEqual(r.statusCode, 409);
    assert.strictEqual(r.body.code, 'connection_required');
    assert.strictEqual(r.body.provider, 'gmail');
});

test('an unexpected error collapses to a generic 500 (no internals leaked)', async () => {
    const app = makeApp();
    runImpl = async () => { throw new Error('secret internal detail'); };
    const r = await dispatch({ method: 'POST', url: `/${app.id}/data/connectors/conn_rest01/run`, user: OWNER, body: {} });
    assert.strictEqual(r.statusCode, 500);
    assert.ok(!JSON.stringify(r.body).includes('secret internal detail'));
});

// ── Rate limit (STUDIO_APP_CONNECTOR_RATE=3) ────────────────────────
test('connectorRunLimiter 429s after the per-(user, app) cap', async () => {
    const app = makeApp();
    let last;
    for (let i = 0; i < 4; i++) {
        last = await dispatch({ method: 'POST', url: `/${app.id}/data/connectors/conn_rest01/run`, user: 'rl-user', orgIds: [ORG], body: {} });
    }
    assert.strictEqual(last.statusCode, 429, 'the 4th call in a 3/min window is throttled');
    // A different user still has budget for the same app (per-(user,app) keying).
    const other = await dispatch({ method: 'POST', url: `/${app.id}/data/connectors/conn_rest01/run`, user: 'rl-other', orgIds: [ORG], body: {} });
    assert.strictEqual(other.statusCode, 200);
});

// ── Authoring endpoints are OWNER-ONLY ──────────────────────────────
//
// The viewer gate (canReadStudioApp) is right for RUNNING a connector — that is
// the read a published app exists to offer. /inspect describes the owner's
// upstream data shape and /sync spends their API budget and writes rows, so
// neither may be reachable by a viewer of a published app.

test('/inspect and /sync are refused (404) for a viewer who CAN run the connector', async () => {
    const app = makeApp({ published: true });
    // Same viewer, same app: the run endpoint works…
    const run = await dispatch({ method: 'POST', url: `/${app.id}/data/connectors/conn_tool01/run`, user: 'viewer-9', orgIds: [ORG], body: {} });
    assert.strictEqual(run.statusCode, 200);

    // …but the authoring endpoints do not. Uniform 404, so ownership can't be probed.
    runCalls.length = 0;
    for (const path of ['inspect', 'sync']) {
        const r = await dispatch({ method: 'POST', url: `/${app.id}/data/connectors/conn_tool01/${path}`, user: 'viewer-9', orgIds: [ORG], body: {} });
        assert.strictEqual(r.statusCode, 404, `${path} must be owner-only`);
    }
    assert.strictEqual(runCalls.length, 0, 'nothing ran on the owner’s behalf');
});

test('/inspect runs the connector once and returns a table proposal the owner just confirms', async () => {
    const app = makeApp();
    runImpl = async () => ({
        rows: [
            { id: 'm1', subject: 'Hi', modifiedTime: '2026-08-01T10:00:00Z', unread: true },
            { id: 'm2', subject: 'Yo', modifiedTime: '2026-08-02T10:00:00Z', unread: false },
        ],
    });
    const r = await dispatch({ method: 'POST', url: `/${app.id}/data/connectors/conn_tool01/inspect`, user: OWNER, body: {} });

    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(runCalls.length, 1, 'inspection costs exactly one upstream run');
    assert.strictEqual(r.body.identity, 'id');
    assert.strictEqual(r.body.defaultMode, 'upsert');
    // Gmail has no since-param, so the honest answer is the client-side tier.
    assert.strictEqual(r.body.incremental.mode, 'client');
    assert.strictEqual(r.body.incremental.field, 'modifiedTime');
    assert.ok(r.body.suggestedTable.fields.some((f) => f.key === 'subject' && f.type === 'text'));
    assert.ok(r.body.suggestedTable.fields.some((f) => f.key === 'unread' && f.type === 'bool'));
    // `id` is a server-managed column on every table, so the upstream one is
    // stored as source_id — while sync still matches on the SOURCE path `id`.
    assert.ok(r.body.suggestedTable.fields.some((f) => f.key === 'source_id' && f.unique), 'identity column is unique-indexed');
    assert.strictEqual(r.body.keyField, 'id');
    // Only a preview of the owner's data crosses the wire.
    assert.ok(r.body.rows.length <= 3);
    assert.strictEqual(r.body.rowCount, 2);
});

test('/inspect reports an undetectable incremental strategy rather than inventing one', async () => {
    const app = makeApp();
    runImpl = async () => ({ rows: [{ name: 'a' }, { name: 'b' }] });
    const r = await dispatch({ method: 'POST', url: `/${app.id}/data/connectors/conn_tool01/inspect`, user: OWNER, body: {} });
    assert.strictEqual(r.body.incremental.mode, 'none', 'no timestamp anywhere → no incremental option offered');
    assert.strictEqual(r.body.identity, 'name');
});

test('/sync refuses a connector that does not fill a table', async () => {
    const app = makeApp();
    const r = await dispatch({ method: 'POST', url: `/${app.id}/data/connectors/conn_tool01/sync`, user: OWNER, body: {} });
    assert.strictEqual(r.statusCode, 400);
    assert.strictEqual(r.body.code, 'not_synced');
});

test('/sync-status is owner-only', async () => {
    const app = makeApp();
    const viewer = await dispatch({ url: `/${app.id}/data/connectors/sync-status`, user: 'viewer-9', orgIds: [ORG] });
    assert.strictEqual(viewer.statusCode, 404);
});

test('an unknown connector answers 404 on the authoring endpoints too', async () => {
    const app = makeApp();
    const r = await dispatch({ method: 'POST', url: `/${app.id}/data/connectors/conn_nope99/inspect`, user: OWNER, body: {} });
    assert.strictEqual(r.statusCode, 404);
});

// ── The runtime pair: members, not owners ───────────────────────────
//
// These exist because the people USING an app could not tell an empty mailbox
// from a disconnected one. The gate is membership — narrower than the
// visibility gate a published app's audience passes.

test('runtime status answers members and the owner, and nobody else', async () => {
    const app = makeApp({ connectorsList: [MAIL_CONNECTOR] });

    const stranger = await dispatch({ url: `/${app.id}/runtime/connectors/status`, user: 'stranger', orgIds: [ORG] });
    assert.strictEqual(stranger.statusCode, 404, 'audience membership alone is not enough');

    memberRoles.set(`${app.id}:sales-1`, 'verkoper');
    const member = await dispatch({ url: `/${app.id}/runtime/connectors/status`, user: 'sales-1', orgIds: [ORG] });
    assert.strictEqual(member.statusCode, 200);

    const owner = await dispatch({ url: `/${app.id}/runtime/connectors/status`, user: OWNER });
    assert.strictEqual(owner.statusCode, 200);
});

test('runtime status reports whether, never what — no error text, no watermark', async () => {
    const app = makeApp({ connectorsList: [MAIL_CONNECTOR] });
    memberRoles.set(`${app.id}:sales-1`, 'verkoper');
    syncStatesFor = () => ([{
        connectorId: 'conn_mail01', status: 'idle',
        lastRunAt: '2026-08-07T10:00:00.000Z', nextRunAt: '2026-08-07T10:02:00.000Z',
        // Everything below is the OWNER's diagnostic view and must not travel.
        watermark: '2026-08-07T09:59:00.000Z', rowsWritten: 12,
        lastError: 'Gmail said: invalid query "label:intake" for user boss@shop.test',
    }]);

    const r = await dispatch({ url: `/${app.id}/runtime/connectors/status`, user: 'sales-1', orgIds: [ORG] });
    assert.strictEqual(r.statusCode, 200);
    const card = r.body.connectors.find((c) => c.id === 'conn_mail01');
    assert.strictEqual(card.hasError, true, 'a problem is visible');
    assert.strictEqual(card.lastRunAt, '2026-08-07T10:00:00.000Z');
    assert.strictEqual(card.syncable, true);

    const serialized = JSON.stringify(r.body);
    for (const leak of ['boss@shop.test', 'watermark', 'rowsWritten', 'invalid query', 'label:intake']) {
        assert.ok(!serialized.includes(leak), `runtime status must not leak ${leak}`);
    }
});

test('a personal mailbox reports no address — we do not open a connection to find one', async () => {
    const app = makeApp({ connectorsList: [MAIL_CONNECTOR] });
    memberRoles.set(`${app.id}:sales-1`, 'verkoper');
    const r = await dispatch({ url: `/${app.id}/runtime/connectors/status`, user: 'sales-1', orgIds: [ORG] });
    const card = r.body.connectors.find((c) => c.id === 'conn_mail01');
    assert.strictEqual(card.address, null);
    assert.strictEqual(card.provider, 'gmail');
});

test('runtime refresh refuses a connector with no scheduled sync', async () => {
    const app = makeApp();
    memberRoles.set(`${app.id}:sales-1`, 'verkoper');
    const r = await dispatch({ method: 'POST', url: `/${app.id}/runtime/connectors/conn_tool01/refresh`, user: 'sales-1', orgIds: [ORG] });
    assert.strictEqual(r.statusCode, 400);
    assert.strictEqual(r.body.code, 'not_syncable');
});

test('runtime refresh is closed to a non-member of a published app', async () => {
    const app = makeApp({ connectorsList: [MAIL_CONNECTOR] });
    const r = await dispatch({ method: 'POST', url: `/${app.id}/runtime/connectors/conn_mail01/refresh`, user: 'stranger', orgIds: [ORG] });
    assert.strictEqual(r.statusCode, 404);
});

test.after(() => { connectors.runConnector = realRunConnector; });
