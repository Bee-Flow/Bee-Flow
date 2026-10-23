/**
 * The gate's job is to REFUSE: a new HIGH in something that ships, an expired
 * acceptance, a runtime behind a security release, a report it cannot read.
 * Each refusal has a test; so does the one softening it allows (tooling and
 * dev-only packages are reported, not gating). Fixtures are written to a
 * throwaway root; no scanner, no network.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { alertKey, evaluate, main, osvFindings, readKnown, toSarif } from './vuln-watch-gate.mjs';

const TODAY = '2026-10-23';

function sandbox({ accepted, results, runtime = { findings: [] } }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vuln-gate-'));
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.mkdirSync(path.join(root, '.github/security'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts/packages.json'), JSON.stringify({ packages: [
        { dir: 'server', role: 'service' },
        { dir: 'docs', role: 'tooling' },
    ] }));
    for (const d of ['server', 'docs']) {
        fs.mkdirSync(path.join(root, d));
        fs.writeFileSync(path.join(root, d, 'package-lock.json'), JSON.stringify({ packages: {
            '': {},
            'node_modules/prod-pkg': { version: '1.0.0' },
            'node_modules/dev-pkg': { version: '1.0.0', dev: true },
        } }, null, 2));
    }
    if (accepted) fs.writeFileSync(path.join(root, '.github/security/vuln-watch-accepted.json'), JSON.stringify({ accepted }));
    fs.writeFileSync(path.join(root, 'osv.json'), JSON.stringify(results === undefined ? { results: [] } : { results }));
    fs.writeFileSync(path.join(root, 'runtime.json'), JSON.stringify(runtime));
    const sarif = path.join(root, 'out.sarif');
    const code = main(['--osv', path.join(root, 'osv.json'), '--runtime', path.join(root, 'runtime.json'), '--sarif', sarif], { root, today: TODAY, log: () => {} });
    return { code, root, sarif: fs.existsSync(sarif) ? JSON.parse(fs.readFileSync(sarif, 'utf8')) : null };
}

const vuln = (dir, name, score, id = 'GHSA-aaaa-bbbb-cccc') => ({
    source: { path: `${dir}/package-lock.json` },
    packages: [{
        package: { name, version: '1.0.0', ecosystem: 'npm' },
        groups: [{ ids: [id], aliases: ['CVE-2026-1'], max_severity: String(score) }],
        vulnerabilities: [{ id, summary: 'bad thing' }],
    }],
});

test('a new HIGH in a shipping package fails', () => {
    assert.equal(sandbox({ results: [vuln('server', 'prod-pkg', 8.1)] }).code, 1);
});

test('below HIGH passes', () => {
    assert.equal(sandbox({ results: [vuln('server', 'prod-pkg', 6.9)] }).code, 0);
});

test('tooling directories and dev-only packages are reported, not gating', () => {
    const { code, sarif } = sandbox({ results: [vuln('docs', 'prod-pkg', 9.8), vuln('server', 'dev-pkg', 9.8)] });
    assert.equal(code, 0);
    assert.deepEqual(sarif.runs[0].results.map((r) => r.level), ['warning', 'warning']);
});

test('an accepted id passes until it expires, then fails again', () => {
    const entry = { id: 'CVE-2026-1', reason: 'not reachable', expires: '2026-11-01' };
    assert.equal(sandbox({ accepted: [entry], results: [vuln('server', 'prod-pkg', 8.1)] }).code, 0);
    assert.equal(sandbox({ accepted: [{ ...entry, expires: '2026-10-01' }], results: [vuln('server', 'prod-pkg', 8.1)] }).code, 1);
});

test('an acceptance scoped to another path does not cover this one', () => {
    const entry = { id: 'GHSA-aaaa-bbbb-cccc', path: 'mobile', reason: 'x', expires: '2027-01-01' };
    assert.equal(sandbox({ accepted: [entry], results: [vuln('server', 'prod-pkg', 8.1)] }).code, 1);
});

test('a malformed acceptance list fails instead of accepting', () => {
    assert.equal(sandbox({ accepted: [{ id: 'GHSA-aaaa-bbbb-cccc' }], results: [vuln('server', 'prod-pkg', 8.1)] }).code, 1);
});

test('a scan that saw no lockfile fails: it is not a clean result', () => {
    assert.equal(sandbox({ results: [] }).code, 1);
});

test('a runtime behind a security release fails, an unreadable feed fails, a notice does not', () => {
    const f = (level) => ({ findings: [{ level, id: 'RUNTIME-node-22.23.2', file: '.nvmrc', line: 1, ref: 'node@22.23.2', message: 'm' }] });
    const results = [vuln('server', 'prod-pkg', 1.0)];
    assert.equal(sandbox({ results, runtime: f('high') }).code, 1);
    assert.equal(sandbox({ results, runtime: f('error') }).code, 1);
    assert.equal(sandbox({ results, runtime: f('notice') }).code, 0);
});

test('without a CVSS score the database label decides', () => {
    const r = vuln('server', 'prod-pkg', '');
    r.packages[0].vulnerabilities[0].database_specific = { severity: 'CRITICAL' };
    const [f] = osvFindings({ results: [r] }, { root: '/', registry: [{ dir: 'server', role: 'service' }] });
    assert.equal(f.score, 9.0);
});

test('SARIF carries the security severity and points at the package line', () => {
    const { root } = sandbox({ results: [vuln('server', 'prod-pkg', 8.1)] });
    const findings = osvFindings({ results: [vuln('server', 'prod-pkg', 8.1)] }, { root, registry: [{ dir: 'server', role: 'service' }] });
    const run = toSarif(findings).runs[0];
    assert.equal(run.tool.driver.rules[0].properties['security-severity'], '8.1');
    assert.equal(run.results[0].level, 'error');
    assert.equal(run.results[0].locations[0].physicalLocation.artifactLocation.uri, 'server/package-lock.json');
    assert.ok(run.results[0].locations[0].physicalLocation.region.startLine > 1);
});

test('a finding already in the Security tab does not fail again; a new location does', () => {
    const findings = osvFindings({ results: [vuln('server', 'prod-pkg', 8.1)] }, { root: '/nonexistent', registry: [{ dir: 'server', role: 'service' }] });
    const known = new Set([alertKey('GHSA-aaaa-bbbb-cccc', 'server/package-lock.json')]);
    assert.equal(evaluate(findings, [], TODAY, { known }).fail.length, 0);
    assert.equal(evaluate(findings, [], TODAY, { known: new Set([alertKey('GHSA-aaaa-bbbb-cccc', 'mobile/package-lock.json')]) }).fail.length, 1);
});

test('an hourly run leaves expired acceptances and unreadable feeds to the daily run', () => {
    const findings = osvFindings({ results: [vuln('server', 'prod-pkg', 8.1)] }, { root: '/nonexistent', registry: [{ dir: 'server', role: 'service' }] });
    const expired = [{ id: 'GHSA-aaaa-bbbb-cccc', reason: 'x', expires: '2026-10-01' }];
    assert.equal(evaluate(findings, expired, TODAY, { hourly: true }).fail.length, 0);
    assert.equal(evaluate(findings, expired, TODAY).fail.length, 1);
    const feed = [{ kind: 'runtime', level: 'error', id: 'RUNTIME-node-22', file: '.nvmrc', line: 1, gating: true }];
    assert.equal(evaluate(feed, [], TODAY, { hourly: true }).fail.length, 0);
    assert.equal(evaluate(feed, [], TODAY).fail.length, 1);
});

test('the alerts file is read as rule|path keys; a missing file means nothing reported', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'known-')), 'known.jsonl');
    fs.writeFileSync(file, '{"rule":"GHSA-x","path":"server/package-lock.json"}\n\n');
    assert.deepEqual([...readKnown(file)], ['GHSA-x|server/package-lock.json']);
    assert.equal(readKnown(file + '.missing').size, 0);
});
