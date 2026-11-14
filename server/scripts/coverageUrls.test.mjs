// @typecheck strict
/**
 * The coverage of a `.mts` file that a test loads with `require()` must
 * survive c8's `all: true`: every executed line counted, and the file not
 * flagged as "no data" (the flag is what made the shard merge drop its hits).
 * The first half runs the real thing (node, a V8 dump, c8) both ways, so the
 * test stops failing-first only if node or c8 change what they do.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { normalizeCoverageDir, normalizeScriptUrls } from './coverageUrls.mjs';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const C8 = path.join(SERVER_DIR, 'node_modules', 'c8', 'bin', 'c8.js');

const LIB = [
    '// a comment on line 1',
    'type Pair = { a: number; b: number };',
    'const OFFSET: number = 1;',
    'export function used(p: Pair): number { return p.a + p.b + OFFSET; }',
    'export function unused(p: Pair): number {',
    '    return p.a - p.b;',
    '}',
    '',
].join('\n');

/** Run a script that requires lib.mts under V8 coverage; returns the sandbox. */
function coveredRun() {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-urls-')));
    fs.writeFileSync(path.join(dir, 'lib.mts'), LIB);
    const libPath = JSON.stringify(path.join(dir, 'lib.mts'));
    fs.writeFileSync(path.join(dir, 'main.cjs'), `const lib = require(${libPath});\nif (lib.used({ a: 1, b: 2 }) !== 4) process.exit(1);\n`);
    const v8 = path.join(dir, 'v8');
    const r = spawnSync(process.execPath, [path.join(dir, 'main.cjs')], { cwd: dir, env: { ...process.env, NODE_V8_COVERAGE: v8 }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return { dir, v8 };
}

/**
 * c8's istanbul entry for lib.mts, with `all: true` like .c8rc.json.
 * @param {string} dir
 * @param {string} v8
 * @param {string} out
 */
function report(dir, v8, out) {
    const r = spawnSync(process.execPath, [C8, 'report', '--all', '--src', '.', '--extension', '.mts', '--include', '**/*.mts', '--temp-directory', v8, '--reporter', 'json', '--reports-dir', path.join(dir, out)], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const final = JSON.parse(fs.readFileSync(path.join(dir, out, 'coverage-final.json'), 'utf8'));
    const entry = final[path.join(dir, 'lib.mts')];
    assert.ok(entry, 'lib.mts is in the report');
    const uncovered = Object.keys(entry.s).filter((i) => entry.s[i] === 0).map((i) => entry.statementMap[i].start.line);
    return { all: entry.all === true, uncovered };
}

test('a required .mts file: its executed lines count and it is not reported as "no data"', () => {
    const { dir, v8 } = coveredRun();
    try {
        // As node writes the dump: the bare path makes c8 lay an empty report over the real one.
        const before = report(dir, v8, 'before');
        assert.equal(before.all, true, 'if this fails, node or c8 no longer need the rewrite');
        assert.ok(before.uncovered.includes(1) && before.uncovered.includes(3), `module-level lines read as uncovered: ${before.uncovered}`);

        assert.ok(normalizeCoverageDir(v8) >= 1);
        const after = report(dir, v8, 'after');
        assert.equal(after.all, false);
        // Only the body of the function nobody called is left (its first line shares the module-level range).
        assert.deepEqual(after.uncovered, [6, 7]);
        // Nothing left to rewrite on a second pass.
        assert.equal(normalizeCoverageDir(v8), 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('only absolute paths are rewritten; file:// and node: URLs and a dump without scripts are left alone', () => {
    const abs = path.join(os.tmpdir(), 'x y', 'a.mts');
    const dump = { result: [{ url: abs }, { url: 'file:///srv/b.js' }, { url: 'node:internal/modules/cjs/loader' }, { url: '' }] };
    assert.equal(normalizeScriptUrls(dump), 1);
    assert.deepEqual(dump.result.map((r) => r.url), [pathToFileURL(abs).href, 'file:///srv/b.js', 'node:internal/modules/cjs/loader', '']);
    assert.equal(normalizeScriptUrls({}), 0);
});

test('a file that is not JSON is skipped, not fatal', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-urls-'));
    try {
        fs.writeFileSync(path.join(dir, 'coverage-1.json'), '{ truncated');
        fs.writeFileSync(path.join(dir, 'coverage-2.json'), JSON.stringify({ result: [{ url: path.join(dir, 'a.mts') }] }));
        assert.equal(normalizeCoverageDir(dir), 1);
        assert.equal(fs.readFileSync(path.join(dir, 'coverage-1.json'), 'utf8'), '{ truncated');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
