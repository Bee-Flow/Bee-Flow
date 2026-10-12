'use strict';
/**
 * configuredSsoProviders — the one SSO predicate ISO A.8.5 and NIS2
 * Art. 21(2)(j) share: client id AND secret, never an `enabled` flag.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { configuredSsoProviders } = require('./ssoProviders');

test('a provider with a client id and secret is configured, with or without an enabled flag', () => {
    assert.deepEqual(configuredSsoProviders({ google: { clientId: 'id', clientSecret: 's' } }, null), ['google']);
    assert.deepEqual(configuredSsoProviders({ google: { clientId: 'id', clientSecret: 's', enabled: false } }, null), ['google'],
        'no writer sets enabled, so it is not read');
});

test('a client id without a secret is not configured', () => {
    assert.deepEqual(configuredSsoProviders({ google: { enabled: true, clientId: 'id' }, microsoft: { clientId: '', clientSecret: 's' } }, null), []);
});

test('Nextcloud needs its URL, client id and secret', () => {
    assert.deepEqual(configuredSsoProviders(null, { nextcloudUrl: 'https://cloud.example.com', clientId: 'nc', clientSecret: 's' }), ['nextcloud']);
    assert.deepEqual(configuredSsoProviders(null, { nextcloudUrl: 'https://cloud.example.com', clientId: 'nc' }), []);
    assert.deepEqual(configuredSsoProviders(null, { clientId: 'nc', clientSecret: 's' }), []);
});

test('missing config is no providers, not a throw', () => {
    assert.deepEqual(configuredSsoProviders(undefined, undefined), []);
    assert.deepEqual(configuredSsoProviders({ google: null }, {}), []);
});
