/**
 * reportBuilder — pure functions (normalizers, aggregate, renderReportHtml) with
 * a golden file for the rendered report, plus persistReportWebpage against a
 * stub host.
 *
 * The golden (test/golden/report.html) freezes TODAY's output; a human reviews it
 * when it changes. Rewrite it with: UPDATE_GOLDEN=1 node --test test/reportBuilder.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const rb = require('../server/src/reportBuilder');

const GOLDEN = path.join(__dirname, 'golden', 'report.html');

const ZAP = {
    site: [{
        alerts: [
            { alert: 'Missing Anti-clickjacking Header', riskcode: '2', confidence: '2', desc: '<p>The response does not include <b>X-Frame-Options</b>.</p>', solution: '<p>Set the header.</p>', reference: '<p>https://example.test/ref</p>', instances: [{ uri: 'https://t.test/a' }, { uri: 'https://t.test/b' }] },
            { name: 'Cookie without SameSite', riskcode: '1', count: '3', desc: 'x' },
            { alert: 'SQL Injection', riskcode: '3', instances: [{ uri: 'https://t.test/q?id=1' }] },
            { alert: 'Server leaks version', riskcode: '0', instances: [] },
            null,
        ],
    }],
};

const NUCLEI_LINES = [
    JSON.stringify({ 'template-id': 'exposed-git', info: { name: 'Exposed .git', severity: 'high', description: 'The repo is readable.', remediation: 'Block it.', reference: ['https://a.test', 'https://b.test'] }, 'matched-at': 'https://t.test/.git/config' }),
    JSON.stringify({ 'template-id': 'exposed-git', info: { name: 'Exposed .git', severity: 'high' }, 'matched-at': 'https://t.test/.git/HEAD' }),
    'not json',
    JSON.stringify({ templateID: 'tech-detect', info: { severity: 'info' }, host: 't.test' }),
].join('\n');

const TESTSSL = [
    { id: 'cert_chain', severity: 'OK', finding: 'fine' },
    { id: 'TLS1', severity: 'HIGH', finding: 'TLS 1.0 offered' },
    { id: 'BEAST', severity: 'LOW', finding: 'vulnerable' },
    { id: 'banner', severity: 'INFO', finding: 'nginx' },
    { id: 'x', severity: 'DEBUG', finding: 'noise' },
];

function sample() {
    const findings = rbAggregate();
    return { findings: findings.findings, severitySummary: findings.severitySummary };
}
function rbAggregate() {
    return rb.aggregate([rb.normalizeZap(ZAP), rb.normalizeNuclei(NUCLEI_LINES), rb.normalizeTestssl(TESTSSL)]);
}

test('normalizeZap maps riskcode to severity and strips HTML', () => {
    const f = rb.normalizeZap(ZAP);
    assert.deepStrictEqual(f.map((x) => x.severity), ['medium', 'low', 'high', 'informational']);
    assert.strictEqual(f[0].description, 'The response does not include X-Frame-Options.');
    assert.strictEqual(f[0].instanceCount, 2);
    assert.deepStrictEqual(f[0].sampleInstances, ['https://t.test/a', 'https://t.test/b']);
    assert.strictEqual(f[1].name, 'Cookie without SameSite');
    assert.strictEqual(f[1].instanceCount, 3, 'falls back to count when there are no instances');
});

test('normalizers never throw on garbage', () => {
    for (const bad of [null, undefined, 42, 'x', [], {}, [null, 1]]) {
        assert.ok(Array.isArray(rb.normalizeZap(bad)));
        assert.ok(Array.isArray(rb.normalizeNuclei(bad)));
        assert.ok(Array.isArray(rb.normalizeTestssl(bad)));
    }
});

test('normalizeNuclei collapses a template into one finding with samples', () => {
    const f = rb.normalizeNuclei(NUCLEI_LINES);
    assert.strictEqual(f.length, 2);
    const git = f.find((x) => x.name === 'Exposed .git');
    assert.strictEqual(git.instanceCount, 2);
    assert.deepStrictEqual(git.sampleInstances, ['https://t.test/.git/config', 'https://t.test/.git/HEAD']);
    assert.strictEqual(git.reference, 'https://a.test, https://b.test');
    const tech = f.find((x) => x.severity === 'informational');
    assert.strictEqual(tech.name, 'tech-detect');
});

test('normalizeNuclei accepts a JSON array and clamps critical to high', () => {
    const f = rb.normalizeNuclei([{ info: { name: 'A', severity: 'critical' } }]);
    assert.strictEqual(f[0].severity, 'high');
});

test('normalizeTestssl drops OK and DEBUG rows', () => {
    const f = rb.normalizeTestssl(TESTSSL);
    assert.deepStrictEqual(f.map((x) => [x.name, x.severity]), [['TLS1', 'high'], ['BEAST', 'low'], ['banner', 'informational']]);
    assert.strictEqual(rb.normalizeTestssl({ scanResult: TESTSSL }).length, 3);
});

test('aggregate sorts by severity then instance count and sums a summary', () => {
    const { findings, severitySummary } = rbAggregate();
    assert.deepStrictEqual(severitySummary, { high: 3, medium: 1, low: 2, informational: 3 });
    const sevs = findings.map((f) => f.severity);
    assert.deepStrictEqual(sevs, [...sevs].sort((a, b) => ['high', 'medium', 'low', 'informational'].indexOf(a) - ['high', 'medium', 'low', 'informational'].indexOf(b)));
    assert.deepStrictEqual(rb.aggregate(null).severitySummary, { high: 0, medium: 0, low: 0, informational: 0 });
});

test('renderReportHtml escapes hostile text', () => {
    const { html } = rb.renderReportHtml({
        targetUrl: 'https://t.test/"><script>alert(1)</script>',
        engines: [{ engine: 'zap', intensity: 'light' }],
        findings: [{ engine: 'zap', name: '<img src=x onerror=alert(1)>', severity: 'high', description: '<script>x</script>', instanceCount: 1 }],
        severitySummary: { high: 1, medium: 0, low: 0, informational: 0 },
        startedAt: '2026-01-01T00:00:00Z',
        finishedAt: '2026-01-01T00:05:00Z',
        narrative: '**ok** <script>bad()</script>',
    });
    assert.doesNotMatch(html, /<script>/);
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;script&gt;/);
});

test('renderReportHtml matches the golden report', () => {
    const { findings, severitySummary } = sample();
    const { html, css } = rb.renderReportHtml({
        targetUrl: 'https://t.test',
        engines: [{ engine: 'zap', intensity: 'standard' }, { engine: 'nuclei' }, { engine: 'testssl' }],
        findings,
        severitySummary,
        startedAt: '2026-01-01T10:00:00Z',
        finishedAt: '2026-01-01T10:42:00Z',
        narrative: '## Summary\n\nOne **critical** issue: `SQL injection`.\n\n- fix it\n- retest\n\n1. first\n2. second',
    });
    const actual = `${html}\n<!-- css -->\n${css}\n`;
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN, actual);
    assert.strictEqual(actual, fs.readFileSync(GOLDEN, 'utf8'));
});

test('persistReportWebpage hands the host one persist call and returns its id', async () => {
    const calls = [];
    const host = { webpages: { persist: async (o) => { calls.push(o); return 'wp_1'; } } };
    const origLog = console.log;
    console.log = () => {};
    let id;
    try {
        id = await rb.create(host).persistReportWebpage({ userId: 'u1', targetUrl: 'https://t.test/x', html: '<p>h</p>', css: 'p{}' });
    } finally { console.log = origLog; }
    assert.strictEqual(id, 'wp_1');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].name, 'Security report — t.test');
    assert.strictEqual(calls[0].userId, 'u1');
    assert.strictEqual(calls[0].html, '<p>h</p>');
});
