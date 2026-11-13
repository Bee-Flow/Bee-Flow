'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AzureImageError } = require('../providers/azureImages.mts');
const { generateImage, ImageGenerationError, seams } = require('./imageGeneration.mts');

const realSeams = { ...seams };
test.afterEach(() => { Object.assign(seams, realSeams); });

const WHO = { user_id: 'u1', organization_id: 'org-1', agent_id: null, agent_name: 'direct-chat', conversation_id: 'c1' };
const GOOGLE = { provider: 'google', model: 'gemini-3.1-flash-image-preview', apiKey: 'g-key' };
const AZURE = { provider: 'azure', model: 'gpt-image-1.5', deployment: 'img-prod', endpoint: 'https://res.openai.azure.com', apiKey: 'az-key', pricePerImage: 0.05 };

/** Stub every collaborator; returns what was called. */
function stub({ backend = GOOGLE, limit = null, azureResult = { imageBase64: 'QVo=', mimeType: 'image/png', usage: null }, googleResult = { imageBase64: 'R08=', mimeType: 'image/png', text: 'done' } } = {}) {
    const seen = { limitFor: [], azure: [], google: [], usage: [] };
    seams.imageModels = () => ({ resolveImageBackend: async () => backend, IMAGE_PRICE_CURRENCY: 'EUR' });
    seams.imageQuota = () => ({ checkImageLimit: async (userId) => { seen.limitFor.push(userId); return limit; } });
    seams.azureImages = () => ({
        generateAzureImage: async (input) => {
            seen.azure.push(input);
            if (azureResult instanceof Error) throw azureResult;
            return azureResult;
        },
    });
    seams.providers = () => ({ googleAdapter: { generateImage: async (apiKey, prompt, options) => { seen.google.push({ apiKey, prompt, options }); return googleResult; } } });
    seams.usageStore = () => ({ logUsage: async (entry) => { seen.usage.push(entry); } });
    return seen;
}

test('nothing configured is a 503 and nothing is checked or generated', async () => {
    const seen = stub({ backend: null });
    await assert.rejects(generateImage({ prompt: 'a bee', who: WHO }), (e) => e instanceof ImageGenerationError && e.code === 'not_configured' && e.status === 503);
    assert.deepEqual(seen, { limitFor: [], azure: [], google: [], usage: [] });
});

test('a used-up limit is a 429 before any provider is called', async () => {
    const seen = stub({ backend: AZURE, limit: { window: 'day', limit: 5, used: 5, message: 'You have reached your image limit (5 per 24 hours).' } });
    await assert.rejects(generateImage({ prompt: 'a bee', who: WHO }), (e) => e.code === 'limit_reached' && e.status === 429 && /5 per 24 hours/.test(e.message));
    assert.deepEqual(seen.limitFor, ['u1']);
    assert.equal(seen.azure.length + seen.google.length + seen.usage.length, 0);
});

test('a Google image is generated and logged as before', async () => {
    const seen = stub();
    const image = await generateImage({ prompt: 'a bee', aspectRatio: '16:9', who: WHO });
    assert.deepEqual(image, { imageBase64: 'R08=', mimeType: 'image/png', text: 'done', model: 'gemini-3.1-flash-image-preview', provider: 'google' });
    assert.deepEqual(seen.google, [{ apiKey: 'g-key', prompt: 'a bee', options: { aspectRatio: '16:9', model: 'gemini-3.1-flash-image-preview' } }]);
    assert.deepEqual(seen.usage, [{ ...WHO, model: 'gemini-3.1-flash-image-preview', source: 'image_generation', prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 }]);
});

test('an Azure image goes to its deployment and is logged at the price of one image', async () => {
    const seen = stub({ backend: AZURE });
    const image = await generateImage({ prompt: 'a bee', who: WHO });
    assert.equal(image.provider, 'azure');
    assert.equal(image.model, 'gpt-image-1.5');
    assert.equal(image.imageBase64, 'QVo=');
    assert.deepEqual(seen.azure, [{ endpoint: 'https://res.openai.azure.com', apiKey: 'az-key', deployment: 'img-prod', model: 'gpt-image-1.5', prompt: 'a bee', aspectRatio: '1:1' }]);
    assert.deepEqual(seen.usage, [{
        ...WHO, model: 'gpt-image-1.5', source: 'image_generation', provider_type: 'azure',
        prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
        unit_cost: { amount: 0.05, currency: 'EUR' },
    }]);
});

test('an Azure image without a price is logged with the tokens the API reported', async () => {
    const seen = stub({ backend: { ...AZURE, pricePerImage: null }, azureResult: { imageBase64: 'QVo=', mimeType: 'image/png', usage: { inputTokens: 12, outputTokens: 4160 } } });
    await generateImage({ prompt: 'a bee', who: WHO });
    assert.equal(seen.usage[0].prompt_tokens, 12);
    assert.equal(seen.usage[0].completion_tokens, 4160);
    assert.equal(seen.usage[0].total_tokens, 4172);
    assert.equal('unit_cost' in seen.usage[0], false);
});

test('a provider failure is a 502 with its message, and is not billed or counted', async () => {
    const filtered = new AzureImageError('content_filtered', 'The image was blocked by the content filter. Try a different prompt.', 400);
    const seen = stub({ backend: AZURE, azureResult: filtered });
    await assert.rejects(generateImage({ prompt: 'x', who: WHO }), (e) => e.code === 'provider_error' && e.status === 502 && /content filter/.test(e.message));
    assert.equal(seen.usage.length, 0);
});

test('an unexpected failure does not leak its text', async () => {
    stub({ backend: AZURE, azureResult: new Error('secret internal detail') });
    await assert.rejects(generateImage({ prompt: 'x', who: WHO }), (e) => e.code === 'provider_error' && !/secret/.test(e.message));
});

test('Google returning no image is a 502 no_image', async () => {
    const seen = stub({ googleResult: { imageBase64: null, mimeType: null, text: null } });
    await assert.rejects(generateImage({ prompt: 'x', who: WHO }), (e) => e.code === 'no_image' && e.status === 502);
    assert.equal(seen.usage.length, 0);
});
