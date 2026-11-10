/**
 * Gemini explicit context cache: a request served from a cache cannot carry
 * its own toolConfig, so a forced tool choice has to be stored in the cache
 * (and be part of its key). It used to be deleted from the request and kept
 * nowhere: 'required' silently became 'auto' once the system prompt was long
 * enough to be cached.
 *
 * Run: node --test core/providers/google.cacheToolChoice.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');

const GoogleProvider = require('./google');

const SYSTEM = 'You are a careful assistant. '.repeat(400); // well past the 1024-token cache floor
const TOOLS = [{ type: 'function', function: { name: 'answer', description: 'Give the answer', parameters: { type: 'object', properties: { value: { type: 'string' } } } } }];
const MSGS = [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'hi' }];

function stubbed() {
    const created = [];
    const requests = [];
    const p = new GoogleProvider();
    p.createClient = () => ({
        caches: { create: async (cfg) => { created.push(cfg); return { name: `cachedContents/${created.length}` }; } },
        models: { generateContent: async (params) => { requests.push(params); return { candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: {} }; } },
    });
    return { p, created, requests };
}

test('a forced tool choice is stored in the cache the request is served from', async () => {
    const { p, created, requests } = stubbed();
    await p.chat('k', null, 'gemini-3-flash-preview', MSGS, { tools: TOOLS, toolChoice: 'required' });

    assert.strictEqual(created.length, 1);
    assert.deepStrictEqual(created[0].config.toolConfig, { functionCallingConfig: { mode: 'ANY' } });
    assert.strictEqual(requests[0].config.cachedContent, 'cachedContents/1');
    assert.strictEqual(requests[0].config.toolConfig, undefined, 'the request itself may not carry it');
});

test('auto and forced calls do not share one cache', async () => {
    const { p, created, requests } = stubbed();
    await p.chat('k', null, 'gemini-3-flash-preview', MSGS, { tools: TOOLS });
    await p.chat('k', null, 'gemini-3-flash-preview', MSGS, { tools: TOOLS, toolChoice: 'required' });
    await p.chat('k', null, 'gemini-3-flash-preview', MSGS, { tools: TOOLS });

    assert.strictEqual(created.length, 2, 'one cache per tool choice; the third call reuses the first');
    assert.strictEqual(created[0].config.toolConfig, undefined);
    assert.deepStrictEqual(created[1].config.toolConfig, { functionCallingConfig: { mode: 'ANY' } });
    assert.deepStrictEqual(requests.map((r) => r.config.cachedContent), ['cachedContents/1', 'cachedContents/2', 'cachedContents/1']);
});
