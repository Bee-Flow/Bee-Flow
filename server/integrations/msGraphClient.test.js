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
const { graphRequest, graphFetch, graphBatch, GRAPH_BASE, _setSleepForTests } = require('./msGraphClient');
// Throttling waits are recorded, never slept.
const waits = [];
const restoreSleep = _setSleepForTests(async (ms) => { waits.push(ms); });
test.after(() => { restoreSleep(); restore(); });

const calls = [];
const world = { answers: [] };   // queue of responses for Graph calls; the token endpoint answers separately
const realFetch = globalThis.fetch;
test.beforeEach(() => {
    calls.length = 0;
    waits.length = 0;
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

// ── Throttling (Graph: 429 + Retry-After) ──────────────────────────────

const throttled = (retryAfter) => new Response('{"error":{"code":"TooManyRequests"}}', { status: 429, headers: retryAfter ? { 'Retry-After': retryAfter } : {} });

test('graphRequest: a 429 waits as long as Graph asks and sends again, a POST too (429 = never processed)', async () => {
    world.answers.push(throttled('2'), new Response(null, { status: 202 }));
    const out = await graphFetch('/me/sendMail', { accessToken: 'at' }, { method: 'POST', body: '{"message":{}}' });
    assert.deepEqual(out, { success: true });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.body, '{"message":{}}');
    assert.deepEqual(waits, [2000]);
});

test('graphRequest: a 503 is sent again for a GET, never for a POST that may have sent mail', async () => {
    world.answers.push(new Response('', { status: 503 }), new Response('{"id":"m"}', { status: 200 }));
    assert.equal((await graphRequest('/me/messages/m', { accessToken: 'at' })).status, 200);
    assert.equal(calls.length, 2);
    world.answers.push(new Response('', { status: 503 }));
    assert.equal((await graphRequest('/me/sendMail', { accessToken: 'at' }, { method: 'POST', body: '{}' })).status, 503);
    assert.equal(calls.length, 3, 'the POST went out once');
});

test('graphRequest: a read retries three times at most, and the last answer comes back untouched', async () => {
    world.answers.push(throttled('1'), throttled('1'), throttled('1'), new Response('still busy', { status: 429 }));
    const res = await graphRequest('/me/messages', { accessToken: 'at' });
    assert.equal(res.status, 429);
    assert.equal(await res.text(), 'still busy');
    assert.equal(calls.length, 4);
    assert.deepEqual(waits, [1000, 1000, 1000]);
});

test('graphRequest: a read waits 30 seconds in all; a day-long Retry-After is clamped, then it gives up', async () => {
    world.answers.push(throttled('86400'), throttled('86400'));
    const res = await graphRequest('/me/messages', { accessToken: 'at' });
    assert.equal(res.status, 429);
    assert.deepEqual(waits, [30_000]);
    assert.equal(calls.length, 2);
});

test('graphRequest: a write waits once at most, and only for a short Retry-After (a person may click Send again)', async () => {
    world.answers.push(throttled('10'));
    assert.equal((await graphRequest('/me/sendMail', { accessToken: 'at' }, { method: 'POST', body: '{}' })).status, 429);
    assert.equal(calls.length, 1, 'ten seconds is too long to make a sender wait');
    world.answers.push(throttled('1'), throttled('1'));
    assert.equal((await graphRequest('/me/sendMail', { accessToken: 'at' }, { method: 'POST', body: '{}' })).status, 429);
    assert.equal(calls.length, 3, 'one retry, not three');
    assert.deepEqual(waits, [1000]);
});

test('graphRequest: a token that runs out during the wait is refreshed, once', async () => {
    world.answers.push(throttled('1'), new Response('', { status: 401 }), new Response('{"id":"m"}', { status: 200 }));
    const session = { accessToken: 'at_old', refreshToken: 'rt_old' };
    const res = await graphRequest('/me/messages/m', session);
    assert.equal(res.status, 200);
    assert.equal(session.accessToken, 'at_new');
    assert.equal(calls.filter(c => c.url.includes('login.microsoftonline.com')).length, 1);
});

test('graphRequest: a stream body is not sent again (the first attempt consumed it)', async () => {
    world.answers.push(throttled('1'));
    const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } });
    const res = await graphRequest('/me/drive/root:/x:/content', { accessToken: 'at' }, { method: 'PUT', body: stream, duplex: 'half' });
    assert.equal(res.status, 429);
    assert.equal(calls.length, 1);
});

// ── JSON batching ──────────────────────────────────────────────────────

const batchAnswer = (responses) => new Response(JSON.stringify({ responses }), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('graphBatch: 25 GETs go out as 20 + 5 in POST /$batch, answers matched by id whatever their order', async () => {
    const requests = Array.from({ length: 25 }, (_, i) => ({ id: String(i), url: `/me/messages/m${i}?$select=subject` }));
    world.answers.push(
        batchAnswer(requests.slice(0, 20).reverse().map(r => ({ id: r.id, status: 200, headers: {}, body: { id: `m${r.id}` } }))),
        batchAnswer(requests.slice(20).map(r => ({ id: r.id, status: 200, headers: {}, body: { id: `m${r.id}` } }))),
    );
    const out = await graphBatch({ accessToken: 'at' }, requests);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, `${GRAPH_BASE}/$batch`);
    assert.equal(calls[0].options.method, 'POST');
    const sent = JSON.parse(calls[0].options.body).requests;
    assert.equal(sent.length, 20);
    assert.deepEqual(sent[3], { id: '3', method: 'GET', url: '/me/messages/m3?$select=subject' });
    assert.equal(JSON.parse(calls[1].options.body).requests.length, 5);
    assert.equal(out.size, 25);
    assert.deepEqual(out.get('7'), { status: 200, headers: {}, body: { id: 'm7' } });
});

test('graphBatch: only the throttled requests go again, after the longest Retry-After; a 404 is final', async () => {
    world.answers.push(
        batchAnswer([
            { id: 'a', status: 200, headers: {}, body: { id: 'A' } },
            { id: 'b', status: 429, headers: { 'Retry-After': '4' }, body: {} },
            { id: 'c', status: 404, headers: {}, body: { error: { message: 'gone' } } },
        ]),
        batchAnswer([{ id: 'b', status: 200, headers: {}, body: { id: 'B' } }]),
    );
    const out = await graphBatch({ accessToken: 'at' }, ['a', 'b', 'c'].map(id => ({ id, url: `/me/messages/${id}` })));
    assert.deepEqual(JSON.parse(calls[1].options.body).requests.map(r => r.id), ['b']);
    assert.deepEqual(waits, [4000]);
    assert.equal(out.get('b').status, 200);
    assert.equal(out.get('c').status, 404);
});

test('graphBatch: relative urls and unique ids only', async () => {
    await assert.rejects(graphBatch({ accessToken: 'at' }, [{ id: 'a', url: 'https://evil.example/x' }]), /invalid url/);
    await assert.rejects(graphBatch({ accessToken: 'at' }, [{ id: 'a', url: '/me x' }]), /invalid url/);
    await assert.rejects(graphBatch({ accessToken: 'at' }, [{ id: 'a', url: '/a' }, { id: 'a', url: '/b' }]), /its own id/);
    assert.equal(calls.length, 0);
});

