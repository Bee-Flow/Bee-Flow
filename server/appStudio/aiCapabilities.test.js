'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { aiCapabilitiesFor } = require('./aiCapabilities.mts');

test('answers per integration for the OWNER, with the provider and the browser', async () => {
    const asked = [];
    const out = await aiCapabilitiesFor({ userId: 'owner1' }, {
        isPermitted: async (uid, integration) => { asked.push([uid, integration]); return integration === 'agent-search'; },
        searchProviderAvailable: async () => true,
        browserBackendAvailable: async () => false,
    });
    assert.deepStrictEqual(out, {
        webSearch: { integrationAllowed: true, providerAvailable: true },
        browsing: { integrationAllowed: false, backendAvailable: false },
    });
    assert.deepStrictEqual(asked.sort(), [['owner1', 'agent-search'], ['owner1', 'browser-fetch']]);
});

test('a check that throws reads as not available, never as a failed request', async () => {
    const boom = async () => { throw new Error('down'); };
    const out = await aiCapabilitiesFor({ userId: 'u' }, { isPermitted: boom, searchProviderAvailable: boom, browserBackendAvailable: boom });
    assert.deepStrictEqual(out, {
        webSearch: { integrationAllowed: false, providerAvailable: false },
        browsing: { integrationAllowed: false, backendAvailable: false },
    });
});
