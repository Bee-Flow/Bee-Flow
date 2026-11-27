// @typecheck strict
'use strict';
/**
 * testUtils/compositionText.js: index.js first, then the composition files of
 * every root in name order; today (no composition file) exactly index.js.
 *
 * Run: cd server && node --test testUtils/compositionText.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { compositionText, compositionFiles } = require('./compositionText');

test('today the composition text is index.js', () => {
    assert.equal(compositionText(), fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8'));
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
