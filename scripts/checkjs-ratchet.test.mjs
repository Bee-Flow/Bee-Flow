/**
 * The checkJs ratchet points the other way from the count ratchets: its number
 * may only rise. The refusals that matter are a file losing its `// @typecheck`
 * and an --update that would lower the floor. Tests never count, being run
 * rather than type-checked.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'checkjs-ratchet.mjs');

function sandbox({ files = {}, floor = null } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkjs-ratchet-'));
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts/checkjs-ratchet.mjs'));
    fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
    for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, 'pkg', rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, 'pkg', rel), body);
    }
    if (floor !== null) fs.writeFileSync(path.join(dir, 'pkg/.checkjs-ratchet.json'), JSON.stringify({ checkedFiles: floor }));
    return dir;
}

function run(dir, extra = []) {
    try {
        const stdout = execFileSync(process.execPath, [path.join(dir, 'scripts/checkjs-ratchet.mjs'), 'pkg', ...extra], { cwd: dir, encoding: 'utf8' });
        return { code: 0, stdout, stderr: '' };
    } catch (e) {
        return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
    }
}

const floorOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'pkg/.checkjs-ratchet.json'), 'utf8')).checkedFiles;
const CHECKED = "// @typecheck\n'use strict';\nmodule.exports = 1;\n";
const PLAIN = "'use strict';\nmodule.exports = 1;\n";

test('fewer checked files than the floor fails', () => {
    const r = run(sandbox({ files: { 'a.js': CHECKED, 'b.js': PLAIN }, floor: 2 }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /1 files carry \/\/ @typecheck, the floor is 2/);
});

test('at or over the floor passes', () => {
    assert.strictEqual(run(sandbox({ files: { 'a.js': CHECKED }, floor: 1 })).code, 0);
    assert.match(run(sandbox({ files: { 'a.js': CHECKED, 'b.js': CHECKED }, floor: 1 })).stdout, /over the floor of 1/);
});

test('--update raises the floor and never lowers it', () => {
    const up = sandbox({ files: { 'a.js': CHECKED, 'b.js': CHECKED }, floor: 1 });
    run(up, ['--update']);
    assert.strictEqual(floorOf(up), 2);
    const down = sandbox({ files: { 'a.js': PLAIN }, floor: 3 });
    run(down, ['--update']);
    assert.strictEqual(floorOf(down), 3);
});

test('the directive counts after a header comment, not in the middle of a file, and never in tests', () => {
    const late = `${'// x\n'.repeat(40)}// @typecheck\n`;
    const dir = sandbox({
        files: {
            'header.js': '/**\n * Module header.\n */\n// @typecheck\n',
            'late.js': late,
            'mention.js': "// the word @typecheck in prose does not opt in\n",
            'a.test.js': CHECKED,
            'node_modules/dep/index.js': CHECKED,
        },
    });
    run(dir);
    assert.strictEqual(floorOf(dir), 1);
});

test('--list names the folders still unchecked, most first', () => {
    const r = run(sandbox({ files: { 'core/a.js': PLAIN, 'core/b.js': PLAIN, 'utils/c.js': PLAIN, 'utils/d.js': CHECKED }, floor: 1 }), ['--list']);
    assert.match(r.stdout, /2 {2}core\/\n\s+1 {2}utils\//);
});
