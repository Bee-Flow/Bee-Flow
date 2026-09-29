/**
 * The Graph client's two layers: graphRequest hands the Response back
 * untouched (the HTTP status is the answer for 412/423/404, no Content-Type
 * is forced onto a Buffer body, one refresh-and-retry on 401 that persists
 * rotated tokens through session.save), and graphFetch keeps its historical
 * contract on top of it (JSON default a caller can override, a thrown
 * message on failure, {success:true} for 202/204).
 *
 * '../auth/permissions' is stubbed (loadConfig + the refresh scope) and the
 * global fetch is a recording stub.
 *
 * Run: cd server && node --test integrations/msGraphClient.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../testUtils/stubRequire');

const restore = installResolveStub({
    '../auth/permissions': {
        loadConfig: async () => ({ providers: { microsoft: { clientId: 'cid', clientSecret: 'csecret', tenantId: 'common' } } }),
        microsoftRefreshScope: (scope) => scope || 'offline_access Files.ReadWrite',
    },
});
const { graphRequest, graphFetch, GRAPH_BASE } = require('./msGraphClient');
test.after(() => restore());

const calls = [];
const world = { answers: [] };   // queue of responses for Graph calls; the token endpoint answers separately
const realFetch = globalThis.fetch;
test.beforeEach(() => {
    calls.length = 0;
    world.answers = [];
    globalThis.fetch = async (url, options = {}) => {
        calls.push({ url: String(url), options });
        if (String(url).includes('login.microsoftonline.com')) {
            return new Response(JSON.stringify({ access_token: 'at_new', refresh_token: 'rt_new', expires_in: 3600 }), { status: 200 });
        }
        const next = world.answers.shift();
        if (!next) throw new Error('no answer queued');
        return next;
    };
});
test.afterEach(() => { globalThis.fetch = realFetch; });

test('graphRequest: bearer only, no forced Content-Type, relative and absolute paths, the Response comes back as-is', async () => {
    world.answers.push(new Response('bytes', { status: 412 }));
    const session = { accessToken: 'at' };
    const res = await graphRequest('/drives/d/items/i/content', session, { method: 'PUT', body: Buffer.from('x'), headers: { 'If-Match': '"e1"' } });
    assert.equal(res.status, 412, 'the status survives — graphFetch would have thrown a bare message');
    assert.equal(await res.text(), 'bytes');
    assert.equal(calls[0].url, `${GRAPH_BASE}/drives/d/items/i/content`);
    assert.equal(calls[0].options.method, 'PUT');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer at');
    assert.equal(calls[0].options.headers['If-Match'], '"e1"');
    assert.equal(calls[0].options.headers['Content-Type'], undefined, 'a Buffer body is not labelled JSON');
    world.answers.push(new Response('{}', { status: 200 }));
    await graphRequest('https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=x', session);
    assert.equal(calls[1].url, 'https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=x');
});

test('graphRequest: a 401 refreshes once, retries with the new token, and the session\'s save() persists the rotation', async () => {
    world.answers.push(new Response('', { status: 401 }), new Response('{"id":"x"}', { status: 200 }));
    let saved = 0;
    const session = { accessToken: 'at_old', refreshToken: 'rt_old', oauthScope: 'Files.ReadWrite', save: () => { saved += 1; } };
    const res = await graphRequest('/me/drive', session);
    assert.equal(res.status, 200);
    assert.equal(calls.length, 3, 'first try, token endpoint, retry');
    assert.match(calls[1].url, /login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/token/);
    assert.equal(calls[2].options.headers.Authorization, 'Bearer at_new');
    assert.equal(session.accessToken, 'at_new');
    assert.equal(session.refreshToken, 'rt_new');
    assert.equal(saved, 1);
});

test('graphRequest: without a token or with a refresh that fails it throws NOT_CONNECTED', async () => {
    await assert.rejects(() => graphRequest('/me', {}), /NOT_CONNECTED/);
    world.answers.push(new Response('', { status: 401 }));
    await assert.rejects(() => graphRequest('/me', { accessToken: 'at' }), /NOT_CONNECTED/);
});

test('graphFetch: JSON by default, the caller\'s Content-Type wins, parsed body on success', async () => {
    world.answers.push(new Response('{"value":[1]}', { status: 200 }));
    const data = await graphFetch('/me/messages', { accessToken: 'at' }, { method: 'POST', body: '{}' });
    assert.deepEqual(data, { value: [1] });
    assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
    world.answers.push(new Response('{}', { status: 200 }));
    await graphFetch('/x', { accessToken: 'at' }, { headers: { 'Content-Type': 'text/plain' } });
    assert.equal(calls[1].options.headers['Content-Type'], 'text/plain');
});

test('graphFetch: 202/204 → {success:true}; a failure throws Graph\'s message (status not attached — use graphRequest for that)', async () => {
    world.answers.push(new Response(null, { status: 204 }));
    assert.deepEqual(await graphFetch('/x', { accessToken: 'at' }, { method: 'DELETE' }), { success: true });
    world.answers.push(new Response(JSON.stringify({ error: { code: 'itemNotFound', message: 'The resource could not be found.' } }), { status: 404 }));
    await assert.rejects(() => graphFetch('/x', { accessToken: 'at' }), (e) => e.message === 'The resource could not be found.' && e.status === undefined);
});
