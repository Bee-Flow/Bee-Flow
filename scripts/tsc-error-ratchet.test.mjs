import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { countErrors, byCode } from './tsc-error-ratchet.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tsc-error-ratchet.mjs');

test('countErrors counts diagnostics, not their continuation lines', () => {
    const out = [
        "src/a.js(1,1): error TS7006: Parameter 'x' implicitly has an 'any' type.",
        "src/b.js(2,2): error TS2339: Property 'p' does not exist on type 'X'.",
        "  Property 'p' does not exist on type 'Y'.",
        'Found 2 errors.',
    ].join('\n');
    assert.strictEqual(countErrors(out), 2);
    assert.deepStrictEqual(byCode(out), { TS7006: 1, TS2339: 1 });
    assert.strictEqual(countErrors(''), 0);
});

// A stand-in tsc that prints N errors and exits 2, so the gate runs without TypeScript installed.
function sandbox(errors, budget) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsc-ratchet-'));
    fs.mkdirSync(path.join(dir, 'pkg'));
    fs.writeFileSync(path.join(dir, 'pkg/tsconfig.strict.json'), '{}');
    fs.writeFileSync(path.join(dir, 'fake-tsc.js'), `for (let i = 0; i < ${errors}; i++) console.log('src/f.js(' + i + ',1): error TS7006: x');\nprocess.exit(${errors ? 2 : 0});\n`);
    if (budget !== null) fs.writeFileSync(path.join(dir, 'pkg/.tsc-strict-ratchet.json'), JSON.stringify({ errors: budget }));
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts/tsc-error-ratchet.mjs'));
    return dir;
}
function run(dir, extra = []) {
    try {
        const stdout = execFileSync(process.execPath, [path.join(dir, 'scripts/tsc-error-ratchet.mjs'), 'pkg', '--tsc', path.join(dir, 'fake-tsc.js'), ...extra], { cwd: dir, encoding: 'utf8' });
        return { code: 0, stdout, stderr: '' };
    } catch (e) {
        return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
    }
}
const budgetOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'pkg/.tsc-strict-ratchet.json'), 'utf8')).errors;

test('more errors than the budget fails', () => {
    const r = run(sandbox(5, 3));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /5 strict type errors, budget 3/);
});

test('at budget passes, under budget passes and says to lower it', () => {
    assert.strictEqual(run(sandbox(3, 3)).code, 0);
    const r = run(sandbox(2, 3));
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /lower it/);
});

test('--update lowers the budget and never raises it', () => {
    const down = sandbox(2, 3);
    run(down, ['--update']);
    assert.strictEqual(budgetOf(down), 2);
    const up = sandbox(9, 3);
    run(up, ['--update']);
    assert.strictEqual(budgetOf(up), 3);
});

test('the first run writes the budget', () => {
    const dir = sandbox(4, null);
    assert.strictEqual(run(dir).code, 0);
    assert.strictEqual(budgetOf(dir), 4);
});

test('a missing compiler is a usage error, never a pass', () => {
    const dir = sandbox(0, 1);
    try {
        execFileSync(process.execPath, [path.join(dir, 'scripts/tsc-error-ratchet.mjs'), 'pkg'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
        assert.fail('should exit 2');
    } catch (e) {
        assert.strictEqual(e.status, 2);
    }
});
