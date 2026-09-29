/**
 * What the evidence-connector routes accept, and what they say when they
 * refuse (routes/compliance/isoConnectors.js).
 *
 * isoEvidenceStore.upsertConfig keeps what is already on the row whenever it
 * does not recognise a value, so `enabled: 'false'` (the string) is not a
 * boolean and a connector an admin had just switched off went on sweeping —
 * under a 200 carrying the saved row. A misspelled `connectionId` was dropped
 * just as quietly, and the connector then ran with no credential at all.
 * What this file pins is the part a caller can act on:
 *
 *   - the 400 NAMES the field (`body.enabled`), not just "invalid request";
 *   - the message is a sentence;
 *   - the store is never reached, so a refused request changes nothing;
 *   - `settings` stays open — each connector family owns its own keys;
 *   - and the patch ConnectorDrawer really sends still saves.
 *
 * Run: cd server && node --test routes/compliance/isoConnectors.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store and sweep call lands in `touched`. A refused request must leave
// it empty.
const touched = [];
const pass = (req, res, next) => next();

const isoEvidenceStore = {
    listConfigs: async () => [],
    listLatestSnapshots: async () => [],
    getConfig: async (orgId, id) => ({ organization_id: orgId, connector_id: id, enabled: true }),
    upsertConfig: async (orgId, id, patch, actorId) => {
        touched.push({ what: 'upsertConfig', args: [orgId, id, patch, actorId] });
        return { connector_id: id, ...patch };
    },
};

const MOCKS = {
    '../../stores/userStore': { getUser: async () => ({ groups: [] }) },
    '../../stores/isoEvidenceStore': isoEvidenceStore,
    '../../stores/integrationConnectionStore': { listAccessibleConnections: async () => [] },
    '../../compliance/connectors': {
        getAll: () => [{ id: 'tls-probe', titleKey: 't', descKey: 'd' }],
        get: (id) => (id === 'tls-probe' ? { id: 'tls-probe', credential: null } : null),
    },
    '../../jobs/isoEvidenceCollector': {
        sweepOne: async (cfg) => { touched.push({ what: 'sweepOne', args: [cfg] }); return { ok: true, snapshots: 1 }; },
    },
    '../../auth/permissions': { requireAuth: pass, requirePermission: () => pass },
    './shared': { resolveOrgId: async () => 'orgA' },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:iso-connectors-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /compliance[\\/]isoConnectors\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./isoConnectors');
test.after(() => { Module._resolveFilename = originalResolve; });

const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, body = {} }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method, url, originalUrl: url, path: pathname, query, body, headers: {},
            session: { user: { id: 'u1' } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            set() { return this; }, setHeader() {},
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
    const what = `${request.method} ${request.url} ${JSON.stringify(request.body)}`;
    assert.strictEqual(res.statusCode, 400, what);
    assert.strictEqual(res.body.code, 'invalid_request', what);
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
    return res;
}

// ═══ PUT /iso/connectors/:id ════════════════════════════════════════

test('"enabled" as the string "false" is refused, not read as "leave it as it was"', async () => {
    const res = await refuses({ method: 'PUT', url: '/iso/connectors/tls-probe', body: { enabled: 'false' } }, 'body.enabled');
    assert.strictEqual(res.body.error, 'enabled is true or false.');
});

test('a camel-cased connection key is refused rather than dropped, leaving the sweep without a credential', async () => {
    await refuses({ method: 'PUT', url: '/iso/connectors/tls-probe', body: { enabled: true, connectionId: 'conn-1' } }, 'body');
});

test('settings that are not an object are refused in words', async () => {
    const res = await refuses({ method: 'PUT', url: '/iso/connectors/tls-probe', body: { settings: 'host=example.org' } }, 'body.settings');
    assert.strictEqual(res.body.error, 'settings is a JSON object.');
});

test('the drawer patch still saves, and settings stay open for whatever keys a connector wants', async () => {
    const res = await dispatch({
        method: 'PUT', url: '/iso/connectors/tls-probe',
        body: { enabled: true, connection_id: 'conn-1', settings: { hosts: ['beeflow.nl'], min_days: 21 } },
    });
    assert.strictEqual(res.statusCode, 200);
    const saved = touched.find((t) => t.what === 'upsertConfig').args[2];
    assert.strictEqual(saved.enabled, true);
    assert.strictEqual(saved.connection_id, 'conn-1');
    assert.deepStrictEqual(saved.settings, { hosts: ['beeflow.nl'], min_days: 21 });
});

test('unlinking a connection reaches the store as a real null', async () => {
    const res = await dispatch({ method: 'PUT', url: '/iso/connectors/tls-probe', body: { enabled: false, connection_id: null } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'upsertConfig').args[2].connection_id, null);
});

test('an unknown connector is still a 404, and the schema does not get in front of it', async () => {
    const res = await dispatch({ method: 'PUT', url: '/iso/connectors/nope', body: { enabled: true } });
    assert.strictEqual(res.statusCode, 404);
});

// ═══ POST /iso/connectors/:id/sweep ═════════════════════════════════

test('the sweep button posts an empty body and still sweeps', async () => {
    const res = await dispatch({ method: 'POST', url: '/iso/connectors/tls-probe/sweep', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(touched.some((t) => t.what === 'sweepOne'));
});

test('a key on the sweep route is refused rather than ignored', async () => {
    await refuses({ method: 'POST', url: '/iso/connectors/tls-probe/sweep', body: { force: true } }, 'body');
});
