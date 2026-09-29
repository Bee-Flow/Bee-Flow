import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';

function tree(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-point-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const script = path.join(dir, 'gate.mjs');
    fs.writeFileSync(script, '');
    return { dir, script, url: pathToFileURL(fs.realpathSync(script)).href };
}

test('true for the script itself, by relative or absolute path', (t) => {
    const { dir, script, url } = tree(t);
    assert.strictEqual(isEntryPoint(url, script), true);
    assert.strictEqual(isEntryPoint(url, path.relative(process.cwd(), script)), true);
    assert.strictEqual(isEntryPoint(url, path.join(dir, '.', 'gate.mjs')), true);
});

test('true when node was started through a symlinked directory', (t) => {
    const { dir, url } = tree(t);
    const link = `${dir}-link`;
    try {
        fs.symlinkSync(dir, link, 'dir');
    } catch (e) {
        t.skip(`cannot create a symlink here (${e.code})`);
        return;
    }
    t.after(() => fs.rmSync(link, { force: true }));
    assert.strictEqual(isEntryPoint(url, path.join(link, 'gate.mjs')), true);
});

test('false when imported: another script, a missing argv[1], a path that does not exist', (t) => {
    const { dir, url } = tree(t);
    fs.writeFileSync(path.join(dir, 'runner.mjs'), '');
    assert.strictEqual(isEntryPoint(url, path.join(dir, 'runner.mjs')), false);
    assert.strictEqual(isEntryPoint(url, undefined), false);
    assert.strictEqual(isEntryPoint(url, path.join(dir, 'nope.mjs')), false);
});
