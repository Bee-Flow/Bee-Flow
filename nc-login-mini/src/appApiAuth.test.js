const test = require('node:test');
const assert = require('node:assert');

const { decodeAuth, verifyAppApiAuth, escapeHtml, frameAncestors } = require('./appApiAuth');

const header = (s) => Buffer.from(s, 'utf8').toString('base64');

test('the AppAPI header splits at the first colon: the secret may contain one', () => {
    assert.deepEqual(decodeAuth(header('alice:s3:cr3t')), { userId: 'alice', secret: 's3:cr3t' });
    assert.equal(decodeAuth(header('no-colon')), null);
    assert.equal(decodeAuth(undefined), null);
    assert.equal(decodeAuth(['a', 'b']), null);
});

test('the right secret with a user authenticates that user', () => {
    assert.deepEqual(verifyAppApiAuth(header('alice:secret'), 'secret'), { ok: true, userId: 'alice' });
});

test('a wrong or missing secret is refused, and so is a request without a user', () => {
    assert.deepEqual(verifyAppApiAuth(header('alice:wrong'), 'secret'), { ok: false, reason: 'auth' });
    assert.deepEqual(verifyAppApiAuth(undefined, 'secret'), { ok: false, reason: 'auth' });
    assert.deepEqual(verifyAppApiAuth(header(':secret'), 'secret'), { ok: false, reason: 'no_user' });
});

test('with no APP_SECRET configured nobody gets in, not even with an empty secret', () => {
    assert.deepEqual(verifyAppApiAuth(header('alice:'), ''), { ok: false, reason: 'auth' });
    assert.deepEqual(verifyAppApiAuth(header('alice:'), undefined), { ok: false, reason: 'auth' });
});

test('names and emails are escaped before they reach the page', () => {
    assert.equal(escapeHtml(`<img src=x onerror="alert('1')">&`), '&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;');
    assert.equal(escapeHtml(42), '42');
});

test('frame-ancestors: self, the Nextcloud origin and the caller\'s origin, each once', () => {
    assert.deepEqual(
        frameAncestors('https://cloud.example.test/nextcloud', {
            origin: 'https://cloud.example.test',
            referer: 'https://other.example.test/apps/x?y=1',
        }),
        ["'self'", 'https://cloud.example.test', 'https://other.example.test'],
    );
    assert.deepEqual(frameAncestors('', { referer: 'not a url' }), ["'self'"]);
});
