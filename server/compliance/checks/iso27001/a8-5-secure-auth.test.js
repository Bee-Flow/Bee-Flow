'use strict';

/**
 * ISO27001-A.8.5-secure-auth — an SSO provider counts as configured when it
 * has a client id and a client secret, the way the SSO screen reads it. No
 * writer ever sets `enabled`, so the flag is not required.
 *
 * Run: cd server && node --test compliance/checks/iso27001/a8-5-secure-auth.test.js
 */

process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'test-master-key-a8-5';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-a8-5';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const configStore = require('../../../stores/configStore');
const check = require('./a8-5-secure-auth');

const savedGetConfig = configStore.getConfig;
afterEach(() => { configStore.getConfig = savedGetConfig; });

const withConfig = (cfg) => { configStore.getConfig = async (key) => cfg[key] ?? null; };

test('a Google provider with id and secret is SSO, although `enabled` is false', async () => {
    withConfig({ providers: { google: { clientId: 'id', clientSecret: 's', enabled: false } } });
    const r = await check.evaluate();
    assert.deepEqual(r.evidence.sso_providers_enabled, ['google']);
    assert.equal(r.status, 'pass');
});

test('Nextcloud needs URL, client id and secret', async () => {
    withConfig({ oauth: { nextcloudUrl: 'https://cloud.example.com', clientId: 'nc', clientSecret: 's' } });
    assert.deepEqual((await check.evaluate()).evidence.sso_providers_enabled, ['nextcloud']);
    withConfig({ oauth: { nextcloudUrl: 'https://cloud.example.com', clientId: 'nc' } });
    assert.deepEqual((await check.evaluate()).evidence.sso_providers_enabled, []);
});

test('a client id without a secret is not a working provider', async () => {
    withConfig({ providers: { google: { clientId: 'id', clientSecret: '' }, microsoft: { clientId: '', clientSecret: '' } } });
    const r = await check.evaluate();
    assert.deepEqual(r.evidence.sso_providers_enabled, []);
    assert.equal(r.status, 'warn');
});
