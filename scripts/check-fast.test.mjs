/**
 * check:fast is only worth running if its PASS means something, so the cases
 * here are the ways it could say yes without having asked: a denylisted gate
 * that sneaks back in, a failing gate that is not reported, a .sh gate that
 * reads as PASS on a machine without bash, a hung gate that is waited on.
 *
 * Sandbox style is the one scripts/eslint-budget.test.mjs uses: a throwaway
 * repo under os.tmpdir() with the real script copied in and a package.json
 * whose lint:* scripts are tiny node one-liners, so no real gate runs.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DENYLIST, lintGates, invokesShellScript, branchGates, verdict, findBash, main } from './check-fast.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'check-fast.mjs');

// Quoted for both sh and cmd.exe: double quotes outside, single inside.
const nodeEval = (js) => `node -e "${js}"`;

function sandbox(scripts) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-fast-'));
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts/check-fast.mjs'));
    fs.copyFileSync(path.join(HERE, 'entry-point.mjs'), path.join(dir, 'scripts/entry-point.mjs'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'sandbox', private: true, scripts }, null, 2));
    return dir;
}

// The CLI as a user runs it; --only lint: keeps the two git-based gates out.
function cli(dir, args = ['--only', 'lint:']) {
    const res = spawnSync(process.execPath, [path.join(dir, 'scripts/check-fast.mjs'), ...args], { cwd: dir, encoding: 'utf8' });
    return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

// In-process, with the bash lookup and the git-based gates injected.
async function inProcess(dir, opts = {}) {
    const lines = [];
    const code = await main({ argv: [], root: dir, branchGates: () => [], parallel: 2, print: (l) => lines.push(l), ...opts });
    return { code, out: lines.join('\n') };
}

test('the denylist keeps out exactly the slow, install- and network-bound lint scripts', () => {
    assert.deepStrictEqual([...DENYLIST.keys()].sort(), [
        'lint:budget', 'lint:bundle', 'lint:coverage', 'lint:deps', 'lint:deps:test', 'lint:duplication', 'lint:gitleaks',
    ]);
    const scripts = { build: 'x', 'test:scripts': 'x', 'lint:workflows': 'x', 'lint:later-ratchet': 'x' };
    for (const name of DENYLIST.keys()) scripts[name] = 'x';
    assert.deepStrictEqual(lintGates(scripts).map((g) => g.name), ['lint:workflows', 'lint:later-ratchet'],
        'every other lint:* script is a gate, including one added after this script was written');
});

test('every denylisted name is a script the root package.json has', () => {
    // A renamed lint:budget would otherwise stop matching and start running
    // three minutes of eslint inside the "few seconds" command.
    const { scripts } = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
    for (const name of DENYLIST.keys()) assert.ok(scripts[name], `${name} is in DENYLIST but not in package.json`);
    assert.strictEqual(scripts['check:fast'], 'node scripts/check-fast.mjs');
});

test('a command that runs a .sh file is sent to bash, any other to the shell', () => {
    assert.ok(invokesShellScript('./scripts/check-no-test-secrets.sh'));
    assert.ok(invokesShellScript('./scripts/scan-secrets.sh --range a..b'));
    assert.ok(invokesShellScript('node x.mjs && ./y.sh'));
    assert.ok(!invokesShellScript('node scripts/count-ratchet.mjs big-file server'));
    assert.ok(!invokesShellScript('node scripts/foo.sh.mjs'));
    assert.deepStrictEqual(lintGates({ 'lint:secrets': './scripts/check-no-test-secrets.sh' })[0].bash, true);
});

test('a failing gate fails the run and its output is printed in full', () => {
    const dir = sandbox({
        'lint:ok': nodeEval("console.log('fine')"),
        'lint:bad': nodeEval("console.log('first line of the complaint'); console.error('BAD-GATE-STDERR'); process.exit(3)"),
        'lint:deps': nodeEval("require('fs').writeFileSync('ran-deps', '')"),
        build: nodeEval("require('fs').writeFileSync('ran-build', '')"),
    });
    const r = cli(dir);
    assert.strictEqual(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /PASS {2}lint:ok/);
    assert.match(r.stdout, /FAIL {2}lint:bad .*exit 3/);
    assert.match(r.stdout, /── lint:bad \(exit 3\) ──/);
    assert.match(r.stdout, /first line of the complaint/);
    assert.match(r.stdout, /BAD-GATE-STDERR/, 'stderr is part of the output shown');
    assert.match(r.stdout, /1 passed, 0 skipped, 1 failed .*failing: lint:bad/);
    assert.ok(!fs.existsSync(path.join(dir, 'ran-deps')), 'a denylisted script must not run');
    assert.ok(!fs.existsSync(path.join(dir, 'ran-build')), 'a script outside lint:* must not run');
});

test('all gates passing exits 0', () => {
    const r = cli(sandbox({ 'lint:a': nodeEval('0'), 'lint:b': nodeEval('0') }));
    assert.strictEqual(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /2 passed, 0 skipped, 0 failed/);
});

test('--list prints the gates and the denylist without running anything', () => {
    const dir = sandbox({ 'lint:marker': nodeEval("require('fs').writeFileSync('ran-marker', '')") });
    const r = cli(dir, ['--list']);
    assert.strictEqual(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /lint:marker +shell +node -e/);
    assert.match(r.stdout, /i18n-key-guard/);
    assert.match(r.stdout, /lint:budget +full eslint/);
    assert.ok(!fs.existsSync(path.join(dir, 'ran-marker')), '--list must not run the gate');
});

test('--only narrows the gates, and a filter that matches nothing is a usage error', () => {
    const dir = sandbox({
        'lint:wanted': nodeEval('0'),
        'lint:other': nodeEval("require('fs').writeFileSync('ran-other', '')"),
    });
    const r = cli(dir, ['--only', 'wanted']);
    assert.strictEqual(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /1 passed/);
    assert.ok(!fs.existsSync(path.join(dir, 'ran-other')));
    assert.strictEqual(cli(dir, ['--only', 'nothing-like-this']).code, 2);
    assert.strictEqual(cli(dir, ['--bogus']).code, 2);
});

test('a .sh gate with no bash is SKIP, not PASS', async () => {
    const dir = sandbox({ 'lint:sh': './scripts/fake.sh', 'lint:ok': nodeEval('0') });
    const r = await inProcess(dir, { findBash: () => null });
    assert.strictEqual(r.code, 0);
    assert.match(r.out, /SKIP {2}lint:sh .*no bash found/);
    assert.doesNotMatch(r.out, /PASS {2}lint:sh/);
    assert.match(r.out, /1 passed, 1 skipped, 0 failed/);
});

const bash = findBash();

test('a .sh gate runs under bash when there is one', { skip: !bash && 'no bash on this machine' }, async () => {
    const dir = sandbox({ 'lint:sh': './scripts/fake.sh' });
    fs.writeFileSync(path.join(dir, 'scripts/fake.sh'), '#!/usr/bin/env bash\necho "from bash $BASH_VERSION"\nexit 1\n', { mode: 0o755 });
    const r = await inProcess(dir, { findBash: () => bash });
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /FAIL {2}lint:sh .*exit 1/);
    assert.match(r.out, /from bash \d/);
});

test('a gate that hangs is killed and reported as FAIL', async () => {
    const dir = sandbox({ 'lint:hang': nodeEval('setTimeout(() => {}, 60000)') });
    const started = Date.now();
    const r = await inProcess(dir, { timeoutMs: 500 });
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /FAIL {2}lint:hang .*timed out/);
    assert.ok(Date.now() - started < 20_000, 'the timeout must not wait for the gate');
});

test('a slow gate is named in the summary, so a new lint:* script cannot quietly make the run slow', async () => {
    const dir = sandbox({ 'lint:slow': nodeEval('setTimeout(() => {}, 400)'), 'lint:quick': nodeEval('0') });
    const r = await inProcess(dir, { slowMs: 200 });
    assert.strictEqual(r.code, 0, 'slow is not failed');
    assert.match(r.out, /Slow: lint:slow \(\d+\.\d s\)\. .*belongs in DENYLIST/);
    assert.doesNotMatch(r.out, /Slow: .*lint:quick/);
    assert.doesNotMatch((await inProcess(dir)).out, /Slow:/, 'nothing is named under the default threshold');
});

test('the branch gates compare against the merge-base, and skip without origin/main', () => {
    const fakeGit = (sha) => (_root, args) => (args[0] === 'rev-parse' ? (sha ? 'x' : null) : sha);
    const [guard, scan] = branchGates('/repo', fakeGit('abc123'));
    assert.strictEqual(guard.command, 'node scripts/i18n-key-guard.mjs --base abc123');
    assert.strictEqual(scan.command, './scripts/scan-secrets.sh --range abc123..HEAD');
    assert.ok(scan.bash && !guard.bash && !guard.skip && !scan.skip);

    for (const g of branchGates('/repo', fakeGit(null))) assert.match(g.skip, /origin\/main does not resolve/);
});

test('verdicts: no gitleaks is SKIP, a finding is FAIL, an unfinished run is never PASS', () => {
    const [, scan] = branchGates('/repo', () => 'abc123');
    const run = (fields) => ({ code: null, signal: null, timedOut: false, output: '', ...fields });
    assert.strictEqual(verdict(scan, run({ code: 2, output: '✗ --range needs gitleaks; the regex fallback only reads the tree' })).status, 'SKIP');
    assert.strictEqual(verdict(scan, run({ code: 1, output: 'gitleaks found potential secrets' })).status, 'FAIL');
    assert.strictEqual(verdict(scan, run({ code: 2, output: 'a revision is not in this clone' })).status, 'FAIL');
    assert.strictEqual(verdict(scan, run({ code: 0 })).status, 'PASS');
    assert.strictEqual(verdict(scan, run({ timedOut: true })).status, 'FAIL');
    assert.strictEqual(verdict(scan, run({ signal: 'SIGKILL' })).status, 'FAIL');
    assert.strictEqual(verdict(scan, run({ error: new Error('spawn ENOENT') })).status, 'FAIL');
});
