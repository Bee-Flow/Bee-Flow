/**
 * What the Studio app templates, publish-history, runtime and public-page
 * routes tell the client when the database fails (routes/studioApps/).
 *
 * They used to catch, log and answer a route-specific 500 sentence; now the
 * failure reaches the terminal handler: a generic 500 with a correlationId and
 * none of the database's text.
 *
 * Run: cd server && node --test routes/studioApps/studioApps.errors.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'validation-test-session-secret-000000';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../../testUtils/routeHarness');

const APP_ID = '5b0a7c1e-0000-4000-8000-000000000001';
const DOWN = () => Object.assign(
    new Error('terminating connection due to administrator command on db-primary.internal:5432'),
    { code: '57P01', severity: 'ERROR' },
);

function serve(file, base) {
    return h.routeUnderTest(test, base, () => require(file), {
        gates: { resolveUserOrgIds: async () => new Set(['org1']) },
        answer: (sql) => {
            if (/^\s*(INSERT|UPDATE|DELETE|SELECT)\b/i.test(sql) && /studio_app|app_template/i.test(sql)) throw DOWN();
            return undefined;
        },
    }).api;
}

function assertGeneric500(res) {
    assert.strictEqual(res.status, 500, res.text);
    assert.strictEqual(res.body.error, 'Internal server error');
    assert.ok(res.body.correlationId, 'the client can quote a correlationId');
    assert.doesNotMatch(res.text, /terminating|db-primary|5432/);
}

const templates = serve('./templates', '/api/studio-apps');
const publish = serve('./publish', '/api/studio-apps');
const runtime = serve('./runtime', '/api/studio-apps');
const publicPages = serve('./publicPages', '/api/studio-apps');

test('templates: a database failure is a generic 500', async () => {
    assertGeneric500(await templates.call('DELETE', '/api/studio-apps/templates/utpl_x'));
});

test('publish: a database failure is a generic 500', async () => {
    assertGeneric500(await publish.call('GET', `/api/studio-apps/${APP_ID}/versions`));
});

test('runtime: a database failure is a generic 500', async () => {
    assertGeneric500(await runtime.call('GET', `/api/studio-apps/${APP_ID}/runtime`));
});

test('public pages: a database failure is a generic 500', async () => {
    assertGeneric500(await publicPages.call('GET', `/api/studio-apps/${APP_ID}/public-pages`));
});
