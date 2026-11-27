'use strict';
/**
 * POST /providers/microsoft/test (auth/oauth/ssoConfigRoutes.js) without the module "meetingNotes",
 * whose live test (a client-credentials token request) it is: sign-in with Microsoft is core, so
 * the route still checks what the administrator typed, the way the Google test does: the format of
 * the client id (a GUID) and of the tenant. The live test is ssoConfigRoutes.microsoftTest.test.js
 * (the module's).
 *
 * Run: cd server && node --test auth/oauth/ssoConfigRoutes.microsoftFormat.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TENANT = '11111111-2222-3333-4444-555555555555';
const fx = { microsoft: /** @type {Record<string, string>} */ ({}) };

const harness = require('../../testUtils/routeHarness');
harness.openGates({ loadConfig: async () => ({ providers: { microsoft: fx.microsoft } }) });

// No live test here, whatever this checkout holds: the name the meeting notes module provides is cleared.
const featureModules = require('../../core/featureModules');
const router = require('./ssoConfigRoutes');
featureModules._clearFeatureModulesForTests('routes/teamsProviderTest');

const ADMIN = { isAuthenticated: true, isAdmin: true, user: { id: 'root', role: 'admin' } };
const send = harness.dispatcher(router);
/** @param {Record<string, string>} microsoft the stored primary registration */
const testWith = (microsoft) => {
    fx.microsoft = microsoft;
    return send({ method: 'POST', url: '/providers/microsoft/test', session: ADMIN });
};

test('a well-formed registration answers 200 with the format check, and says the live test is the module\'s', async () => {
    const res = await testWith({ clientId: CLIENT, clientSecret: 'fixture-not-a-secret', tenantId: TENANT });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, {
        success: true,
        message: 'Microsoft app registration configured (format valid). The live test of the registration is part of the meeting notes module.',
    });
});

test('a blank tenant is the multi-tenant default and passes; a tenant alias passes too', async () => {
    assert.equal((await testWith({ clientId: CLIENT })).statusCode, 200);
    assert.equal((await testWith({ clientId: CLIENT, tenantId: 'organizations' })).statusCode, 200);
});

test('no client id, a client id that is not a GUID, or a malformed tenant answers 400 with the reason', async () => {
    let res = await testWith({});
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'Microsoft Client ID not configured');
    res = await testWith({ clientId: 'not-a-guid', tenantId: TENANT });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'Invalid Microsoft Client ID format');
    res = await testWith({ clientId: CLIENT, tenantId: 'contoso' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'Invalid Microsoft tenant ID format');
});
