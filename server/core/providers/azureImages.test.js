'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { azureImageFamily, buildAzureImageRequest, parseAzureImageResponse, generateAzureImage, AzureImageError } = require('./azureImages.mts');

const ENDPOINT = 'https://res.openai.azure.com';

test('the model decides the API family', () => {
    assert.equal(azureImageFamily('gpt-image-1.5'), 'openai');
    assert.equal(azureImageFamily('GPT-Image-2'), 'openai');
    assert.equal(azureImageFamily('MAI-Image-2.6-Flash'), 'mai');
    assert.equal(azureImageFamily('FLUX.2-pro'), 'flux');
    assert.equal(azureImageFamily('something-else'), 'openai');
});

test('a gpt-image request goes to the v1 Image API with the deployment as model', () => {
    const req = buildAzureImageRequest({ endpoint: `${ENDPOINT}/openai/deployments/x/chat/completions?api-version=1`, deployment: 'img-prod', model: 'gpt-image-1.5', prompt: 'a bee', aspectRatio: '16:9' });
    assert.equal(req.url, `${ENDPOINT}/openai/v1/images/generations?api-version=preview`);
    assert.deepEqual(req.body, { model: 'img-prod', prompt: 'a bee', n: 1, size: '1536x1024' });
});

test('aspect ratios map onto the three gpt-image sizes', () => {
    const size = (aspectRatio) => buildAzureImageRequest({ endpoint: ENDPOINT, deployment: 'd', model: 'gpt-image-2', prompt: 'p', aspectRatio }).body.size;
    assert.equal(size('1:1'), '1024x1024');
    assert.equal(size(undefined), '1024x1024');
    assert.equal(size('4:3'), '1536x1024');
    assert.equal(size('9:16'), '1024x1536');
    assert.equal(size('3:4'), '1024x1536');
    assert.equal(size('wide'), '1024x1024');
});

test('a MAI request goes to the MAI route with width and height inside the pixel budget', () => {
    const req = buildAzureImageRequest({ endpoint: 'https://res.services.ai.azure.com/openai/v1/', deployment: 'mai', model: 'MAI-Image-2.5', prompt: 'a bee', aspectRatio: '16:9' });
    assert.equal(req.url, 'https://res.services.ai.azure.com/mai/v1/images/generations');
    assert.deepEqual(req.body, { model: 'mai', prompt: 'a bee', width: 1360, height: 768 });
    for (const ratio of ['1:1', '16:9', '9:16', '4:3', '3:4', 'odd']) {
        const { width, height } = buildAzureImageRequest({ endpoint: ENDPOINT, deployment: 'mai', model: 'mai-image-2.5', prompt: 'p', aspectRatio: ratio }).body;
        assert.ok(width >= 768 && height >= 768, `${ratio}: each edge at least 768`);
        assert.ok(width * height <= 1024 * 1024, `${ratio}: at most 1024x1024 pixels`);
    }
});

test('a FLUX deployment is refused with a clear message', () => {
    assert.throws(
        () => buildAzureImageRequest({ endpoint: ENDPOINT, deployment: 'f', model: 'FLUX.2-pro', prompt: 'p' }),
        (err) => err instanceof AzureImageError && err.code === 'unsupported_model',
    );
});

test('the answer gives the image, and the usage when the API reports it', () => {
    assert.deepEqual(
        parseAzureImageResponse({ created: 1, data: [{ b64_json: 'QUJD' }], usage: { input_tokens: 12, output_tokens: 4160, total_tokens: 4172 } }),
        { imageBase64: 'QUJD', mimeType: 'image/png', usage: { inputTokens: 12, outputTokens: 4160 } },
    );
    assert.deepEqual(parseAzureImageResponse({ data: [{ b64_json: 'QUJD' }] }), { imageBase64: 'QUJD', mimeType: 'image/png', usage: null });
});

test('an answer without an image is an error, a filtered one says so', () => {
    assert.throws(() => parseAzureImageResponse({ data: [] }), (err) => err.code === 'no_image');
    assert.throws(() => parseAzureImageResponse(null), (err) => err.code === 'no_image');
    assert.throws(
        () => parseAzureImageResponse({ created: 1, error: { code: 'contentFilter', message: 'blocked' } }),
        (err) => err.code === 'content_filtered',
    );
});

/** A fetch stand-in that records the call and answers with the given status and body. */
function fakeFetch(status, body) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        return { ok: status >= 200 && status < 300, status, json: async () => body };
    };
    return { calls, fetchImpl };
}

test('generation posts the key in the api-key header and returns the image', async () => {
    const { calls, fetchImpl } = fakeFetch(200, { data: [{ b64_json: 'QUJD' }] });
    const result = await generateAzureImage({ endpoint: ENDPOINT, apiKey: 'k-123', deployment: 'img', model: 'gpt-image-1', prompt: 'a bee', fetchImpl });
    assert.equal(result.imageBase64, 'QUJD');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers['api-key'], 'k-123');
    assert.equal(calls[0].init.headers.Authorization, undefined);
    assert.deepEqual(JSON.parse(calls[0].init.body), { model: 'img', prompt: 'a bee', n: 1, size: '1024x1024' });
});

test('provider failures become errors with a code', async () => {
    const run = (status, body) => generateAzureImage({ endpoint: ENDPOINT, apiKey: 'k', deployment: 'img', model: 'gpt-image-1', prompt: 'p', fetchImpl: fakeFetch(status, body).fetchImpl });
    await assert.rejects(run(404, { error: { code: 'DeploymentNotFound' } }), (err) => err.code === 'deployment_not_found');
    await assert.rejects(run(401, {}), (err) => err.code === 'unauthorized');
    await assert.rejects(run(429, {}), (err) => err.code === 'rate_limited');
    await assert.rejects(run(400, { error: { code: 'content_policy_violation', message: 'no' } }), (err) => err.code === 'content_filtered');
    await assert.rejects(run(500, { error: { message: 'boom' } }), (err) => err.code === 'provider_error' && /boom/.test(err.message));
});

test('a network failure is reported as unreachable', async () => {
    const fetchImpl = async () => { throw new Error('ECONNRESET'); };
    await assert.rejects(
        generateAzureImage({ endpoint: ENDPOINT, apiKey: 'k', deployment: 'img', model: 'gpt-image-1', prompt: 'p', fetchImpl }),
        (err) => err.code === 'unreachable',
    );
});
