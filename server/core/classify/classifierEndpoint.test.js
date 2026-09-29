/**
 * Where classify-service lives: admin config first, then env.
 *
 * Run: node --test core/classify/classifierEndpoint.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { getClassifierEndpoint, invalidateClassifierEndpointCache } = require('./classifierEndpoint');

const store = (config, secrets = {}) => ({
    getConfig: async (k) => config[k] ?? null,
    getSecret: async (k) => secrets[k] ?? null,
});

test.beforeEach(() => invalidateClassifierEndpointCache());

test('the admin setting wins over env', async () => {
    const ep = await getClassifierEndpoint({
        store: store({ automation_classifier_url: 'http://admin:8300/' }, { automation_classifier_api_key: 's' }),
        env: { CLASSIFY_SERVICE_URL: 'http://env:8300' },
    });
    assert.deepEqual(ep, { url: 'http://admin:8300', apiKey: 's' });
});

test('env, with the shared services key as the fallback key', async () => {
    const ep = await getClassifierEndpoint({ store: store({}), env: { CLASSIFY_SERVICE_URL: 'http://env:8300', SERVICES_API_KEY: 'shared' } });
    assert.deepEqual(ep, { url: 'http://env:8300', apiKey: 'shared' });
});

test('a broken config store falls through to env', async () => {
    const broken = { getConfig: async () => { throw new Error('db down'); }, getSecret: async () => null };
    const ep = await getClassifierEndpoint({ store: broken, env: { CLASSIFY_SERVICE_URL: 'http://env:8300', CLASSIFY_SERVICE_API_KEY: 'own' } });
    assert.deepEqual(ep, { url: 'http://env:8300', apiKey: 'own' });
});

test('nothing configured is a null url', async () => {
    const ep = await getClassifierEndpoint({ store: null, env: {} });
    assert.equal(ep.url, null);
});

test('the answer is cached briefly', async () => {
    await getClassifierEndpoint({ store: null, env: { CLASSIFY_SERVICE_URL: 'http://first:8300' } });
    const ep = await getClassifierEndpoint({ store: null, env: { CLASSIFY_SERVICE_URL: 'http://second:8300' } });
    assert.equal(ep.url, 'http://first:8300');
});
