'use strict';

/**
 * The chat image tool on top of the shared image service: a refusal (image
 * limit, nothing configured, provider failure) comes back to the model as an
 * error it must pass on, and nothing is sent to the client.
 *
 * Run: cd server && node --test core/tools/imageGenTool.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { seams } = require('../media/imageGeneration.mts');
const storageStore = require('../../stores/storageStore');
const { executeImageGenTool } = require('./imageGenTool');

const realSeams = { ...seams };
test.afterEach(() => { Object.assign(seams, realSeams); });

/** What the image limit says next (null = may generate), and the calls Azure received. */
let limitReached = null;
const requests = [];

/** Azure with one priced deployment; the provider answers with a fixed image or throws `failure`. */
function useAzure(t, { failure = null } = {}) {
    seams.imageModels = () => ({
        IMAGE_PRICE_CURRENCY: 'EUR',
        resolveImageBackend: async (requested) => ({
            provider: 'azure', model: 'gpt-image-1.5', deployment: String(requested || '').replace('azure/', '') || 'img-prod',
            endpoint: 'https://res.openai.azure.com', apiKey: 'k', pricePerImage: 0.05,
        }),
    });
    seams.imageQuota = () => ({ checkImageLimit: async () => limitReached });
    seams.azureImages = () => ({
        generateAzureImage: async (input) => {
            requests.push(input);
            if (failure) throw failure;
            return { imageBase64: 'aW1n', mimeType: 'image/png', usage: null };
        },
    });
    const usage = [];
    seams.usageStore = () => ({ logUsage: async (row) => { usage.push(row); } });
    t.mock.method(storageStore, 'isAvailable', () => true);
    t.mock.method(storageStore, 'buildKey', (userId, folder, name) => `${userId}/${folder}/${name}`);
    t.mock.method(storageStore, 'uploadFile', async () => {});
    t.mock.method(storageStore, 'buildProxyUrl', (key) => `/files/${key}`);
    return usage;
}

const REQ = { session: { user: { id: 'u1', organizationId: 'org-1' } } };

test('the image goes to the client, is billed to the caller, and the tool reports where it was saved', async (t) => {
    requests.length = 0;
    const usage = useAzure(t);
    const sent = [];
    const result = await executeImageGenTool({ prompt: 'a bee', aspect_ratio: '16:9' }, { model: 'azure/img-prod' }, (type, data) => sent.push({ type, data }), REQ, { userId: 'u1', orgId: 'org-1', conversationId: 'c1' });
    assert.strictEqual(result.success, true);
    assert.match(result.imageUrl, /^\/files\/u1\/images\/img_/);
    assert.deepStrictEqual(sent, [{ type: 'image', data: { data: 'aW1n', mimeType: 'image/png' } }]);
    assert.strictEqual(requests[0].deployment, 'img-prod');
    assert.strictEqual(requests[0].aspectRatio, '16:9');
    assert.strictEqual(usage.length, 1);
    assert.strictEqual(usage[0].user_id, 'u1');
    assert.strictEqual(usage[0].organization_id, 'org-1');
    assert.strictEqual(usage[0].conversation_id, 'c1');
    assert.deepStrictEqual(usage[0].unit_cost, { amount: 0.05, currency: 'EUR' });
});

test('a used-up image limit is handed to the model as the message to pass on', async (t) => {
    requests.length = 0;
    const usage = useAzure(t);
    limitReached = { window: 'day', limit: 5, used: 5, message: 'You have reached your image limit (5 per 24 hours). Try again later or contact your administrator.' };
    try {
        const sent = [];
        const result = await executeImageGenTool({ prompt: 'a bee' }, null, (type, data) => sent.push({ type, data }), REQ);
        assert.strictEqual(result.success, undefined);
        assert.match(result.error, /reached their image limit/);
        assert.match(result.error, /5 per 24 hours/);
        assert.match(result.error, /Do NOT attempt to generate images using code/);
        assert.deepStrictEqual(sent, []);
        assert.strictEqual(requests.length + usage.length, 0, 'nothing generated, nothing billed');
    } finally {
        limitReached = null;
    }
});

test('an unexpected failure of the limit check is not turned into a tool answer', async (t) => {
    useAzure(t);
    seams.imageQuota = () => ({ checkImageLimit: async () => { throw new Error('database down'); } });
    await assert.rejects(executeImageGenTool({ prompt: 'a bee' }, null, () => {}, REQ), /database down/);
});
