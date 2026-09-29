/**
 * Browse driver — the domain allowlist (App Studio's per-app confinement).
 * Run: cd server && node --test services/browserAgentDriver.allowlist.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { normalizeAllowedHosts, hostAllowed, _internals } = require('./browserAgentDriver');

test('normalizeAllowedHosts: lowercases, strips scheme/path/port, drops junk', () => {
    assert.deepStrictEqual(
        normalizeAllowedHosts(['Example.COM', 'https://Docs.example.org/path', 'api.test:8443', '', null]),
        ['example.com', 'docs.example.org', 'api.test'],
    );
    assert.strictEqual(normalizeAllowedHosts([]), null, 'empty = no allowlist, not "allow nothing"');
    assert.strictEqual(normalizeAllowedHosts(null), null);
});

test('hostAllowed: exact + dot-suffix, never substring', () => {
    const hosts = ['example.com'];
    assert.ok(hostAllowed('example.com', hosts));
    assert.ok(hostAllowed('WWW.Example.com', hosts));
    assert.ok(hostAllowed('deep.sub.example.com', hosts));
    assert.ok(!hostAllowed('notexample.com', hosts), 'substring match would be an allowlist bypass');
    assert.ok(!hostAllowed('example.com.evil.io', hosts));
    assert.ok(!hostAllowed('example.org', hosts));
});

test('pw_navigate pre-check: a named refusal, listing the permitted domains', async () => {
    // No page needed — the pre-check fires before any Playwright call.
    const res = await _internals._executeTool(null, 'pw_navigate', { url: 'https://evil.io/x' }, {
        extracted: [], allowedHosts: ['example.com', 'example.org'],
    });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /domain_not_allowed: evil\.io/);
    assert.match(res.error, /example\.com, example\.org/);
});
