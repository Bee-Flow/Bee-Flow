/**
 * The ratchet is a gate, so the thing worth testing is that it REFUSES: a tree
 * with more untyped files than the budget, and an --update that would raise it.
 *
 * Sandbox style is the one scripts/eslint-budget.test.mjs uses: a throwaway
 * repo under os.tmpdir(), the real script copied in, a src/ tree built from
 * whatever file names the case asks for.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'ts-ratchet.mjs');

function sandbox({ files = [], budget = null } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-ratchet-'));
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts/ts-ratchet.mjs'));
    fs.mkdirSync(path.join(dir, 'pkg', 'src'), { recursive: true });
    for (const rel of files) {
        const full = path.join(dir, 'pkg', 'src', rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, '');
    }
    if (budget !== null) {
        fs.writeFileSync(path.join(dir, 'pkg', '.ts-ratchet.json'), JSON.stringify({ jsFiles: budget }));
    }
    return dir;
}

function run(dir, extra = []) {
    try {
        const stdout = execFileSync(process.execPath, [path.join(dir, 'scripts/ts-ratchet.mjs'), 'pkg', ...extra], {
            cwd: dir,
            encoding: 'utf8',
        });
        return { code: 0, stdout, stderr: '' };
    } catch (e) {
        return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
    }
}

const budgetOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'pkg/.ts-ratchet.json'), 'utf8')).jsFiles;

test('more untyped files than the budget fails', () => {
    const r = run(sandbox({ files: ['a.js', 'b.jsx', 'c/d.js'], budget: 2 }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /3 \.js\/\.jsx files under src, budget is 2/);
});

test('at or under the budget passes', () => {
    assert.strictEqual(run(sandbox({ files: ['a.js', 'b.js'], budget: 2 })).code, 0);
    const r = run(sandbox({ files: ['a.js'], budget: 2 }));
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /under the budget of 2/);
});

test('TypeScript and other files are not counted', () => {
    const dir = sandbox({ files: ['a.ts', 'b.tsx', 'c.json', 'd.css', 'e.js'], budget: 1 });
    const r = run(dir);
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /1 \.js\/\.jsx files under src, at budget/);
});

test('build output and vendored trees cannot inflate the count', () => {
    const dir = sandbox({ files: ['a.js', 'node_modules/dep/index.js', 'dist/bundle.js', 'coverage/x.js'], budget: 1 });
    assert.strictEqual(run(dir).code, 0);
});

test('--update lowers the budget and never raises it', () => {
    const lower = sandbox({ files: ['a.js'], budget: 4 });
    assert.strictEqual(run(lower, ['--update']).code, 0);
    assert.strictEqual(budgetOf(lower), 1);

    const higher = sandbox({ files: ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'], budget: 4 });
    assert.strictEqual(run(higher, ['--update']).code, 0);
    assert.strictEqual(budgetOf(higher), 4, 'an --update must not become a quiet way to raise the budget');
});

test('a missing budget file is written from the first measurement', () => {
    const dir = sandbox({ files: ['a.js', 'b.jsx'] });
    assert.strictEqual(run(dir).code, 0);
    assert.strictEqual(budgetOf(dir), 2);
});

test('--list names the files still counted', () => {
    const r = run(sandbox({ files: ['a.js', 'deep/b.jsx', 'typed.ts'], budget: 2 }), ['--list']);
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /src\/a\.js/);
    assert.match(r.stdout, /src\/deep\/b\.jsx/);
    assert.doesNotMatch(r.stdout, /typed\.ts/);
});

test('a package without a src directory is a usage error, not a pass', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-ratchet-'));
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts/ts-ratchet.mjs'));
    const r = run(dir);
    assert.strictEqual(r.code, 2);
    assert.match(r.stderr, /not found/);
});
