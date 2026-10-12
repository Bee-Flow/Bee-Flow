const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

let config;
const restore = installResolveStub({
    '../aiAgent': { getAIConfig: async () => config },
});
const { mistralOCR, getMistralOCRApiKey } = require('./ocr');
after(() => restore());

const realFetch = global.fetch;
let calls;
beforeEach(() => {
    calls = [];
    delete process.env.MISTRAL_API_KEY;
    global.fetch = async (url, init) => {
        calls.push({ url, init });
        return { ok: true, json: async () => ({ pages: [{ index: 0, markdown: 'hi' }] }) };
    };
});
after(() => { global.fetch = realFetch; });

test('BFSF-388: a non-Mistral default provider key is never sent to Mistral', async () => {
    config = { providerType: 'openai', url: 'https://api.openai.com/v1', apiKey: 'sk-openai-secret', mistralOcrApiKey: null };
    assert.equal(await mistralOCR('AAAA', 'application/pdf', 'a.pdf'), null);
    assert.equal(calls.length, 0, 'no document left the instance');
    assert.equal(await getMistralOCRApiKey(), null);
});

test('the dedicated OCR key is used', async () => {
    config = { providerType: 'openai', apiKey: 'sk-openai', mistralOcrApiKey: 'ocr-key' };
    assert.equal(await mistralOCR('AAAA', 'application/pdf', 'a.pdf'), '[Page 1]\nhi');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer ocr-key');
});

test('a Mistral default provider key may be reused', async () => {
    config = { providerType: 'mistral', apiKey: 'mk' };
    await mistralOCR('AAAA', 'application/pdf', 'a.pdf');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer mk');
});

test('legacy config without a type is Mistral only by host', async () => {
    config = { url: 'https://api.mistral.ai/v1', apiKey: 'mk' };
    assert.equal(await getMistralOCRApiKey(), 'mk');
    config = { url: 'https://example.com/v1', apiKey: 'other' };
    assert.equal(await getMistralOCRApiKey(), null);
});

test('MISTRAL_API_KEY env still works', async () => {
    process.env.MISTRAL_API_KEY = 'env-key';
    config = { providerType: 'claude', apiKey: 'sk-ant' };
    await mistralOCR('AAAA', 'application/pdf', 'a.pdf');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer env-key');
});

test('BFSF-388: the explicit mistral_api_key secret is used next to a non-Mistral default provider', async () => {
    config = { providerType: 'claude', apiKey: 'sk-ant', mistralApiKey: 'mk' };
    await mistralOCR('AAAA', 'application/pdf', 'a.pdf');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer mk');
    assert.equal(await getMistralOCRApiKey(), 'mk');
});

test('BFSF-388: no Mistral secret and a non-Mistral default still makes no request', async () => {
    config = { providerType: 'openai', apiKey: 'sk-openai', mistralApiKey: null };
    assert.equal(await mistralOCR('AAAA', 'application/pdf', 'a.pdf'), null);
    assert.equal(calls.length, 0);
});
