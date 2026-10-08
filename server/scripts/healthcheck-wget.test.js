'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTarget, run } = require('./healthcheck-wget');

const ok = async () => ({ ok: true });
const down = async () => ({ ok: false });
const refused = async () => { throw new Error('ECONNREFUSED'); };

test('the old compose healthcheck passes when /api/health answers', async () => {
    assert.equal(await run(['-q', '--spider', 'http://localhost:3001/api/health'], ok), 0);
});

test('an unhealthy or unreachable server fails the check', async () => {
    assert.equal(await run(['-q', '--spider', 'http://localhost:3001/api/health'], down), 8);
    assert.equal(await run(['-q', '--spider', 'http://localhost:3001/api/health'], refused), 4);
});

test('refuses to fetch anything but plain http on localhost', async () => {
    for (const url of ['http://example.com/x', 'https://localhost/api/health', 'file:///etc/passwd', 'http://10.0.0.1/', 'not a url']) {
        assert.equal(parseTarget(['-q', '--spider', url]), null, url);
        assert.equal(await run(['-q', '--spider', url], ok), 2, url);
    }
    assert.equal(parseTarget(['-q', 'http://localhost/a', 'http://localhost/b']), null);
    assert.equal(parseTarget(['-q', '--spider']), null);
});

test('accepts the loopback spellings', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) assert.ok(parseTarget(['--spider', `http://${host}:3001/api/health`]));
});
