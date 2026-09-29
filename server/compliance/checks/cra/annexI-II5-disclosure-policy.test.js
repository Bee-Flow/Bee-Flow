/**
 * CRA Annex I II(5) disclosure policy: relevance gate, no public host, 404 →
 * fail, served without policy → warn, served + Policy line → pass, attested
 * URL leg, autoFix guard rails, and evidence free of e-mail addresses even
 * though the served file is full of them.
 *
 * Network is never touched: urlProbe.probe is a double keyed by URL; the real
 * parseSecurityTxt is kept.
 *
 * Run: cd server && node --test --test-force-exit compliance/checks/cra/annexI-II5-disclosure-policy.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const path = require('path');

// Absolute path on purpose: the check requires '../../lib/urlProbe' from THIS
// directory too, and Node's relative-resolve cache would otherwise hand it the
// real module before the resolve stub gets a say.
const realProbe = require(path.join(__dirname, '..', '..', 'lib', 'urlProbe'));

const state = {
    settings: {},
    responses: {},      // url → { ok, status, snippet, error }
    probed: [],
    saved: [],
};

const fakeComplianceStore = {
    async getSettings() { return state.settings; },
    async saveSettings(orgId, patch) { state.saved.push({ orgId, patch }); state.settings = { ...state.settings, ...patch }; return state.settings; },
};
const fakeUrlProbe = {
    parseSecurityTxt: realProbe.parseSecurityTxt,
    async probe(url) {
        state.probed.push(url);
        const r = state.responses[url];
        if (!r) return { ok: false, status: null, content_type: null, snippet: '', error: 'getaddrinfo ENOTFOUND', final_url: null, truncated: false, bytes: 0 };
        return { ok: r.ok ?? (r.status >= 200 && r.status < 300), status: r.status ?? 200, content_type: 'text/plain', snippet: r.snippet || '', error: r.error || null, final_url: url, truncated: false, bytes: (r.snippet || '').length };
    },
};

const restore = installResolveStub({
    '../../../stores/complianceStore': fakeComplianceStore,
    '../../lib/urlProbe': fakeUrlProbe,
});
const check = require('./annexI-II5-disclosure-policy');
test.after(() => restore());

const BASE = 'https://app.example.com';
const SEC = `${BASE}/.well-known/security.txt`;
const POLICY = 'https://www.example.com/security/disclosure';
const FUTURE = new Date(Date.now() + 200 * 86400e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
const PAST = '2025-01-01T00:00:00Z';

const SERVED_NO_POLICY = `# comments\nContact: mailto:security@example.com\nContact: mailto:psirt@example.com\nExpires: ${FUTURE}\nPreferred-Languages: nl, en\n`;
const SERVED_WITH_POLICY = `${SERVED_NO_POLICY}Policy: ${POLICY}\nCanonical: ${SEC}\n`;

const READY = { framework_relevance: { cra: 'relevant' }, cra_role: 'manufacturer', public_base_url: BASE, psirt_contact_email: 'psirt@example.com' };

const ENV_KEYS = ['CLIENT_PUBLIC_HOST', 'CLIENT_PROTOCOL'];
let savedEnv;
test.beforeEach(() => {
    state.settings = { ...READY };
    state.responses = {};
    state.probed = [];
    state.saved = [];
    savedEnv = {};
    for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});
test.afterEach(() => {
    for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});

function noPersonalData(r) {
    const blob = JSON.stringify(r.evidence) + (r.details || '');
    assert.ok(!/@/.test(blob), `evidence/details must not carry an e-mail address: ${blob}`);
    // Strip the public URLs (an org's own site is not personal data), then no
    // mailbox fragment may remain.
    const withoutUrls = blob.replace(/https?:[^"\s]+/g, '');
    assert.ok(!/psirt@|security@|mailto:/.test(withoutUrls), `no address fragments: ${withoutUrls}`);
}

test('module shape: id, hybrid verification, NIS2 + ISO tags, autoFix id, settings deep-link', () => {
    assert.equal(check.id, 'CRA-AnnexI-II5-disclosure-policy');
    assert.equal(check.regulation, 'CRA');
    assert.equal(check.severity, 'high');
    assert.equal(check.scope, 'global');
    assert.equal(check.verification, 'hybrid');
    assert.deepEqual(check.frameworks, [{ regulation: 'NIS2', ref: 'Art. 21(2)(e)' }, { regulation: 'ISO27001', ref: 'A.8.8' }]);
    assert.equal(check.remediationLink, 'admin/compliance/settings');
    assert.equal(check.autoFixId, 'cra_publish_security_txt_policy');
    assert.equal(typeof check.autoFix, 'function');
});

test('relevance gate: CRA not relevant → not_applicable, nothing probed', async () => {
    state.settings = { ...READY, framework_relevance: { cra: 'not_relevant' } };
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'not_applicable');
    assert.deepEqual(r.evidence, { relevance: 'not_relevant' });
    assert.deepEqual(state.probed, []);
});

test('no public host at all (empty settings, no env) → fail with the settings hint; with an attested policy → warn', async () => {
    state.settings = {};
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.security_txt_url, null);
    assert.match(r.details, /No public base URL/);
    assert.deepEqual(state.probed, []);

    state.settings = { vuln_disclosure_url: POLICY };
    state.responses[POLICY] = { status: 200, snippet: '<html>policy</html>' };
    const r2 = await check.evaluate('org1');
    assert.equal(r2.status, 'warn');
    assert.equal(r2.evidence.attested_policy_reachable, true);
    assert.match(r2.details, /cannot be verified/);
});

test('a private/localhost public host is treated as "no public host" (the probe would refuse it anyway)', async () => {
    state.settings = { ...READY, public_base_url: 'http://localhost:5176' };
    process.env.CLIENT_PUBLIC_HOST = '10.0.0.5:3101';
    const r = await check.evaluate('org1');
    assert.equal(r.evidence.public_base_url, null);
    assert.equal(r.status, 'fail');
});

test('CLIENT_PUBLIC_HOST is the fallback when the org has no public_base_url', async () => {
    state.settings = { ...READY, public_base_url: null };
    process.env.CLIENT_PUBLIC_HOST = 'portal.example.org';
    state.responses['https://portal.example.org/.well-known/security.txt'] = { status: 200, snippet: SERVED_WITH_POLICY };
    const r = await check.evaluate('org1');
    assert.equal(r.evidence.public_base_url, 'https://portal.example.org');
    assert.equal(r.status, 'pass');
});

test('security.txt 404 → fail (no contact published)', async () => {
    state.responses[SEC] = { status: 404, snippet: '{"error":"Not configured"}' };
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.http_status, 404);
    assert.equal(r.evidence.served, false);
    assert.match(r.details, /HTTP 404/);
    assert.match(r.details, /PSIRT contact/);
    noPersonalData(r);
});

test('served but without a Contact field → fail', async () => {
    state.responses[SEC] = { status: 200, snippet: `Expires: ${FUTURE}\nPolicy: ${POLICY}\n` };
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.contact_count, 0);
    assert.match(r.details, /no Contact field/);
});

test('served with contacts but no Policy line and nothing attested → warn (partial)', async () => {
    state.responses[SEC] = { status: 200, snippet: SERVED_NO_POLICY };
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.served, true);
    assert.equal(r.evidence.contact_count, 2);
    assert.equal(r.evidence.policy_published, false);
    assert.equal(r.evidence.expires_valid, true);
    assert.match(r.details, /no Policy line is published/);
    noPersonalData(r);
});

test('served with a Policy line → pass; the addresses in the file never reach the evidence', async () => {
    state.responses[SEC] = { status: 200, snippet: SERVED_WITH_POLICY };
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.policy_published, true);
    assert.equal(r.evidence.policy_url, POLICY);
    assert.equal(r.evidence.contact_count, 2);
    assert.equal(r.evidence.psirt_contact_set, true);
    assert.match(r.details, /Policy line/);
    noPersonalData(r);
});

test('an expired Expires degrades a served file to warn', async () => {
    state.responses[SEC] = { status: 200, snippet: SERVED_WITH_POLICY.replace(FUTURE, PAST) };
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.expired, true);
    assert.match(r.details, /expired on 2025-01-01/);
});

test('attested policy URL: reachable + fix applied → pass even before the Policy line shows; not yet applied → warn with fix hint; non-2xx → warn', async () => {
    state.responses[SEC] = { status: 200, snippet: SERVED_NO_POLICY };
    state.responses[POLICY] = { status: 200, snippet: 'policy' };

    state.settings = { ...READY, vuln_disclosure_url: POLICY, security_txt_policy_enabled: true };
    const applied = await check.evaluate('org1');
    assert.equal(applied.status, 'pass');
    assert.equal(applied.evidence.attested_policy_reachable, true);
    assert.equal(applied.evidence.attested_policy_url, POLICY);
    assert.ok(state.probed.includes(POLICY), 'the attested URL is probed too');

    state.settings = { ...READY, vuln_disclosure_url: POLICY, security_txt_policy_enabled: false };
    const pending = await check.evaluate('org1');
    assert.equal(pending.status, 'warn');
    assert.match(pending.details, /apply the fix to add the Policy line/);

    state.responses[POLICY] = { status: 500, snippet: '' };
    state.settings = { ...READY, vuln_disclosure_url: POLICY, security_txt_policy_enabled: true };
    const dead = await check.evaluate('org1');
    assert.equal(dead.status, 'warn');
    assert.equal(dead.evidence.attested_policy_status, 500);
    assert.match(dead.details, /answers HTTP 500/);

    // Published Policy line AND a dead attested URL still warns — the link researchers follow is broken.
    state.responses[SEC] = { status: 200, snippet: SERVED_WITH_POLICY };
    const deadButPublished = await check.evaluate('org1');
    assert.equal(deadButPublished.status, 'warn');
    assert.equal(deadButPublished.evidence.policy_url_matches_attested, true);
});

test('a non-http attested URL (mailto:) is ignored rather than probed', async () => {
    state.settings = { ...READY, vuln_disclosure_url: 'mailto:psirt@example.com' };
    state.responses[SEC] = { status: 200, snippet: SERVED_NO_POLICY };
    const r = await check.evaluate('org1');
    assert.equal(r.evidence.attested_policy_url, null);
    assert.equal(state.probed.length, 1);
    noPersonalData(r);
});

test('unreachable security.txt (network error) with a reachable attested policy → warn, without → fail', async () => {
    // no response registered for SEC → ENOTFOUND
    state.settings = { ...READY, vuln_disclosure_url: POLICY };
    state.responses[POLICY] = { status: 200, snippet: 'policy' };
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'warn');
    assert.match(r.evidence.probe_error, /security\.txt: getaddrinfo ENOTFOUND/);

    state.settings = { ...READY };
    const r2 = await check.evaluate('org1');
    assert.equal(r2.status, 'fail');
});

test('autoFix: refused without a policy URL, idempotent when already enabled, otherwise flips the setting via saveSettings', async () => {
    state.settings = { ...READY };
    const refused = await check.autoFix('org1', { actorId: 'admin-1' });
    assert.equal(refused.changed, 0);
    assert.match(refused.summary, /No disclosure-policy URL/);
    assert.deepEqual(state.saved, []);

    state.settings = { ...READY, vuln_disclosure_url: POLICY };
    const applied = await check.autoFix('org1', { actorId: 'admin-1' });
    assert.equal(applied.changed, 1);
    assert.deepEqual(state.saved, [{ orgId: 'org1', patch: { security_txt_policy_enabled: true } }]);
    assert.equal(applied.before, false);
    assert.equal(applied.after, true);
    assert.equal(applied.policy_url, POLICY);
    assert.equal(applied.psirt_contact_set, true);
    assert.ok(!/@/.test(JSON.stringify(applied)), 'the fix result (evidence chain) carries no e-mail address');

    const again = await check.autoFix('org1', {});
    assert.equal(again.changed, 0);
    assert.match(again.summary, /already publishes/);
    assert.equal(state.saved.length, 1);
});

test('_publicBaseUrl: settings first, env fallback with scheme handling, private hosts rejected', () => {
    const { _publicBaseUrl } = check._test;
    assert.equal(_publicBaseUrl({ public_base_url: 'https://app.example.com/some/path' }, {}), 'https://app.example.com');
    assert.equal(_publicBaseUrl({}, { CLIENT_PUBLIC_HOST: 'app.example.com', CLIENT_PROTOCOL: 'http' }), 'http://app.example.com');
    assert.equal(_publicBaseUrl({}, { CLIENT_PUBLIC_HOST: 'https://app.example.com:8443' }), 'https://app.example.com:8443');
    assert.equal(_publicBaseUrl({ public_base_url: 'http://127.0.0.1' }, { CLIENT_PUBLIC_HOST: 'localhost' }), null);
    assert.equal(_publicBaseUrl({ public_base_url: 'ftp://app.example.com' }, {}), null);
    assert.equal(_publicBaseUrl(null, {}), null);
});
