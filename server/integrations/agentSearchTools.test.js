// @typecheck
/**
 * agentSearchTools: a failed search is an `{ error }` object (so every tool
 * loop counts it as a failed call, not as a successful answer), and the time
 * one request may take comes from AGENT_SEARCH_TIMEOUT_MS.
 *
 * Run: cd server && node --test integrations/agentSearchTools.test.js
 */

'use strict';

const { test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert');

// The tool calls configStore through its exports object, so the two lookups
// are replaced on the real module for this file and put back afterwards.
const configStore = require('../stores/configStore');
const realConfig = { getConfig: configStore.getConfig, getSecret: configStore.getSecret };
configStore.getConfig = async (/** @type {string} */ key) => (key === 'agent_search_url' ? 'https://search.example.test' : null);
configStore.getSecret = async () => null;
after(() => { configStore.getConfig = realConfig.getConfig; configStore.getSecret = realConfig.getSecret; });

const { executeAgentSearchTool, searchTimeoutMs } = require('./agentSearchTools');
const { isToolErrorResult } = require('../core/automationRunner/shared');

const realFetch = globalThis.fetch;
const savedEnv = { url: process.env.SEARCH_SERVICE_URL, timeout: process.env.AGENT_SEARCH_TIMEOUT_MS };
/** @type {Array<{ url: string, init: any }>} */
let fetches = [];

/**
 * A fetch that never answers on its own: only the request's signal ends it.
 * The timeout's own timer does not hold the event loop open, so a ref'd one
 * stands in for the socket a real request would keep open.
 */
function hangingFetch(/** @type {any} */ url, /** @type {any} */ init) {
    fetches.push({ url: String(url), init });
    return new Promise((_resolve, reject) => {
        const socket = setTimeout(() => reject(new Error('the signal never fired')), 5000);
        if (init && init.signal) {
            init.signal.addEventListener('abort', () => { clearTimeout(socket); reject(init.signal.reason); });
        }
    });
}

/** @param {string|undefined} v @param {string} key */
const setEnv = (key, v) => { if (v === undefined) delete process.env[key]; else process.env[key] = v; };

beforeEach(() => {
    fetches = [];
    delete process.env.SEARCH_SERVICE_URL;
    delete process.env.AGENT_SEARCH_TIMEOUT_MS;
});
afterEach(() => {
    globalThis.fetch = realFetch;
    setEnv('SEARCH_SERVICE_URL', savedEnv.url);
    setEnv('AGENT_SEARCH_TIMEOUT_MS', savedEnv.timeout);
});

test('AGENT_SEARCH_TIMEOUT_MS: default 30 s, a number overrides it, 0 means no timeout, junk keeps the default', () => {
    assert.strictEqual(searchTimeoutMs(), 30000);
    process.env.AGENT_SEARCH_TIMEOUT_MS = '45000';
    assert.strictEqual(searchTimeoutMs(), 45000);
    process.env.AGENT_SEARCH_TIMEOUT_MS = '0';
    assert.strictEqual(searchTimeoutMs(), 0);
    process.env.AGENT_SEARCH_TIMEOUT_MS = 'soon';
    assert.strictEqual(searchTimeoutMs(), 30000);
    process.env.AGENT_SEARCH_TIMEOUT_MS = '-5';
    assert.strictEqual(searchTimeoutMs(), 30000);
});

test('a search that times out is an { error } object that names the timeout', async () => {
    process.env.AGENT_SEARCH_TIMEOUT_MS = '20';
    globalThis.fetch = /** @type {any} */ (hangingFetch);
    const r = await executeAgentSearchTool('agent_search', { query: 'weer Amsterdam' });
    assert.deepStrictEqual(r, { error: 'Search failed: timeout after 20 ms' });
    assert.ok(isToolErrorResult(r), 'a tool loop must count it as a failed call');
    assert.strictEqual(fetches[0].url, 'https://search.example.test/tools/search');
});

test('the timeout is rounded to seconds in the message', async () => {
    process.env.AGENT_SEARCH_TIMEOUT_MS = '1500';
    globalThis.fetch = /** @type {any} */ (async (_url, init) => {
        fetches.push({ url: String(_url), init });
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
    });
    const r = await executeAgentSearchTool('agent_search', { query: 'weer Amsterdam' });
    assert.deepStrictEqual(r, { error: 'Search failed: timeout after 2 s' });
});

test('with AGENT_SEARCH_TIMEOUT_MS=0 the request carries no timeout signal', async () => {
    process.env.AGENT_SEARCH_TIMEOUT_MS = '0';
    globalThis.fetch = /** @type {any} */ (async (url, init) => {
        fetches.push({ url: String(url), init });
        return new Response(JSON.stringify({ results: [{ title: 'Weer', url: 'https://example.nl/weer', markdown: 'Zonnig' }] }), { status: 200 });
    });
    const r = await executeAgentSearchTool('agent_search', { query: 'weer Amsterdam' });
    assert.strictEqual(fetches[0].init.signal, undefined);
    assert.strictEqual(typeof r, 'string');
    assert.match(String(r), /Zonnig/);
});

test('an HTTP error from the service is an { error } object too', async () => {
    globalThis.fetch = /** @type {any} */ (async (url, init) => {
        fetches.push({ url: String(url), init });
        return new Response('upstream down', { status: 502 });
    });
    const r = await executeAgentSearchTool('agent_search', { query: 'weer Amsterdam' });
    assert.ok(isToolErrorResult(r));
    assert.match(/** @type {any} */ (r).error, /^Search failed: Agent Search API error \(502\)/);
    assert.ok(fetches[0].init.signal, 'the default timeout is on');
});
