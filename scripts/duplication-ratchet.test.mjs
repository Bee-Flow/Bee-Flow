/**
 * The duplication ratchet reads a jscpd JSON report; these cases hand it one,
 * so the suite needs no jscpd install (test:scripts runs without `npm ci`).
 * What matters: over budget fails (per group: production and test), --update
 * only lowers each, a report that is missing or shapeless is never a pass, and
 * every generated file (the shared-mirror targets and friends) is ignored by
 * .jscpd.json.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isTestFile, groupOf } from './duplication-ratchet.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'duplication-ratchet.mjs');

const ROOT = path.resolve(HERE, '..');

const clone = (lines, a = 'a.js', b = 'b.js') => ({ lines, firstFile: { name: a, start: 1 }, secondFile: { name: b, start: 9 } });
// A report whose clones add up to its total: `prod` lines of production clones, `tst` of test clones.
const reportOf = (prod, tst = 0, extra = []) => {
    const duplicates = [...(prod ? [clone(prod)] : []), ...(tst ? [clone(tst, 'a.test.js', 'b.test.js')] : []), ...extra];
    const duplicatedLines = duplicates.reduce((n, c) => n + c.lines, 0);
    return { statistics: { total: { duplicatedLines, percentage: 1.2 } }, duplicates };
};

function sandbox({ report = reportOf(120), budget = null } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-ratchet-'));
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts/duplication-ratchet.mjs'));
    if (report !== null) fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report));
    if (budget !== null) fs.writeFileSync(path.join(dir, '.jscpd-ratchet.json'), JSON.stringify(typeof budget === 'number' ? { production: budget, test: 0 } : budget));
    return dir;
}

function run(dir, extra = []) {
    try {
        const stdout = execFileSync(process.execPath, [path.join(dir, 'scripts/duplication-ratchet.mjs'), '--report', 'report.json', ...extra], { cwd: dir, encoding: 'utf8' });
        return { code: 0, stdout, stderr: '' };
    } catch (e) {
        return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
    }
}

const budgetsOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.jscpd-ratchet.json'), 'utf8'));
const budgetOf = (dir) => budgetsOf(dir).production;

test('more duplicated lines than the budget fails', () => {
    const r = run(sandbox({ report: reportOf(130), budget: 120 }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /production: 130 duplicated lines, budget is 120/);
});

test('at or under the budget passes', () => {
    assert.strictEqual(run(sandbox({ report: reportOf(120), budget: 120 })).code, 0);
    assert.match(run(sandbox({ report: reportOf(90), budget: 120 })).stdout, /under the budget of 120/);
});

test('--update lowers the budget and never raises it', () => {
    const down = sandbox({ report: reportOf(90), budget: 120 });
    run(down, ['--update']);
    assert.strictEqual(budgetOf(down), 90);
    const up = sandbox({ report: reportOf(200), budget: 120 });
    run(up, ['--update']);
    assert.strictEqual(budgetOf(up), 120);
});

test('the first measurement writes the budget', () => {
    const dir = sandbox({ report: reportOf(77) });
    assert.strictEqual(run(dir).code, 0);
    assert.strictEqual(budgetOf(dir), 77);
});

test('--list names the largest clones first', () => {
    const r = run(sandbox({ report: reportOf(0, 0, [clone(10, 'small.js'), clone(50, 'big.js')]), budget: 60 }), ['--list']);
    assert.match(r.stdout, /50 {2}big\.js:1 ↔ b\.js:9\n\s+10 {2}small\.js/);
});

test('a missing or shapeless report is an error, not a pass', () => {
    assert.strictEqual(run(sandbox({ report: null, budget: 1 })).code, 2);
    const r = run(sandbox({ report: { statistics: {} }, budget: 1 }));
    assert.strictEqual(r.code, 2);
    assert.match(r.stderr, /duplicatedLines/);
    // clones that do not add up to the total: the split would be a guess
    const off = run(sandbox({ report: { statistics: { total: { duplicatedLines: 99 } }, duplicates: [clone(10)] }, budget: 1 }));
    assert.strictEqual(off.code, 2);
    assert.match(off.stderr, /add up to 10 lines, jscpd's total says 99/);
});

test('test files are recognised; production code is not', () => {
    for (const f of ['server/x.test.js', 'agent-hub/src/a/B.test.tsx', 'e2e/tests/login.spec.ts', 'mobile/src/__tests__/a.ts',
        'guard-service/tests/test_pii.py', 'guard-service/app/conftest.py', 'server/testUtils/pglitePool.js',
        'hub-module-sdk/test-kit/hostMock.js', 'hub-module-sdk/template/test/hostMock.js', 'server/routes/ai/notebookChat.testkit.js',
        'server/shared/appDefinition/lockstep.fixture.mjs', 'server/automation/patterns/__fixtures__/builders.js',
        'agent-hub/src/components/admin/security/guardrails/orgShield/ownData/testKit.tsx', 'a\\b\\c.test.js']) {
        assert.ok(isTestFile(f), f);
    }
    for (const f of ['server/routes/agents/tests.js', 'server/routes/skills/test.js', 'server/core/agentRuntime/testSandbox.js',
        'agent-hub/src/demo/fixtures/agents.js', 'agent-hub/src/components/x/latest.js', 'guard-service/app/contest.py']) {
        assert.ok(!isTestFile(f), f);
    }
});

test('a clone is test only when both ends are test code', () => {
    assert.strictEqual(groupOf(clone(5, 'a.test.js', 'b.test.js')), 'test');
    assert.strictEqual(groupOf(clone(5, 'a.js', 'b.test.js')), 'production');
    assert.strictEqual(groupOf(clone(5, 'a.test.js', 'b.js')), 'production');
    assert.strictEqual(groupOf(clone(5)), 'production');
});

test('each group has its own budget: test clones cannot hide a production clone', () => {
    // total 130 is under 100 + 50, but production went up
    const r = run(sandbox({ report: reportOf(110, 20), budget: { production: 100, test: 50 } }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /production: 110 duplicated lines, budget is 100/);
    assert.match(r.stdout, /test: 20 duplicated lines, under the budget of 50/);
    const t = run(sandbox({ report: reportOf(100, 51), budget: { production: 100, test: 50 } }));
    assert.strictEqual(t.code, 1);
    assert.match(t.stderr, /test: 51 duplicated lines, budget is 50/);
    assert.match(t.stdout, /production: 100 duplicated lines, at budget/);
});

test('--update lowers each group on its own and never raises either', () => {
    const dir = sandbox({ report: reportOf(90, 70), budget: { production: 100, test: 50 } });
    assert.strictEqual(run(dir, ['--update']).code, 0);
    const b = budgetsOf(dir);
    assert.strictEqual(b.production, 90);
    assert.strictEqual(b.test, 50);
});

test('a budget file without the two groups is measured afresh', () => {
    const dir = sandbox({ report: reportOf(30, 12), budget: { duplicatedLines: 999 } });
    assert.strictEqual(run(dir).code, 0);
    const b = budgetsOf(dir);
    assert.deepStrictEqual([b.production, b.test], [30, 12]);
});

test('--list prints the clones per group', () => {
    const r = run(sandbox({ report: reportOf(40, 25), budget: { production: 40, test: 25 } }), ['--list']);
    assert.match(r.stdout, /production \(40 duplicated lines\):\n\s+40 {2}a\.js:1/);
    assert.match(r.stdout, /test \(25 duplicated lines\):\n\s+25 {2}a\.test\.js:1/);
});

// Generated files are duplication nobody writes; counting them would let a
// generator run eat the budget (or a deleted mirror fake a win).
const jscpdIgnore = () => JSON.parse(fs.readFileSync(path.join(ROOT, '.jscpd.json'), 'utf8')).ignore;
const ignored = (file) => jscpdIgnore().some((g) => path.matchesGlob(file, g));

test('every shared-mirror target is in the ignore list of .jscpd.json', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/shared-mirror.manifest.json'), 'utf8'));
    for (const { target } of manifest.entries) {
        // a directory target: any file inside it; a file target: the file itself
        const probe = path.extname(target) ? target : `${target}/any/file.mjs`;
        assert.ok(ignored(probe), `${target} is generated (scripts/shared-mirror.manifest.json) but .jscpd.json counts it`);
    }
});

test('the other generated files are ignored too, hand-written neighbours are not', () => {
    for (const f of ['agent-hub/src/i18n/en-defaults.js', 'server/core/markdown/editorSerialization.cjs', 'server/core/markdown/editorCollab.cjs',
        'mobile/src/core/theme/generated/webTokens.generated.ts', 'agent-hub/src/components/admin/product-website/blockEditors/blockData.generated.mjs',
        'mobile/src/shared/ui/icons/registry.generated.ts', 'server/learning/catalog.generated.js',
        'agent-hub/src/components/onboarding/generated/lessons.js', 'agent-hub/public/module-shims/react.js', 'e2e/tests/generated/kb-upload.spec.ts']) {
        assert.ok(ignored(f), f);
    }
    for (const f of ['mobile/src/shared/expr/index.ts', 'mobile/src/shared/ui/icons/registry.generated.test.ts', 'server/shared/expr/engine.mjs',
        'server/core/markdown/index.js']) {
        assert.ok(!ignored(f), f);
    }
});
