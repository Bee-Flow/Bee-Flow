/**
 * EAA-Art13-accessibility-statement — attested URL + probe.
 * Run: cd server && node --test --test-force-exit compliance/checks/eaa/art13-accessibility-statement.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const ORG = 'org-a';
const fx = { settings: {}, probe: null, probed: [] };
const restore = installResolveStub({
    '../../../stores/complianceStore': { getSettings: async (orgId) => ({ organization_id: orgId, updated_at: '2026-09-01T10:00:00Z', ...fx.settings }) },
    '../../lib/urlProbe': {
        probe: async (url, opts) => { fx.probed.push({ url, opts }); return fx.probe; },
    },
    '../../../utils/ssrfGuard': { safeFetch: async () => { throw new Error('must not be used while lib/urlProbe exists'); } },
});
const check = require('./art13-accessibility-statement');
test.after(() => restore());

test.beforeEach(() => { fx.settings = {}; fx.probe = null; fx.probed = []; });

const OK_PAGE = { ok: true, status: 200, content_type: 'text/html; charset=utf-8', snippet: '<html><body><h1>Toegankelijkheidsverklaring</h1><p>Wij voldoen aan WCAG 2.1 niveau AA (EN 301 549).</p></body></html>', error: null };

test('contract shape', () => {
    assert.equal(check.id, 'EAA-Art13-accessibility-statement');
    assert.equal(check.verification, 'hybrid');
    assert.equal(check.remediationLink, 'admin/compliance/settings');
});

test('relevance gate', async () => {
    fx.settings = { framework_relevance: { eaa: 'not_relevant' }, accessibility_statement_url: 'https://example.org/a11y' };
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'not_applicable');
    assert.deepEqual(r.evidence, { relevance: 'not_relevant' });
    assert.equal(fx.probed.length, 0);
});

test('no URL → fail, nothing probed', async () => {
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.url_set, false);
    assert.equal(fx.probed.length, 0);
});

test('non-http URL → fail (url_set true)', async () => {
    fx.settings = { accessibility_statement_url: 'mailto:someone@example.org' };
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.url_set, true);
    assert.equal(r.evidence.statement_url, null);
    assert.ok(!/@/.test(JSON.stringify(r.evidence)));
});

test('probe error / private host → warn with the error code', async () => {
    fx.settings = { accessibility_statement_url: 'https://example.org/a11y' };
    fx.probe = { ok: false, status: null, content_type: null, snippet: '', error: 'private_host' };
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.probe_error, 'private_host');
    assert.equal(fx.probed[0].url, 'https://example.org/a11y');
});

test('non-2xx → warn', async () => {
    fx.settings = { accessibility_statement_url: 'https://example.org/a11y' };
    fx.probe = { ok: false, status: 404, content_type: 'text/html', snippet: '', error: null };
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.http_status, 404);
    assert.match(r.details, /404/);
});

test('2xx without accessibility vocabulary → warn', async () => {
    fx.settings = { accessibility_statement_url: 'https://example.org/a11y' };
    fx.probe = { ok: true, status: 200, content_type: 'text/html', snippet: '<html><body><script>var accessible = 1</script><p>Welcome to our shop</p></body></html>', error: null };
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.deepEqual(r.evidence.matched_terms, []);
});

test('2xx with WCAG / EN 301 549 / toegankelijk → pass with matched terms and the declared level', async () => {
    fx.settings = { accessibility_statement_url: 'https://example.org/a11y', accessibility_conformance_level: 'WCAG 2.1 AA', accessibility_conformance_at: '2026-08-01' };
    fx.probe = OK_PAGE;
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    for (const t of ['toegankelijk', 'WCAG', 'EN 301 549']) assert.ok(r.evidence.matched_terms.includes(t), t);
    assert.equal(r.evidence.declared_level, 'WCAG 2.1 AA');
    assert.equal(r.evidence.declared_at.slice(0, 10), '2026-08-01');
    assert.match(r.details, /WCAG 2\.1 AA/);
});

test('evidence carries no personal data', async () => {
    fx.settings = { accessibility_statement_url: 'https://example.org/a11y', dpo_email: 'dpo@example.org', dpo_name: 'Jane Doe' };
    fx.probe = OK_PAGE;
    const r = await check.evaluate(ORG);
    const json = JSON.stringify(r.evidence);
    assert.ok(!/[\w.+-]+@[\w-]+\.[\w.-]+/.test(json));
    assert.ok(!/Jane/.test(json));
});
