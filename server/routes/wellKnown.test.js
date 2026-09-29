/**
 * Route tests for /.well-known/security.txt (RFC 9116).
 *
 * The pentest finding was that this path returned the SPA shell — a 200 with
 * no contact in it. These tests pin the three things that make the file
 * useful rather than decorative:
 *   • it is text/plain and carries the REQUIRED Contact + Expires fields;
 *   • Expires is always in the future (it is computed per request, so it
 *     cannot silently lapse on an install that has not redeployed);
 *   • the contact address follows the DEPLOYMENT's own domain, so a
 *     self-hosted install never advertises Bee Flow's inbox as its own — and
 *     Canonical is never taken from the attacker-controlled Host header.
 *
 * ../auth/permissions is mocked so requiring the router does not drag in the
 * store/db layer (the microsoft-identity route lazily calls loadConfig).
 *
 * Run: node --test routes/wellKnown.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const Module = require('module');

// Compliance → Settings of the org that speaks for this host (CRA disclosure
// policy lines). `settingsState.settings` is what getSettings answers;
// `settingsState.error` makes it throw; `settingsState.calls` records org ids.
const settingsState = { settings: null, error: null, calls: [] };
const MOCKS = {
    '../auth/permissions': { loadConfig: async () => ({}) },
    '../stores/complianceStore': {
        async getSettings(orgId) {
            settingsState.calls.push(orgId);
            if (settingsState.error) throw settingsState.error;
            return settingsState.settings;
        },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) return MOCK_IDS[request];
    return originalResolve.call(this, request, parent, ...rest);
};

const express = require('express');
const router = require('./wellKnown');

// ── HTTP harness ────────────────────────────────────────────────────

let server;
let baseUrl;

test.before(async () => {
    const app = express();
    app.use('/.well-known', router);
    await new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    Module._resolveFilename = originalResolve;
});

function get(path, headers = {}) {
    return new Promise((resolve, reject) => {
        http.get(`${baseUrl}${path}`, { headers }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        }).on('error', reject);
    });
}

// Fields are `Name: value` lines; comments start with '#'.
function field(body, name) {
    const line = body.split('\n').find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
    return line ? line.slice(line.indexOf(':') + 1).trim() : null;
}

// ── Env isolation ───────────────────────────────────────────────────

const ENV_KEYS = ['SECURITY_TXT_CONTACT', 'CLIENT_PUBLIC_HOST', 'CLIENT_PROTOCOL', 'SERVER_PUBLIC_HOST', 'SECURITY_TXT_POLICY_ORG_ID'];
let savedEnv;

test.beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) {
        savedEnv[k] = process.env[k];
        delete process.env[k];
    }
    settingsState.settings = null;
    settingsState.error = null;
    settingsState.calls = [];
    router._test.resetPolicyMemo();
});

test.afterEach(() => {
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
    }
});

// ── Tests ───────────────────────────────────────────────────────────

test('serves a real text/plain security.txt with the RFC-required fields', async () => {
    process.env.CLIENT_PUBLIC_HOST = 'app.example.com';
    process.env.CLIENT_PROTOCOL = 'https';

    const res = await get('/.well-known/security.txt');

    assert.equal(res.status, 200);
    // Not the SPA shell: the whole point of the finding.
    assert.match(res.headers['content-type'], /^text\/plain; ?charset=utf-8$/i);
    assert.ok(!/<html/i.test(res.body), 'must not be HTML');

    assert.equal(field(res.body, 'Contact'), 'mailto:security@app.example.com');
    assert.equal(field(res.body, 'Preferred-Languages'), 'nl, en');
    assert.equal(field(res.body, 'Canonical'), 'https://app.example.com/.well-known/security.txt');
});

test('Expires is a future ISO 8601 instant, computed per request', async () => {
    process.env.CLIENT_PUBLIC_HOST = 'app.example.com';
    const res = await get('/.well-known/security.txt');
    const expires = field(res.body, 'Expires');

    assert.ok(expires, 'Expires is REQUIRED by RFC 9116');
    assert.match(expires, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    const when = new Date(expires).getTime();
    assert.ok(Number.isFinite(when), 'Expires must parse');
    const monthsOut = (when - Date.now()) / (1000 * 60 * 60 * 24 * 30);
    // ~12 months out: proves it is derived from "now" and not a baked date
    // that will quietly go stale.
    assert.ok(monthsOut > 11 && monthsOut < 13, `expected ~12 months out, got ${monthsOut}`);
});

test('a self-hosted domain gets its own contact, not Bee Flow’s', async () => {
    process.env.CLIENT_PUBLIC_HOST = 'beeflow.acme-industries.de:8443';

    const res = await get('/.well-known/security.txt');

    assert.equal(field(res.body, 'Contact'), 'mailto:security@beeflow.acme-industries.de');
    assert.ok(!res.body.includes('beeflow.nl'), 'must not advertise our inbox for someone else’s install');
});

test('SECURITY_TXT_CONTACT wins and accepts a bare address or a full URI', async () => {
    process.env.CLIENT_PUBLIC_HOST = 'app.example.com';

    process.env.SECURITY_TXT_CONTACT = 'ciso@example.org';
    let res = await get('/.well-known/security.txt');
    assert.equal(field(res.body, 'Contact'), 'mailto:ciso@example.org');

    process.env.SECURITY_TXT_CONTACT = 'https://example.org/report';
    res = await get('/.well-known/security.txt');
    assert.equal(field(res.body, 'Contact'), 'https://example.org/report');
});

test('hosts with no reachable mailbox yield nothing rather than a wrong address', async () => {
    const { mailDomainFromHost } = router._test;

    // A local stack, a container name, or a bare IP: security@<that> is not a
    // mailbox, so we must not publish it as the reporting channel.
    for (const host of ['localhost:5176', 'localhost', 'server', '192.168.1.10:3001', '[::1]:3001', '']) {
        assert.equal(mailDomainFromHost(host), null, `${host} must not yield a mail domain`);
    }
    assert.equal(mailDomainFromHost('https://stats.example.com/'), 'stats.example.com');
    assert.equal(mailDomainFromHost('www.Example.COM'), 'example.com');
});

// The shipped default is CLIENT_PUBLIC_HOST=localhost:5176. With a hard-coded
// beeflow.nl fallback, every local and every not-yet-configured self-hosted
// install published OUR address as its security contact — reports about that
// operator's data arriving at a company that cannot act on them, and the
// operator never learning a report was made. No file is the honest answer.
test('an install with no routable public host serves no security.txt at all', async () => {
    const res = await get('/.well-known/security.txt');
    assert.equal(res.status, 404);
    assert.ok(!/beeflow\.nl/i.test(res.body), 'must not advertise the vendor as the operator’s contact');
});

test('a local host is not published as a Canonical either — the two agree', async () => {
    // Previously mailDomainFromHost rejected `localhost:5176` while
    // canonicalUrl() accepted it, so the file contradicted itself.
    process.env.CLIENT_PUBLIC_HOST = 'localhost:5176';
    process.env.CLIENT_PROTOCOL = 'http';
    assert.equal(router._test.canonicalUrl(), null);
    assert.equal(router._test.securityContact(), null);

    // An explicit contact is enough to serve the file; Canonical stays absent
    // because the host still is not one a researcher could reach.
    process.env.SECURITY_TXT_CONTACT = 'security@example.org';
    const res = await get('/.well-known/security.txt');
    assert.equal(res.status, 200);
    assert.equal(field(res.body, 'Contact'), 'mailto:security@example.org');
    assert.equal(field(res.body, 'Canonical'), null);
});

test('Canonical ignores the Host header and is omitted when unconfigured', async () => {
    // Host-header injection must not make us publish an attacker's URL as the
    // authoritative location of our security policy.
    const spoofed = await get('/.well-known/security.txt', { Host: 'evil.example.net' });
    assert.equal(field(spoofed.body, 'Canonical'), null);
    assert.ok(!spoofed.body.includes('evil.example.net'));

    process.env.CLIENT_PUBLIC_HOST = 'app.example.com';
    const configured = await get('/.well-known/security.txt', { Host: 'evil.example.net' });
    assert.equal(field(configured.body, 'Canonical'), 'https://app.example.com/.well-known/security.txt');
});

// ── CRA disclosure policy lines (Annex I Part II(5)) ─────────────────────────

const POLICY_SETTINGS = {
    security_txt_policy_enabled: true,
    vuln_disclosure_url: 'https://app.example.com/security/disclosure',
    psirt_contact_email: 'psirt@app.example.com',
};

function fields(body, name) {
    return body.split('\n')
        .filter((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))
        .map((l) => l.slice(l.indexOf(':') + 1).trim());
}

test('without the org flag the file is unchanged: no Policy line, derived contact only', async () => {
    process.env.CLIENT_PUBLIC_HOST = 'app.example.com';
    settingsState.settings = { ...POLICY_SETTINGS, security_txt_policy_enabled: false };
    const res = await get('/.well-known/security.txt');
    assert.equal(res.status, 200);
    assert.equal(field(res.body, 'Policy'), null);
    assert.deepEqual(fields(res.body, 'Contact'), ['mailto:security@app.example.com']);
    assert.ok(!res.body.includes('psirt@'), 'the PSIRT address stays private while the flag is off');
});

test('with the flag on, Policy and the PSIRT contact are published — PSIRT first, derived kept, no duplicates', async () => {
    process.env.CLIENT_PUBLIC_HOST = 'app.example.com';
    settingsState.settings = POLICY_SETTINGS;
    const res = await get('/.well-known/security.txt');
    assert.equal(res.status, 200);
    assert.equal(field(res.body, 'Policy'), 'https://app.example.com/security/disclosure');
    assert.deepEqual(fields(res.body, 'Contact'), ['mailto:psirt@app.example.com', 'mailto:security@app.example.com']);
    // Field order per RFC 9116 conventions: Contact lines before Expires.
    const idx = (name) => res.body.split('\n').findIndex((l) => l.startsWith(`${name}:`));
    assert.ok(idx('Contact') < idx('Expires'));
    assert.ok(idx('Policy') > idx('Expires'));
    assert.deepEqual(settingsState.calls, ['default'], 'reads the default org unless overridden');
});

test('a PSIRT contact equal to the derived one is not listed twice; a mailto: prefix is tolerated', async () => {
    process.env.CLIENT_PUBLIC_HOST = 'app.example.com';
    settingsState.settings = { ...POLICY_SETTINGS, psirt_contact_email: 'MAILTO:Security@App.Example.com' };
    const res = await get('/.well-known/security.txt');
    assert.equal(fields(res.body, 'Contact').length, 1);
});

test('an invalid policy URL or PSIRT address is dropped rather than published', async () => {
    process.env.CLIENT_PUBLIC_HOST = 'app.example.com';
    settingsState.settings = { ...POLICY_SETTINGS, vuln_disclosure_url: 'ftp://x', psirt_contact_email: 'not-an-address' };
    const res = await get('/.well-known/security.txt');
    assert.equal(field(res.body, 'Policy'), null);
    assert.deepEqual(fields(res.body, 'Contact'), ['mailto:security@app.example.com']);
});

test('a published PSIRT contact makes the file servable on a host with no derivable mailbox', async () => {
    // No CLIENT_PUBLIC_HOST → previously a 404; the org's own inbox is a real contact.
    settingsState.settings = POLICY_SETTINGS;
    const res = await get('/.well-known/security.txt');
    assert.equal(res.status, 200);
    assert.deepEqual(fields(res.body, 'Contact'), ['mailto:psirt@app.example.com']);
    assert.equal(field(res.body, 'Policy'), 'https://app.example.com/security/disclosure');
    assert.equal(field(res.body, 'Canonical'), null);
});

test('a settings read failure degrades to the plain file, never a 500', async () => {
    process.env.CLIENT_PUBLIC_HOST = 'app.example.com';
    settingsState.error = new Error('db down');
    const res = await get('/.well-known/security.txt');
    assert.equal(res.status, 200);
    assert.equal(field(res.body, 'Policy'), null);
    assert.equal(field(res.body, 'Contact'), 'mailto:security@app.example.com');
});

test('the settings read is memoised per process so scanners cannot hammer the database', async () => {
    process.env.CLIENT_PUBLIC_HOST = 'app.example.com';
    settingsState.settings = POLICY_SETTINGS;
    await get('/.well-known/security.txt');
    await get('/.well-known/security.txt');
    await get('/.well-known/security.txt');
    assert.equal(settingsState.calls.length, 1);
});

test('SECURITY_TXT_POLICY_ORG_ID picks which organisation speaks for the host', async () => {
    process.env.CLIENT_PUBLIC_HOST = 'app.example.com';
    process.env.SECURITY_TXT_POLICY_ORG_ID = 'org_platform';
    settingsState.settings = POLICY_SETTINGS;
    await get('/.well-known/security.txt');
    assert.deepEqual(settingsState.calls, ['org_platform']);
    assert.equal(router._test.policyOrgId({}), 'default');
    assert.equal(router._test.policyOrgId({ SECURITY_TXT_POLICY_ORG_ID: '  ' }), 'default');
});

test('disclosureLinesFromSettings is pure and tolerant of a missing row', () => {
    const f = router._test.disclosureLinesFromSettings;
    assert.deepEqual(f(null), { policy: null, contact: null, enabled: false });
    assert.deepEqual(f({}), { policy: null, contact: null, enabled: false });
    assert.deepEqual(f({ security_txt_policy_enabled: 'true' }), { policy: null, contact: null, enabled: false });
    assert.deepEqual(f(POLICY_SETTINGS), {
        enabled: true,
        policy: 'https://app.example.com/security/disclosure',
        contact: 'mailto:psirt@app.example.com',
    });
});
