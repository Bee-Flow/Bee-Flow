const test = require('node:test');
const assert = require('node:assert');
const { executeReadUrlTool, READ_URL_TOOLS, MAX_TEXT_CHARS, findPassages } = require('./readUrlTools');
const { PRIVATE_ADDRESS_ERROR_CODE } = require('../utils/ssrfGuard');

function page(body, { title = 'Standaard 4410', type = 'text/html; charset=utf-8', status = 200, url = 'https://example.org/p' } = {}) {
    const html = `<html><head><title>${title}</title><script>var x=1;</script></head><body><nav>menu</nav>${body}</body></html>`;
    const bytes = new TextEncoder().encode(type.includes('html') || type.startsWith('text/') ? html : 'binary');
    return async () => ({
        ok: status >= 200 && status < 300,
        status,
        url,
        headers: { get: (h) => (h.toLowerCase() === 'content-type' ? type : null) },
        body: { getReader: () => { let sent = false; return { read: async () => (sent ? { done: true } : (sent = true, { done: false, value: bytes })), cancel: async () => {} }; } },
    });
}
const run = async (args, fetchImpl) => JSON.parse(await executeReadUrlTool('read_url', args, { fetchImpl }));
const long = (n) => Array.from({ length: n }, (_, i) => `<p>Paragraph ${i} lorem ipsum dolor sit amet.</p>`).join('');

test('definition: read_url requires url, find optional', () => {
    const fn = READ_URL_TOOLS[0].function;
    assert.strictEqual(fn.name, 'read_url');
    assert.deepStrictEqual(fn.parameters.required, ['url']);
    assert.ok(fn.parameters.properties.find);
});

test('refuses private and metadata targets through the real SSRF guard', async () => {
    for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://localhost:3101/api', 'http://[::1]/']) {
        const out = await run({ url });
        assert.match(out.error, /private or internal/i, url);
    }
});

test('a private-address error from the fetch layer (redirect, DNS) is refused too', async () => {
    const e = Object.assign(new Error('x'), { code: PRIVATE_ADDRESS_ERROR_CODE });
    const out = await run({ url: 'https://example.org/' }, async () => { throw e; });
    assert.match(out.error, /private or internal/i);
});

test('only http(s) and valid urls', async () => {
    assert.match((await run({ url: 'file:///etc/passwd' })).error, /http and https/);
    assert.match((await run({ url: 'ftp://example.org/' })).error, /http and https/);
    assert.match((await run({ url: 'not a url' })).error, /valid/);
    assert.match((await run({})).error, /required/);
});

test('returns title and cleaned text, drops script and nav', async () => {
    const out = await run({ url: 'https://example.org/p' }, page('<h1>Hello</h1><p>World &amp; more</p>'));
    assert.strictEqual(out.title, 'Standaard 4410');
    assert.strictEqual(out.url, 'https://example.org/p');
    assert.strictEqual(out.truncated, false);
    assert.match(out.text, /Hello\s+World & more/);
    assert.doesNotMatch(out.text, /var x|menu/);
    assert.strictEqual(out.totalChars, out.text.length);
});

test('long page is truncated at the cap and flagged', async () => {
    const out = await run({ url: 'https://example.org/p' }, page(long(4000)));
    assert.strictEqual(out.truncated, true);
    assert.strictEqual(out.text.length, MAX_TEXT_CHARS);
    assert.ok(out.totalChars > MAX_TEXT_CHARS);
    assert.match(out.note, /find/);
});

test('find returns the deep passage (38A) instead of the head', async () => {
    const body = long(3000) + '<h3>38A</h3><p>Het dossier wordt binnen twee maanden afgesloten (A61A).</p>' + long(500);
    const out = await run({ url: 'https://example.org/p', find: '38a' }, page(body));
    assert.strictEqual(out.totalMatches, 1);
    assert.strictEqual(out.text, undefined);
    assert.strictEqual(out.matches.length, 1);
    assert.match(out.matches[0].text, /38A/);
    assert.match(out.matches[0].text, /binnen twee maanden/);
    assert.ok(out.matches[0].text.length < 2300);
});

test('find merges overlapping hits and caps passages at 10', () => {
    const near = findPassages('a'.repeat(100) + 'X' + 'a'.repeat(100) + 'X' + 'a'.repeat(100), 'x');
    assert.strictEqual(near.totalMatches, 2);
    assert.strictEqual(near.passages.length, 1);
    assert.strictEqual(near.passages[0].hits, 2);
    const far = findPassages(('X' + 'a'.repeat(5000)).repeat(15), 'x');
    assert.strictEqual(far.totalMatches, 15);
    assert.strictEqual(far.passages.length, 10);
    assert.strictEqual(far.passagesOmitted, 5);
});

test('find without hits says so and returns the head of the text', async () => {
    const out = await run({ url: 'https://example.org/p', find: 'nonexistent-xyz' }, page('<p>Some real content here.</p>'));
    assert.strictEqual(out.totalMatches, 0);
    assert.match(out.note, /No hits/);
    assert.match(out.text, /Some real content/);
    assert.strictEqual(out.matches, undefined);
});

test('non-HTML content (PDF) gets a clear message pointing to browse_web', async () => {
    const out = await run({ url: 'https://example.org/a.pdf' }, page('', { type: 'application/pdf' }));
    assert.match(out.error, /application\/pdf/);
    assert.match(out.error, /browse_web/);
});

test('HTTP errors and network failures come back as errors, not throws', async () => {
    assert.match((await run({ url: 'https://example.org/x' }, page('', { status: 404 }))).error, /HTTP 404/);
    assert.match((await run({ url: 'https://example.org/x' }, async () => { throw new Error('boom'); })).error, /boom/);
});
