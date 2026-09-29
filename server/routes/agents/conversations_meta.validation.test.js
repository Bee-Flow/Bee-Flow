'use strict';

/**
 * What the cross-agent conversation search accepts, and what it says when it
 * refuses (routes/agents/conversations_meta.js).
 *
 * `source` decided which two halves of the search ran, and it decided them by
 * saying what it is NOT: `includeAgents = source !== 'direct'` and
 * `includeDirect = source !== 'agent'`. So `source=agents` — one letter off —
 * switched BOTH halves on, and somebody who had narrowed to their agent
 * conversations was handed their direct chats as well, under a 200. What this
 * file pins is the part a caller can act on:
 *
 *   - the 400 NAMES the field (`query.source`), not just "invalid request";
 *   - the message is a sentence, and lists the values;
 *   - the store is never reached, so a refused search reads nothing.
 *
 * Run: cd server && node --test routes/agents/conversations_meta.validation.test.js
 */

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const SERVER = path.resolve(__dirname, '..', '..');
function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

// Every store read lands in `touched`. A refused request must leave it empty.
const touched = [];

mock(path.join(SERVER, 'stores/agentStore'), {
    listAllConversations: async () => [],
    getAgent: async (id) => ({ id, owner_id: 'me' }),
    searchConversations: async (...a) => { touched.push({ what: 'searchConversations', args: a }); return []; },
    searchDirectConversations: async (...a) => { touched.push({ what: 'searchDirectConversations', args: a }); return []; },
});
mock(path.join(SERVER, 'utils/routeHelpers'), { getEffectiveUserId: () => 'me' });
mock(path.join(SERVER, 'core/agentRuntime'), {});
mock(path.join(SERVER, 'core/aiAgent'), {});
mock(path.join(SERVER, 'stores/configStore'), {});
mock(path.join(SERVER, 'auth'), {});
mock(path.join(SERVER, 'stores/memoryStore'), {});
mock(path.join(SERVER, 'stores/userStore'), {});
mock(path.join(SERVER, 'stores/usageStore'), {});
mock(path.join(SERVER, 'core/entitlements/limits'), {});
mock(path.join(SERVER, 'core/http/sseHelpers'), {});

const router = require('./conversations_meta');
const { terminalErrorHandler } = require(path.join(SERVER, 'core/http/terminalErrorHandler'));

function dispatch(url) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method: 'GET', url, originalUrl: url, path: pathname, query, body: {}, headers: {},
            session: { user: { id: 'me' } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headers: {},
            set(k, v) { this.headers[k] = v; return this; }, setHeader() {},
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: GET ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { touched.length = 0; });

async function refuses(url, field) {
    const res = await dispatch(url);
    assert.strictEqual(res.statusCode, 400, `${url} -> ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
    return res;
}

test('a source one letter off is refused, not read as "both halves"', async () => {
    const res = await refuses('/conversations/search?q=factuur&source=agents', 'query.source');
    assert.strictEqual(res.body.error, 'source is "agent" or "direct".');
});

test('a misspelled filter is refused, not dropped into a wider search', async () => {
    await refuses('/conversations/search?q=factuur&agent_id=a1', 'query');
});

test('a limit that is not a number is refused in words', async () => {
    const res = await dispatch('/conversations/search?q=factuur&limit=veel');
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'limit must be a number.');
    assert.deepStrictEqual(touched, []);
});

test('the two halves a caller may pick still narrow', async () => {
    const res = await dispatch('/conversations/search?q=factuur&source=direct');
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.map((t) => t.what), ['searchDirectConversations']);
});

test('a half-typed search still answers an empty list rather than a refusal', async () => {
    // One character is the search box mid-word, not a bad request.
    const res = await dispatch('/conversations/search?q=f');
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, []);
    assert.deepStrictEqual(touched, []);
});
