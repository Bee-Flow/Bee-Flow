'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { webSearchProviderStatus } = require('./webSearchAvailability');

function deps({ config = {}, secrets = {}, env = {} } = {}) {
    return {
        env,
        configStore: {
            getConfig: async (k) => config[k] ?? null,
            getSecret: async (k) => secrets[k] ?? null,
        },
    };
}

test('agent-search (the default) needs the service URL, from env or admin config', async () => {
    assert.equal((await webSearchProviderStatus(deps())).available, false);
    assert.equal((await webSearchProviderStatus(deps({ env: { SEARCH_SERVICE_URL: 'http://s' } }))).available, true);
    assert.equal((await webSearchProviderStatus(deps({ config: { agent_search_url: 'http://s' } }))).available, true);
});

test('agent-search without its URL falls back to node-search when a Serper key exists', async () => {
    const s = await webSearchProviderStatus(deps({ secrets: { serper_api_key: 'k' } }));
    assert.deepEqual(s, { available: true, provider: 'agent-search', fallbackToNode: true });
});

test('bing and node-search need their own key; disabled is never available', async () => {
    assert.equal((await webSearchProviderStatus(deps({ config: { search_provider: 'bing' } }))).available, false);
    assert.equal((await webSearchProviderStatus(deps({ config: { search_provider: 'bing' }, secrets: { bing_search_key: 'k' } }))).available, true);
    assert.equal((await webSearchProviderStatus(deps({ config: { search_provider: 'node-search' }, secrets: { serper_api_key: 'k' } }))).available, true);
    assert.equal((await webSearchProviderStatus(deps({ config: { search_provider: 'disabled', agent_search_url: 'http://s' }, secrets: { serper_api_key: 'k' } }))).available, false);
});
