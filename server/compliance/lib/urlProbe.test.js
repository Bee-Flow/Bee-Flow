/**
 * URL probe — SSRF refusal, bounded body, structured errors, security.txt parse.
 * Network is never touched: a fetchImpl double answers with real Response objects.
 *
 * Run: cd server && node --test --test-force-exit compliance/lib/urlProbe.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { probe, parseSecurityTxt } = require('./urlProbe');

const respond = (body, init = {}) => async () => new Response(body, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, ...init });

test('private and loopback hosts are refused before any fetch', async () => {
    let called = false;
    const fetchImpl = async () => { called = true; return new Response('x'); };
    for (const url of ['http://127.0.0.1/.well-known/security.txt', 'http://localhost:3101/x', 'http://10.0.0.5/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data']) {
        const r = await probe(url, { fetchImpl });
        assert.equal(r.ok, false, url);
        assert.equal(r.error, 'private_host', url);
    }
    assert.equal(called, false, 'fetch must not be invoked for a private host');
});

test('malformed URLs and non-http schemes are structured errors, not throws', async () => {
    assert.equal((await probe('not a url')).error, 'invalid_url');
    assert.equal((await probe('ftp://example.com/x')).error, 'unsupported_scheme');
    assert.equal((await probe('file:///etc/passwd')).error, 'unsupported_scheme');
});

test('a 2xx answer is ok with status, content type and body snippet', async () => {
    const r = await probe('https://example.com/.well-known/security.txt', {
        fetchImpl: respond('Contact: mailto:security@example.com\nExpires: 2030-01-01T00:00:00Z\n'),
    });
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.match(r.content_type, /^text\/plain/);
    assert.match(r.snippet, /^Contact:/);
    assert.equal(r.truncated, false);
    assert.equal(r.error, null);
});

test('non-2xx is reported, never thrown', async () => {
    const r = await probe('https://example.com/missing', { fetchImpl: respond('nope', { status: 404 }) });
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
    assert.equal(r.error, null);
});

test('the body is capped at maxBytes and flagged truncated', async () => {
    const big = 'A'.repeat(10_000);
    const r = await probe('https://example.com/big', { fetchImpl: respond(big), maxBytes: 1_000 });
    assert.equal(r.ok, true);
    assert.equal(r.snippet.length, 1_000);
    assert.equal(r.truncated, true);
    assert.equal(r.bytes, 1_000);
});

test('a hanging server becomes a timeout error', async () => {
    const fetchImpl = (_url, { signal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
            const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
        });
    });
    const r = await probe('https://example.com/slow', { fetchImpl, timeoutMs: 20 });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'timeout');
});

test('network failures surface as a bounded message', async () => {
    const fetchImpl = async () => { throw Object.assign(new Error('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND example.invalid') }); };
    const r = await probe('https://example.invalid/', { fetchImpl });
    assert.equal(r.ok, false);
    assert.match(r.error, /ENOTFOUND/);
    assert.ok(r.error.length <= 200);
});

test('parseSecurityTxt: fields, preference order, expiry, comments and PGP wrapper', () => {
    const body = [
        '-----BEGIN PGP SIGNED MESSAGE-----',
        'Hash: SHA256',
        '',
        '# Found a problem? Tell us first.',
        'Contact: mailto:psirt@example.com',
        'contact: https://example.com/report',
        'Expires: 2031-06-01T00:00:00Z',
        'Preferred-Languages: nl, en',
        'Policy: https://example.com/security-policy',
        'Canonical: https://example.com/.well-known/security.txt',
        'Hiring: https://example.com/jobs',
        '-----BEGIN PGP SIGNATURE-----',
        'iQEzBAEBCAAdFiEE...',
        '-----END PGP SIGNATURE-----',
    ].join('\n');
    const p = parseSecurityTxt(body);
    assert.deepEqual(p.contact, ['mailto:psirt@example.com', 'https://example.com/report']);
    assert.equal(p.expires, '2031-06-01T00:00:00Z');
    assert.equal(p.expires_valid, true);
    assert.equal(p.expired, false);
    assert.equal(p.policy, 'https://example.com/security-policy');
    assert.equal(p.canonical, 'https://example.com/.well-known/security.txt');
    assert.deepEqual(p.preferred_languages, ['nl', 'en']);
    assert.equal(p.field_count, 7);
});

test('parseSecurityTxt: expired, invalid and missing Expires; garbage input', () => {
    assert.equal(parseSecurityTxt('Contact: mailto:a@b.c\nExpires: 2020-01-01T00:00:00Z').expired, true);
    const invalid = parseSecurityTxt('Contact: mailto:a@b.c\nExpires: soon');
    assert.equal(invalid.expires_valid, false);
    assert.equal(invalid.expired, null);
    const none = parseSecurityTxt('Contact: mailto:a@b.c');
    assert.equal(none.expires, null);
    assert.equal(none.policy, null);
    const html = parseSecurityTxt('<!doctype html><html><head><title>App</title></head><body>SPA</body></html>');
    assert.deepEqual(html.contact, []);
    assert.equal(html.field_count, 0);
    assert.deepEqual(parseSecurityTxt(null).contact, []);
});
