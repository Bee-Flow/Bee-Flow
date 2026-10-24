// @typecheck
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { probeUrls, requestable, MAX_HOPS } = require('./linkProbe');
const { isPrivateAddressError } = require('../../utils/ssrfGuard');

const reply = (status) => ({ status, body: { cancel: async () => undefined } });

test('only plain http(s) on normal ports without credentials is requestable', () => {
    assert.ok(requestable('https://example.org/x'));
    for (const bad of ['ftp://example.org', 'file:///etc/passwd', 'https://user:pw@example.org', 'https://example.org:22/', 'javascript:1']) {
        assert.equal(requestable(bad), null, bad);
    }
});

test('HEAD first, a ranged GET when HEAD fails; no cookies or credentials', async () => {
    const calls = [];
    const fetchFn = async (url, init) => { calls.push(init); return reply(init.method === 'HEAD' ? 405 : 200); };
    const { results } = await probeUrls(['https://example.org/a'], { fetchFn });
    assert.deepEqual(results.get('https://example.org/a'), { status: 200 });
    assert.deepEqual(calls.map((c) => c.method), ['HEAD', 'GET']);
    assert.equal(calls[1].headers.range, 'bytes=0-0');
    assert.equal(calls[0].credentials, 'omit');
    assert.ok(!('cookie' in calls[0].headers) && !('authorization' in calls[0].headers));
});

test('caps the number of URLs, asks duplicates once, limits concurrency', async () => {
    let live = 0;
    let peak = 0;
    const fetchFn = async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--; return reply(200); };
    const urls = Array.from({ length: 12 }, (_, i) => `https://example.org/${i}`).concat(['https://example.org/0']);
    const { results, skipped } = await probeUrls(urls, { fetchFn, max: 10, concurrency: 3 });
    assert.equal(results.size, 10);
    assert.equal(skipped, 2);
    assert.ok(peak <= 3);
});

test('a private target is refused by the real guard, not requested', async () => {
    const { results } = await probeUrls(['http://127.0.0.1/', 'http://169.254.169.254/latest', 'http://localhost:8080/'], { timeoutMs: 500 });
    for (const r of results.values()) assert.deepEqual(r, { error: 'refused' });
    assert.equal(typeof isPrivateAddressError, 'function');
});

test('a network failure is unreachable', async () => {
    const { results } = await probeUrls(['https://example.org/'], { fetchFn: async () => { throw new Error('boom'); } });
    assert.deepEqual(results.get('https://example.org/'), { error: 'unreachable' });
});

const redirect = (to) => ({ status: 302, headers: new Map([['location', to]]), body: { cancel: async () => undefined } });
const final = (status) => ({ status, headers: new Map(), body: { cancel: async () => undefined } });

test('redirects are followed by hand and every hop is requested through the guard', async () => {
    const seen = [];
    const fetchFn = async (url, init) => {
        seen.push([url, init.redirect]);
        return url.endsWith('/a') ? redirect('/b') : final(200);
    };
    const { results } = await probeUrls(['https://example.org/a'], { fetchFn });
    assert.deepEqual(results.get('https://example.org/a'), { status: 200 });
    assert.deepEqual(seen.map((s) => s[0]), ['https://example.org/a', 'https://example.org/b']);
    assert.ok(seen.every((s) => s[1] === 'manual'));
});

test('a redirect to another scheme, an odd port or credentials is not followed', async () => {
    for (const to of ['ftp://example.org/x', 'https://other.example:2222/', 'https://u:p@other.example/']) {
        const calls = [];
        const fetchFn = async (url) => { calls.push(url); return redirect(to); };
        const { results } = await probeUrls(['https://example.org/a'], { fetchFn });
        assert.deepEqual(results.get('https://example.org/a'), { error: 'unreachable' }, to);
        assert.ok(calls.every((c) => c === 'https://example.org/a'), to);
    }
});

test('a redirect loop stops after the hop limit', async () => {
    let n = 0;
    const fetchFn = async () => { n++; return redirect('/loop'); };
    await probeUrls(['https://example.org/loop'], { fetchFn });
    assert.ok(n <= 2 * (MAX_HOPS + 1));
});
