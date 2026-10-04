'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { fetchFollowingSameHost } = require('./sameHostFetch');

const res = (status, location) => ({ status, headers: { get: (k) => (k.toLowerCase() === 'location' ? location || null : null) } });

test('a plain response is returned as is, with redirects set to manual', async () => {
    const seen = [];
    const out = await fetchFollowingSameHost(async (url, init) => { seen.push([url, init.redirect]); return res(200); }, 'https://api.example.com/a', { method: 'GET' });
    assert.strictEqual(out.status, 200);
    assert.deepStrictEqual(seen, [['https://api.example.com/a', 'manual']]);
});

test('a redirect on the same host is followed', async () => {
    const urls = [];
    const out = await fetchFollowingSameHost(async (url) => { urls.push(url); return urls.length === 1 ? res(302, '/b') : res(200); }, 'https://api.example.com/a', { method: 'GET' });
    assert.strictEqual(out.status, 200);
    assert.deepStrictEqual(urls, ['https://api.example.com/a', 'https://api.example.com/b']);
});

test('a redirect to another host is refused: the credential never goes there', async () => {
    await assert.rejects(
        fetchFollowingSameHost(async () => res(302, 'https://evil.example.net/x'), 'https://api.example.com/a', { method: 'GET' }),
        /another host/,
    );
});

test('a 302 turns a POST into a GET without a body, a 307 keeps both', async () => {
    const seen = [];
    let n = 0;
    await fetchFollowingSameHost(async (url, init) => { seen.push([init.method, init.body]); return ++n === 1 ? res(302, '/b') : res(200); }, 'https://h.test/a', { method: 'POST', body: 'x' });
    assert.deepStrictEqual(seen, [['POST', 'x'], ['GET', undefined]]);
    seen.length = 0; n = 0;
    await fetchFollowingSameHost(async (url, init) => { seen.push([init.method, init.body]); return ++n === 1 ? res(307, '/b') : res(200); }, 'https://h.test/a', { method: 'POST', body: 'x' });
    assert.deepStrictEqual(seen, [['POST', 'x'], ['POST', 'x']]);
});

test('a redirect loop ends in an error', async () => {
    await assert.rejects(fetchFollowingSameHost(async () => res(302, '/a'), 'https://h.test/a', { method: 'GET' }), /too many redirects/);
});
