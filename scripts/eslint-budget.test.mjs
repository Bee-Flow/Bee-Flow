/**
 * The budget is a gate, so the thing worth testing is that it REFUSES: a
 * report above the budget, an error, and an --update that would raise it.
 *
 * Sandbox style is the one scripts/audit-ratchet.test.mjs uses: a throwaway
 * repo under os.tmpdir(), the real script copied in, a fake eslint (its
 * bin/eslint.js and package.json) that prints whatever report the case asks
 * for and writes down the arguments it was given.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { eslintEntry, eslintArgs, atLeast, CONCURRENCY_SINCE, MAX_WORKERS } from './eslint-budget.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'eslint-budget.mjs');

const report = (errors, warnings) => JSON.stringify([
    { filePath: 'a.js', errorCount: errors, warningCount: warnings, messages: [] },
    { filePath: 'b.js', errorCount: 0, warningCount: 0, messages: [] },
]);

function sandbox({ errors = 0, warnings = 0, budget = null, version = '9.39.2' } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eslint-budget-'));
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts/eslint-budget.mjs'));
    fs.copyFileSync(path.join(HERE, 'entry-point.mjs'), path.join(dir, 'scripts/entry-point.mjs'));
    const eslint = path.join(dir, 'pkg', 'node_modules', 'eslint');
    fs.mkdirSync(path.join(eslint, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(eslint, 'package.json'), JSON.stringify({ name: 'eslint', version }));
    // No shebang and no exec bit: the gate has to start it with node.
    fs.writeFileSync(path.join(eslint, 'bin', 'eslint.js'), `require('fs').writeFileSync('eslint-argv.json', JSON.stringify(process.argv.slice(2)));
process.stdout.write(${JSON.stringify(report(errors, warnings))});
process.exit(${errors > 0 ? 1 : 0});
`);
    if (budget !== null) {
        fs.writeFileSync(path.join(dir, 'pkg', '.eslint-budget.json'), JSON.stringify({ warnings: budget }));
    }
    return dir;
}

function run(dir, extra = []) {
    try {
        const stdout = execFileSync(process.execPath, [path.join(dir, 'scripts/eslint-budget.mjs'), 'pkg', ...extra], {
            cwd: dir,
            encoding: 'utf8',
        });
        return { code: 0, stdout, stderr: '' };
    } catch (e) {
        return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
    }
}

const budgetOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'pkg/.eslint-budget.json'), 'utf8')).warnings;

test('more warnings than the budget fails', () => {
    const r = run(sandbox({ warnings: 11, budget: 10 }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /11 eslint warnings, budget is 10/);
});

test('at or under the budget passes', () => {
    assert.strictEqual(run(sandbox({ warnings: 10, budget: 10 })).code, 0);
    const r = run(sandbox({ warnings: 4, budget: 10 }));
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /under the budget of 10/);
});

test('an eslint error fails regardless of the budget', () => {
    const r = run(sandbox({ errors: 1, warnings: 0, budget: 10 }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /errors are never budgeted/);
});

test('--update lowers the budget and never raises it', () => {
    const lower = sandbox({ warnings: 4, budget: 10 });
    assert.strictEqual(run(lower, ['--update']).code, 0);
    assert.strictEqual(budgetOf(lower), 4);

    const higher = sandbox({ warnings: 12, budget: 10 });
    assert.strictEqual(run(higher, ['--update']).code, 0);
    assert.strictEqual(budgetOf(higher), 10, 'an --update must not become a quiet way to raise the budget');
});

test('a missing budget file is written from the first measurement', () => {
    const dir = sandbox({ warnings: 7 });
    assert.strictEqual(run(dir).code, 0);
    assert.strictEqual(budgetOf(dir), 7);
});

test('--report counts an existing eslint json report instead of running eslint', () => {
    const dir = sandbox({ warnings: 0, budget: 3 });
    fs.writeFileSync(path.join(dir, 'r.json'), report(0, 5));
    const r = run(dir, ['--report', 'r.json']);
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /5 eslint warnings, budget is 3/);
});

const argvOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'pkg/eslint-argv.json'), 'utf8'));

test('eslint is started as node <pkg>/node_modules/eslint/bin/eslint.js, never through .bin', () => {
    // On Windows .bin holds eslint.cmd, which Node will not start without a
    // shell (EINVAL since the CVE-2024-27980 fix); the sandbox has no .bin at all.
    assert.strictEqual(eslintEntry(path.join('x', 'agent-hub')), path.join('x', 'agent-hub', 'node_modules', 'eslint', 'bin', 'eslint.js'));
    const dir = sandbox({ warnings: 2, budget: 5 });
    assert.ok(!fs.existsSync(path.join(dir, 'pkg/node_modules/.bin')));
    const r = run(dir);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.deepStrictEqual(argvOf(dir).slice(0, 3), ['.', '-f', 'json']);
});

test('a package without eslint installed is a usage error, not a pass', () => {
    const dir = sandbox({ budget: 5 });
    fs.rmSync(path.join(dir, 'pkg/node_modules'), { recursive: true });
    const r = run(dir);
    assert.strictEqual(r.code, 2);
    assert.match(r.stderr, /eslint[\\/]bin[\\/]eslint\.js not found — run npm ci in pkg first/);
});

test('--concurrency is passed only to an eslint that has it (9.34.0 and later)', () => {
    assert.strictEqual(CONCURRENCY_SINCE, '9.34.0');
    for (const v of ['9.34.0', '9.34.1', '9.39.2', '10.0.0']) {
        assert.deepStrictEqual(eslintArgs(v, 2), ['.', '-f', 'json', '--concurrency', '2'], v);
    }
    for (const v of ['9.33.9', '9.9.0', '8.57.1', null, 'not-a-version']) {
        assert.deepStrictEqual(eslintArgs(v, 2), ['.', '-f', 'json'], String(v));
    }
    assert.ok(atLeast('9.100.0', '9.34.0'), 'numeric, not string, comparison');
    assert.ok(!atLeast('9.4.0', '9.34.0'));

    const recent = sandbox({ budget: 5, version: '9.34.0' });
    run(recent);
    assert.deepStrictEqual(argvOf(recent), eslintArgs('9.34.0'), 'the gate passes what eslintArgs computes for this machine');
    const older = sandbox({ budget: 5, version: '9.33.1' });
    run(older);
    assert.deepStrictEqual(argvOf(older), ['.', '-f', 'json'], 'an older eslint rejects the flag it does not know');
});

test('the worker count is explicit, never auto: every usable CPU up to MAX_WORKERS, none on one CPU', () => {
    // eslint's `auto` is half the CPUs and one worker becomes none, so a
    // 2-vCPU CI runner would lint on a single thread: the case this exists for.
    assert.deepStrictEqual(eslintArgs('9.39.2', 1), ['.', '-f', 'json']);
    assert.deepStrictEqual(eslintArgs('9.39.2', 2).slice(3), ['--concurrency', '2']);
    assert.deepStrictEqual(eslintArgs('9.39.2', 3).slice(3), ['--concurrency', '3']);
    assert.deepStrictEqual(eslintArgs('9.39.2', 64).slice(3), ['--concurrency', String(MAX_WORKERS)]);
    assert.ok(!eslintArgs('9.39.2', 64).includes('auto'));
});
