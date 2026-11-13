'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const configStore = require('../../stores/configStore');
const { parseAzureImageModels, listImageModels, resolveImageBackend, isImageGenerationAvailable } = require('./imageModels.mts');

/** Stub what is configured. */
function configure(t, { google = null, azureKey = null, endpoint = null, models = null } = {}) {
    t.mock.method(configStore, 'getSecret', async (key) => ({ google_api_key: google, azure_api_key: azureKey }[key] ?? null));
    t.mock.method(configStore, 'getConfig', async (key) => ({ azure_endpoint: endpoint, azure_image_models: models }[key] ?? null));
}

const AZURE = { azureKey: 'az-key', endpoint: 'https://res.openai.azure.com', models: [{ deployment: 'img-prod', model: 'gpt-image-1.5', pricePerImage: 0.05 }, { deployment: 'MAI-Image-2.6' }] };

test('the stored list is normalised: names trimmed, model defaults to the deployment, bad prices dropped', () => {
    assert.deepEqual(parseAzureImageModels([
        { deployment: ' img ', model: ' gpt-image-2 ', pricePerImage: '0.04' },
        { deployment: 'plain' },
        { deployment: 'neg', pricePerImage: -1 },
        { deployment: 'img', model: 'duplicate' },
        { deployment: '' }, null, 'text',
    ]), [
        { deployment: 'img', model: 'gpt-image-2', pricePerImage: 0.04 },
        { deployment: 'plain', model: 'plain', pricePerImage: null },
        { deployment: 'neg', model: 'neg', pricePerImage: null },
    ]);
    assert.deepEqual(parseAzureImageModels('[{"deployment":"a"}]'), [{ deployment: 'a', model: 'a', pricePerImage: null }]);
    for (const v of [null, undefined, '', 'nope', {}, 5]) assert.deepEqual(parseAzureImageModels(v), []);
});

test('nothing configured: no models, no backend', async (t) => {
    configure(t);
    assert.deepEqual(await listImageModels(), []);
    assert.equal(await resolveImageBackend('gemini-3-pro-image-preview'), null);
    assert.equal(await isImageGenerationAvailable(), false);
});

test('Azure deployments without the endpoint or key are not offered', async (t) => {
    configure(t, { ...AZURE, azureKey: null });
    assert.deepEqual(await listImageModels(), []);
    assert.equal(await isImageGenerationAvailable(), false);
});

test('both providers: Google first, Azure deployments by azure/<deployment>, no secrets or prices', async (t) => {
    configure(t, { google: 'g-key', ...AZURE });
    assert.deepEqual(await listImageModels(), [
        { id: 'gemini-3.1-flash-image-preview', label: 'Flash Image (Fast)', provider: 'google' },
        { id: 'gemini-3-pro-image-preview', label: 'Pro Image (Quality)', provider: 'google' },
        { id: 'azure/img-prod', label: 'gpt-image-1.5 (img-prod)', provider: 'azure' },
        { id: 'azure/MAI-Image-2.6', label: 'MAI-Image-2.6', provider: 'azure' },
    ]);
});

test('the requested model wins when it is available', async (t) => {
    configure(t, { google: 'g-key', ...AZURE });
    assert.deepEqual(await resolveImageBackend('azure/img-prod'), {
        provider: 'azure', model: 'gpt-image-1.5', deployment: 'img-prod',
        endpoint: 'https://res.openai.azure.com', apiKey: 'az-key', pricePerImage: 0.05,
    });
    assert.deepEqual(await resolveImageBackend('gemini-3-pro-image-preview'), { provider: 'google', model: 'gemini-3-pro-image-preview', apiKey: 'g-key' });
});

test('without a request the default is Google, and Azure when Google is not configured', async (t) => {
    configure(t, { google: 'g-key', ...AZURE });
    assert.equal((await resolveImageBackend(null)).model, 'gemini-3.1-flash-image-preview');
    assert.equal((await resolveImageBackend('azure/gone')).provider, 'google', 'an unknown deployment falls back');
    configure(t, AZURE);
    const backend = await resolveImageBackend('gemini-3-pro-image-preview');
    assert.equal(backend.provider, 'azure', 'a Google model without a Google key falls back to Azure');
    assert.equal(backend.deployment, 'img-prod');
});
