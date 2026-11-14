/**
 * What the unauthenticated connector routes accept (auth/connectorBootstrap.js):
 * the keys nextcloud-connector sends, and no other. A key it does not send is a
 * worded 400 before any store is read or any Nextcloud is called; the values
 * stay the handlers' to check, with the codes the connector branches on
 * (connectorBootstrap.stores.test.js runs the bodies the connector sends).
 *
 * Run: cd server && node --test auth/connectorBootstrap.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../testUtils/routeHarness');

const { db, api } = h.routeUnderTest(test, '/auth', () => require('./connectorBootstrap'), { user: null });

const HEADERS = {
    'x-beeflow-nc-instance-id': 'oc-validation',
    'x-beeflow-nc-base-url': 'https://nc.example.test',
    'x-beeflow-nc-admin-uid': 'admin',
    'x-beeflow-nc-admin-email': 'admin@example.test',
};

test('a key the connector does not send is refused by name, before anything is read', async () => {
    const cases = [
        ['/auth/connector/bootstrap', { themingName: 'NC', organizationId: 'org-b' }, 'organizationId'],
        ['/auth/connector/bootstrap/pending/pb1/verify', { code: '123456', orgId: 'org-b' }, 'orgId'],
        ['/auth/connector/bootstrap/pending/pb1/resend', { email: 'x@example.test' }, 'email'],
        ['/auth/connector/bootstrap/pending/pb1/retarget', { email: 'x@example.test', role: 'org_admin' }, 'role'],
        ['/auth/connector/diagnose', { testToken: 't', tenantKey: 'k' }, 'tenantKey'],
    ];
    for (const [url, body, key] of cases) {
        const res = await api.call('POST', url, { body, headers: HEADERS });
        h.assertRefused(assert, res, 'body', new RegExp(`does not take "${key}"`));
    }
    assert.deepStrictEqual(db.queries, []);
});

test('the values stay the handler\'s: a code that is not six digits is still the connector\'s invalid_code', async () => {
    const res = await api.call('POST', '/auth/connector/bootstrap/pending/pb1/verify', { body: { code: 12 } });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'invalid_code');
    const retarget = await api.call('POST', '/auth/connector/bootstrap/pending/pb1/retarget', { body: { email: 'nobody', uid: 'u', displayName: 'U' } });
    assert.strictEqual(retarget.body.code, 'invalid_email');
});
