// @typecheck strict
'use strict';
/**
 * testUtils/compositionText.js: index.js first, then the composition files of
 * every root in name order.
 *
 * Run: cd server && node --test testUtils/compositionText.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { compositionText, compositionFiles } = require('./compositionText');

test('on the real tree: index.js first, then every composition file, whole', () => {
    const text = compositionText();
    const index = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    assert.ok(text.startsWith(index), 'index.js comes first');
    const files = compositionFiles();
    assert.ok(files.some((f) => path.basename(f) === 'learning.js'), 'the compositions of the tree are found');
    for (const file of files) assert.ok(text.includes(fs.readFileSync(file, 'utf8')), `${path.basename(file)} is part of the text`);
    assert.equal(compositionText({ list: () => [] }), index, 'without composition files it is index.js alone');
});

test('composition files follow index.js in name order; tests and non-code files are left out', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-composition-text-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const name of ['b.js', 'a.mts', 'a.test.js', 'a.manifest.json']) fs.writeFileSync(path.join(dir, name), `// ${name}\n`);
    const list = () => fs.readdirSync(dir).sort().map((name) => ({ name, abs: path.join(dir, name) }));
    assert.deepEqual(compositionFiles(list).map((f) => path.basename(f)), ['a.mts', 'b.js']);
    const text = compositionText({ list, read: (file) => (file.endsWith('index.js') ? 'INDEX' : fs.readFileSync(file, 'utf8').trim()) });
    assert.equal(text, 'INDEX\n// a.mts\n// b.js');
});
