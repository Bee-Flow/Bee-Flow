/**
 * gen-step-kinds: run() is a gate. --check names a stale or missing file and writes nothing,
 * write mode makes --check clean again, and the file in the repository is what the step
 * registry says today (the same comparison lint:shared-mirror runs).
 *
 * Sandbox style: a throwaway tree under os.tmpdir() and a stand-in renderer.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STEP_KINDS_OUT, run } from './gen-step-kinds.mjs';

function sandbox() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-step-kinds-'));
    const lines = [];
    const io = { root, log: (l) => lines.push(l), error: (l) => lines.push(l) };
    return { root, lines, io, file: path.join(root, STEP_KINDS_OUT) };
}

test('--check fails on a missing or stale file and writes nothing', async (t) => {
    const s = sandbox();
    t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
    assert.equal(await run({ ...s.io, check: true, render: () => 'A\n' }), 1);
    assert.equal(fs.existsSync(s.file), false);
    assert.match(s.lines.join('\n'), /out of date with the step registry.*npm run gen:shared/);

    assert.equal(await run({ ...s.io, render: () => 'A\n' }), 0);
    assert.equal(fs.readFileSync(s.file, 'utf8'), 'A\n');
    assert.equal(await run({ ...s.io, check: true, render: () => 'A\n' }), 0);

    // The registry moved on: the check names the file and leaves it alone.
    assert.equal(await run({ ...s.io, check: true, render: () => 'B\n' }), 1);
    assert.equal(fs.readFileSync(s.file, 'utf8'), 'A\n');
});

test('write mode leaves a current file untouched', async (t) => {
    const s = sandbox();
    t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
    await run({ ...s.io, render: () => 'A\n' });
    const before = fs.statSync(s.file).mtimeMs;
    assert.equal(await run({ ...s.io, render: () => 'A\n' }), 0);
    assert.equal(fs.statSync(s.file).mtimeMs, before);
    assert.match(s.lines.at(-1), /up to date/);
});

test('the file in the repository is what the registry says today', async () => {
    const lines = [];
    assert.equal(await run({ check: true, log: (l) => lines.push(l), error: (l) => lines.push(l) }), 0, lines.join('\n'));
});
