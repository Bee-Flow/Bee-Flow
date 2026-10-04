/**
 * The server-wide org MCP policy (./policy.js): what organisation admins may
 * install, read on every install AND every tool call.
 *
 * What this file pins:
 *   - every mode of checkUrl, including the official catalogue hosts, the
 *     allowlist (exact and `*.` wildcard, and what a wildcard must NOT match),
 *     and the invariants no mode lifts (https only, no userinfo, a real URL);
 *   - normalizePolicy never widens: junk, strings, arrays and unknown modes
 *     all come back as the default ('official');
 *   - normalizeHostPattern accepts bare DNS names only;
 *   - getPolicy / setPolicy go through deps.configStore, and an unreachable
 *     store yields the default, not something wider.
 *
 * No module mocking: deps.configStore is replaced on the seam object.
 *
 * Run: cd server && node --test core/customIntegrations/mcpLibrary/policy.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');

const deps = require('./deps');
const policy = require('./policy');
const { REMOTE_CATALOG, officialHosts } = require('./catalog');

const {
    POLICY_KEY, DEFAULT_POLICY, MAX_ALLOWED_HOSTS, REMOTE_MODES,
    normalizeHostPattern, normalizePolicy, checkUrl, allowsCustomUrls, getPolicy, setPolicy,
} = policy;

const ORIGINAL_CONFIG_STORE = deps.configStore;
afterEach(() => { deps.configStore = ORIGINAL_CONFIG_STORE; });

const OFFICIAL = REMOTE_CATALOG.filter(e => !e.selfHosted);
const SELF_HOSTED = REMOTE_CATALOG.filter(e => e.selfHosted);

describe('normalizeHostPattern', () => {
    it('accepts bare DNS names and one leading wildcard label', () => {
        assert.strictEqual(normalizeHostPattern('mcp.example.com'), 'mcp.example.com');
        assert.strictEqual(normalizeHostPattern('*.example.com'), '*.example.com');
        assert.strictEqual(normalizeHostPattern('a-b.c-d.example.co'), 'a-b.c-d.example.co');
    });

    it('lower-cases, trims and drops a trailing dot', () => {
        assert.strictEqual(normalizeHostPattern('  MCP.Example.COM.  '), 'mcp.example.com');
        assert.strictEqual(normalizeHostPattern('*.Example.com.'), '*.example.com');
    });

    for (const [label, raw] of [
        ['a scheme', 'https://mcp.example.com'],
        ['a port', 'mcp.example.com:443'],
        ['a path', 'mcp.example.com/mcp'],
        ['userinfo', 'user@mcp.example.com'],
        ['an IPv4 literal', '10.0.0.1'],
        ['a public IPv4 literal', '8.8.8.8'],
        ['an IPv6 literal', '[::1]'],
        ['a bare IPv6 literal', '::1'],
        ['the empty string', ''],
        ['only whitespace', '   '],
        ['a single label', 'localhost'],
        ['a wildcard over a whole TLD', '*.com'],
        ['a double wildcard', '**.example.com'],
        ['a wildcard in the middle', 'a.*.example.com'],
        ['a bare wildcard', '*'],
        ['an underscore', 'my_host.example.com'],
        ['a leading hyphen label', '-bad.example.com'],
    ]) {
        it(`rejects ${label} (${JSON.stringify(raw)})`, () => {
            assert.strictEqual(normalizeHostPattern(raw), null);
        });
    }

    it('rejects non-strings', () => {
        for (const v of [null, undefined, 42, {}, [], ['mcp.example.com'], true]) {
            assert.strictEqual(normalizeHostPattern(v), null, JSON.stringify(v));
        }
    });
});

describe('normalizePolicy', () => {
    const DEFAULT = { remote: 'official', allowedHosts: [] };

    it('the default is official with no hosts', () => {
        assert.deepStrictEqual({ ...DEFAULT_POLICY, allowedHosts: [...DEFAULT_POLICY.allowedHosts] }, DEFAULT);
        assert.deepStrictEqual(REMOTE_MODES, ['off', 'official', 'allowlist', 'any']);
    });

    for (const [label, raw] of [
        ['undefined', undefined],
        ['null', null],
        ['a number', 7],
        ['a boolean', true],
        ['a non-JSON string', 'any'],
        ['a JSON string holding an array', '["any"]'],
        ['a JSON string holding a string', '"any"'],
        ['an array', ['any']],
        ['an empty object', {}],
        ['an unknown mode', { remote: 'everything' }],
        ['a mode in the wrong case', { remote: 'ANY' }],
        ['a mode with whitespace', { remote: ' any ' }],
        ['a non-string mode', { remote: 1 }],
    ]) {
        it(`falls back to the default (never wider) for ${label}`, () => {
            const p = normalizePolicy(raw);
            assert.strictEqual(p.remote, 'official');
            assert.deepStrictEqual(p.allowedHosts, []);
        });
    }

    it('keeps each valid mode', () => {
        for (const remote of REMOTE_MODES) {
            assert.strictEqual(normalizePolicy({ remote }).remote, remote);
        }
    });

    it('parses a stored JSON object string', () => {
        assert.deepStrictEqual(
            normalizePolicy(JSON.stringify({ remote: 'allowlist', allowedHosts: ['mcp.example.com'] })),
            { remote: 'allowlist', allowedHosts: ['mcp.example.com'] },
        );
    });

    it('normalises, dedupes and drops invalid hosts', () => {
        const p = normalizePolicy({
            remote: 'allowlist',
            allowedHosts: ['MCP.Example.com', 'mcp.example.com.', 'https://evil.example', '10.0.0.1', 42, null, '*.corp.example'],
        });
        assert.deepStrictEqual(p, { remote: 'allowlist', allowedHosts: ['mcp.example.com', '*.corp.example'] });
    });

    it('ignores allowedHosts that is not an array', () => {
        assert.deepStrictEqual(normalizePolicy({ remote: 'allowlist', allowedHosts: 'mcp.example.com' }).allowedHosts, []);
        assert.deepStrictEqual(normalizePolicy({ remote: 'allowlist', allowedHosts: { 0: 'mcp.example.com' } }).allowedHosts, []);
    });

    it(`caps allowedHosts at ${MAX_ALLOWED_HOSTS}`, () => {
        const hosts = Array.from({ length: MAX_ALLOWED_HOSTS + 25 }, (_, i) => `h${i}.example.com`);
        const p = normalizePolicy({ remote: 'allowlist', allowedHosts: hosts });
        assert.strictEqual(p.allowedHosts.length, MAX_ALLOWED_HOSTS);
        assert.strictEqual(p.allowedHosts[0], 'h0.example.com');
    });

    it('returns a fresh object, so a caller cannot change the default', () => {
        const a = normalizePolicy(null);
        a.allowedHosts.push('evil.example.com');
        a.remote = 'any';
        assert.deepStrictEqual(normalizePolicy(null), DEFAULT);
        assert.strictEqual(DEFAULT_POLICY.remote, 'official');
        assert.strictEqual(DEFAULT_POLICY.allowedHosts.length, 0);
    });
});

describe('checkUrl', () => {
    const OFF = { remote: 'off' };
    const OFFICIAL_ONLY = { remote: 'official' };
    const ALLOWLIST = { remote: 'allowlist', allowedHosts: ['mcp.example.com', '*.corp.example.org'] };
    const ANY = { remote: 'any' };

    it('the catalogue has official entries and a self-hosted one to test against', () => {
        assert.ok(OFFICIAL.length >= 5);
        assert.ok(SELF_HOSTED.length >= 1);
        // A self-hosted template host is never official.
        for (const e of SELF_HOSTED) assert.ok(!officialHosts().has(new URL(e.url).hostname));
    });

    describe("mode 'off'", () => {
        it('refuses everything, official endpoints included', () => {
            for (const e of OFFICIAL) {
                assert.deepStrictEqual(checkUrl(OFF, e.url), { allowed: false, reason: 'policy_off' }, e.id);
            }
            assert.deepStrictEqual(checkUrl(OFF, 'https://mcp.example.com'), { allowed: false, reason: 'policy_off' });
            assert.deepStrictEqual(checkUrl(OFF, 'not a url'), { allowed: false, reason: 'policy_off' });
        });
    });

    describe("mode 'official'", () => {
        it('allows every official catalogue endpoint, marked official', () => {
            for (const e of OFFICIAL) {
                assert.deepStrictEqual(checkUrl(OFFICIAL_ONLY, e.url), { allowed: true, official: true }, e.id);
            }
        });

        it('trusts the host, not the path, and ignores case and a trailing dot', () => {
            assert.deepStrictEqual(checkUrl(OFFICIAL_ONLY, 'https://mcp.linear.app/other/path'), { allowed: true, official: true });
            assert.deepStrictEqual(checkUrl(OFFICIAL_ONLY, 'https://MCP.LINEAR.APP/mcp'), { allowed: true, official: true });
            assert.deepStrictEqual(checkUrl(OFFICIAL_ONLY, 'https://mcp.linear.app./mcp'), { allowed: true, official: true });
        });

        it('refuses a self-hosted template and any other host', () => {
            for (const e of SELF_HOSTED) {
                assert.deepStrictEqual(checkUrl(OFFICIAL_ONLY, e.url), { allowed: false, reason: 'not_official' }, e.id);
            }
            assert.deepStrictEqual(checkUrl(OFFICIAL_ONLY, 'https://mcp.example.com/mcp'), { allowed: false, reason: 'not_official' });
        });

        it('does not match a look-alike of an official host', () => {
            assert.deepStrictEqual(checkUrl(OFFICIAL_ONLY, 'https://evil.mcp.linear.app/mcp'), { allowed: false, reason: 'not_official' });
            assert.deepStrictEqual(checkUrl(OFFICIAL_ONLY, 'https://mcp.linear.app.evil.com/mcp'), { allowed: false, reason: 'not_official' });
            assert.deepStrictEqual(checkUrl(OFFICIAL_ONLY, 'https://xmcp.linear.app/mcp'), { allowed: false, reason: 'not_official' });
        });
    });

    describe("mode 'allowlist'", () => {
        it('still allows the official endpoints', () => {
            for (const e of OFFICIAL) {
                assert.deepStrictEqual(checkUrl(ALLOWLIST, e.url), { allowed: true, official: true }, e.id);
            }
        });

        it('allows an exact host, not official', () => {
            assert.deepStrictEqual(checkUrl(ALLOWLIST, 'https://mcp.example.com/mcp'), { allowed: true, official: false });
        });

        it('an exact host does not cover its subdomains', () => {
            assert.deepStrictEqual(checkUrl(ALLOWLIST, 'https://a.mcp.example.com/mcp'), { allowed: false, reason: 'host_not_allowed' });
        });

        it('a *. wildcard matches subdomains at any depth', () => {
            assert.deepStrictEqual(checkUrl(ALLOWLIST, 'https://a.corp.example.org/mcp'), { allowed: true, official: false });
            assert.deepStrictEqual(checkUrl(ALLOWLIST, 'https://a.b.corp.example.org/mcp'), { allowed: true, official: false });
        });

        it('*.example.com does NOT match example.com itself or evilexample.com', () => {
            const p = { remote: 'allowlist', allowedHosts: ['*.example.com'] };
            assert.deepStrictEqual(checkUrl(p, 'https://a.example.com'), { allowed: true, official: false });
            assert.deepStrictEqual(checkUrl(p, 'https://example.com'), { allowed: false, reason: 'host_not_allowed' });
            assert.deepStrictEqual(checkUrl(p, 'https://evilexample.com'), { allowed: false, reason: 'host_not_allowed' });
            assert.deepStrictEqual(checkUrl(p, 'https://example.com.evil.net'), { allowed: false, reason: 'host_not_allowed' });
            assert.deepStrictEqual(checkUrl(p, 'https://a.example.com.evil.net'), { allowed: false, reason: 'host_not_allowed' });
        });

        it('an invalid stored host never matches', () => {
            const p = { remote: 'allowlist', allowedHosts: ['https://mcp.example.com', '*'] };
            assert.deepStrictEqual(checkUrl(p, 'https://mcp.example.com'), { allowed: false, reason: 'host_not_allowed' });
            assert.deepStrictEqual(checkUrl(p, 'https://anything.example.net'), { allowed: false, reason: 'host_not_allowed' });
        });

        it('refuses a host not on the list', () => {
            assert.deepStrictEqual(checkUrl(ALLOWLIST, 'https://other.example.net/mcp'), { allowed: false, reason: 'host_not_allowed' });
        });
    });

    describe("mode 'any'", () => {
        it('allows any https host, official or not', () => {
            assert.deepStrictEqual(checkUrl(ANY, 'https://whatever.example.net/mcp'), { allowed: true, official: false });
            assert.deepStrictEqual(checkUrl(ANY, OFFICIAL[0].url), { allowed: true, official: true });
        });
    });

    describe('invariants no mode lifts', () => {
        for (const [name, p] of [['official', OFFICIAL_ONLY], ['allowlist', ALLOWLIST], ['any', ANY]]) {
            it(`${name}: plain http is refused, even for an official host`, () => {
                assert.deepStrictEqual(checkUrl(p, 'http://mcp.linear.app/mcp'), { allowed: false, reason: 'not_https' });
                assert.deepStrictEqual(checkUrl(p, 'http://mcp.example.com/mcp'), { allowed: false, reason: 'not_https' });
            });

            it(`${name}: other schemes are refused`, () => {
                assert.deepStrictEqual(checkUrl(p, 'ftp://mcp.example.com/'), { allowed: false, reason: 'not_https' });
                assert.deepStrictEqual(checkUrl(p, 'wss://mcp.example.com/'), { allowed: false, reason: 'not_https' });
            });

            it(`${name}: credentials in the URL are refused, even for an official host`, () => {
                assert.deepStrictEqual(checkUrl(p, 'https://user:pw@mcp.linear.app/mcp'), { allowed: false, reason: 'invalid_url' });
                assert.deepStrictEqual(checkUrl(p, 'https://user@mcp.example.com/mcp'), { allowed: false, reason: 'invalid_url' });
                assert.deepStrictEqual(checkUrl(p, 'https://:pw@mcp.example.com/mcp'), { allowed: false, reason: 'invalid_url' });
            });

            it(`${name}: something that is not a URL is refused`, () => {
                for (const raw of ['not a url', '', null, undefined, 'mcp.example.com', '//mcp.example.com/mcp']) {
                    assert.deepStrictEqual(checkUrl(p, raw), { allowed: false, reason: 'invalid_url' }, String(raw));
                }
            });
        }
    });

    it('a junk policy is read as the default (official), never as wider', () => {
        for (const junk of [null, 'any', ['any'], { remote: 'ANY' }]) {
            assert.deepStrictEqual(checkUrl(junk, 'https://whatever.example.net/mcp'), { allowed: false, reason: 'not_official' });
            assert.deepStrictEqual(checkUrl(junk, OFFICIAL[0].url), { allowed: true, official: true });
        }
    });
});

describe('allowsCustomUrls', () => {
    it('is true only for allowlist and any', () => {
        assert.strictEqual(allowsCustomUrls({ remote: 'off' }), false);
        assert.strictEqual(allowsCustomUrls({ remote: 'official' }), false);
        assert.strictEqual(allowsCustomUrls({ remote: 'allowlist' }), true);
        assert.strictEqual(allowsCustomUrls({ remote: 'any' }), true);
        assert.strictEqual(allowsCustomUrls(null), false);
        assert.strictEqual(allowsCustomUrls('any'), false);
    });
});

describe('getPolicy / setPolicy (through deps.configStore)', () => {
    it('reads the stored value under its config key, normalised', async () => {
        const asked = [];
        deps.configStore = () => ({
            getConfig: async (key) => { asked.push(key); return { remote: 'allowlist', allowedHosts: ['MCP.Example.com', 'bad host'] }; },
        });
        assert.deepStrictEqual(await getPolicy(), { remote: 'allowlist', allowedHosts: ['mcp.example.com'] });
        assert.deepStrictEqual(asked, [POLICY_KEY]);
        assert.strictEqual(POLICY_KEY, 'mcp_org_policy');
    });

    it('nothing stored is the default', async () => {
        deps.configStore = () => ({ getConfig: async () => null });
        assert.deepStrictEqual(await getPolicy(), { remote: 'official', allowedHosts: [] });
    });

    it('a store that throws yields the default, not something wider', async () => {
        deps.configStore = () => ({ getConfig: async () => { throw new Error('db down'); } });
        assert.deepStrictEqual(await getPolicy(), { remote: 'official', allowedHosts: [] });
    });

    it('a store that cannot even be loaded yields the default', async () => {
        deps.configStore = () => { throw new Error('cannot load'); };
        assert.deepStrictEqual(await getPolicy(), { remote: 'official', allowedHosts: [] });
    });

    it('setPolicy stores and returns the normalised value', async () => {
        const writes = [];
        deps.configStore = () => ({ setConfig: async (key, value) => { writes.push([key, value]); } });
        const out = await setPolicy({ remote: 'allowlist', allowedHosts: [' A.Example.com ', 'a.example.com', 'http://x', '*.b.example.com'] });
        const expected = { remote: 'allowlist', allowedHosts: ['a.example.com', '*.b.example.com'] };
        assert.deepStrictEqual(out, expected);
        assert.deepStrictEqual(writes, [[POLICY_KEY, expected]]);
    });

    it('setPolicy with an unknown mode stores the default, never something wider', async () => {
        const writes = [];
        deps.configStore = () => ({ setConfig: async (key, value) => { writes.push([key, value]); } });
        const out = await setPolicy({ remote: 'everything', allowedHosts: ['a.example.com'] });
        assert.strictEqual(out.remote, 'official');
        assert.strictEqual(writes[0][1].remote, 'official');
    });

    it('setPolicy lets a store failure through (the caller must not report a save)', async () => {
        deps.configStore = () => ({ setConfig: async () => { throw new Error('db down'); } });
        await assert.rejects(setPolicy({ remote: 'any' }), /db down/);
    });
});
