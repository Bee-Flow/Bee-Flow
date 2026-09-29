/**
 * Route tests for /api/nextcloud/studio-apps (routes/nextcloudStudioApps.js).
 *
 * The HMAC layer (auth/connectorSig) runs FOR REAL — only its store lookups
 * (configStore secret, userStore org-by-instance-id) and the studio app list
 * are mocked via the Module._resolveFilename harness (same pattern as
 * routes/studioApps.test.js), so these tests pin the exact signature scheme
 * the connector signs with in nextcloud-connector/src/studioAppMenus.js:
 *
 *   message = `${ts}\nGET\n/api/nextcloud/studio-apps\n`   (empty body)
 *
 * Run: node --test routes/nextcloudStudioApps.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const Module = require('module');

const TENANT_KEY = 'tk-secret-0123456789';
const INSTANCE_ID = 'nc-instance-a';

const ORG = { id: 'orgA', name: 'Org A', ncInstanceId: INSTANCE_ID };

const MENU_APPS = [
    {
        id: '4c6cbdcf-6a7e-4d9b-9f6e-2f1f5c1d0a01', name: 'Quote intake', description: 'Quotes',
        icon: 'Scissors', accentColor: '#0369A1',
        updatedAt: '2026-08-01T10:00:00.000Z', publishedAt: '2026-08-01T09:00:00.000Z',
        // Fields the endpoint must NOT leak:
        userId: 'owner', sharedGroups: [], isPublished: true, nextcloudMenu: true,
        definitionVersion: 4, publishedVersion: 4, organizationId: 'orgA', projectId: null,
    },
];

const MOCKS = {
    '../stores/configStore': {
        getSecret: async (key) => (key === `connector_tenant_key_${ORG.id}` ? TENANT_KEY : null),
    },
    '../stores/userStore': {
        getOrganizationByNcInstanceId: async (id) => (id === INSTANCE_ID ? { ...ORG } : null),
    },
    '../stores/studioAppStore': {
        listNextcloudMenuApps: async (orgId) => (orgId === ORG.id ? JSON.parse(JSON.stringify(MENU_APPS)) : []),
    },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) return MOCK_IDS[request];
    return originalResolve.call(this, request, parent, ...rest);
};

const express = require('express');
const router = require('./nextcloudStudioApps');

let server;
let baseUrl;
const MOUNT = '/api/nextcloud/studio-apps';

test.before(async () => {
    const app = express();
    app.use(MOUNT, router);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    await new Promise((resolve) => server.close(resolve));
});

// Signs exactly like the connector's fetchDesiredApps().
function signedHeaders({ ts = Math.floor(Date.now() / 1000), key = TENANT_KEY, instanceId = INSTANCE_ID, path = MOUNT } = {}) {
    const sig = crypto.createHmac('sha256', key).update(`${ts}\nGET\n${path}\n`).digest('hex');
    return {
        'X-Beeflow-Source': 'nextcloud-connector',
        'X-Beeflow-NC-Instance-Id': instanceId,
        'X-Beeflow-Sig': `${ts}.${sig}`,
    };
}

test('a correctly signed GET returns the menu list, card metadata only', async () => {
    const res = await fetch(`${baseUrl}${MOUNT}`, { headers: signedHeaders() });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.apps.length, 1);
    const app = body.apps[0];
    assert.deepStrictEqual(Object.keys(app).sort(), [
        'accentColor', 'description', 'icon', 'id', 'name', 'publishedAt', 'updatedAt',
    ]);
    assert.strictEqual(app.id, MENU_APPS[0].id);
    assert.strictEqual(app.name, 'Quote intake');
    // Ownership/audience internals never cross the wire to the connector.
    assert.strictEqual(app.userId, undefined);
    assert.strictEqual(app.sharedGroups, undefined);
});

test('rejects a missing/foreign instance id, a wrong key, and a stale timestamp', async () => {
    const cases = [
        { name: 'no headers at all', headers: {} },
        { name: 'unknown instance id', headers: signedHeaders({ instanceId: 'nc-unknown' }) },
        { name: 'wrong tenant key', headers: signedHeaders({ key: 'not-the-key-0123456789' }) },
        { name: 'stale timestamp (>5min skew)', headers: signedHeaders({ ts: Math.floor(Date.now() / 1000) - 3600 }) },
        { name: 'signature over the wrong path', headers: signedHeaders({ path: '/api/nextcloud/task-processing' }) },
    ];
    for (const c of cases) {
        const res = await fetch(`${baseUrl}${MOUNT}`, { headers: c.headers });
        assert.strictEqual(res.status, 401, c.name);
    }
});

test('the org scoping comes from the instance id, not anything client-controlled in the body/query', async () => {
    // A query string changes originalUrl, so a signature over the bare path
    // must fail — the connector always signs the exact URL it requests.
    const res = await fetch(`${baseUrl}${MOUNT}?orgId=orgB`, { headers: signedHeaders() });
    assert.strictEqual(res.status, 401);
});
