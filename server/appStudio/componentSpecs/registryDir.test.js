/**
 * componentSpecs/registryDir.js: the file-per-item registries are read in name order, over every
 * root of the tree (utils/treeDir.js). With one root that is the plain sorted read it always was.
 *
 * Run: cd server && node --test appStudio/componentSpecs/registryDir.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listRegistryFiles } = require('./registryDir');

test('a registry directory of the tree lists its .js items by name, tests left out', () => {
    const dir = path.join(__dirname, 'types');
    const want = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js')).sort()
        .map((f) => ({ name: f.slice(0, -'.js'.length), file: path.join(dir, f) }));
    assert.ok(want.length > 0);
    assert.deepStrictEqual(listRegistryFiles(dir), want);
});

test('a missing directory is an empty registry, and a badly named item fails the load', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-dir-'));
    try {
        assert.deepStrictEqual(listRegistryFiles(path.join(dir, 'none')), []);
        fs.writeFileSync(path.join(dir, 'b_item.js'), '');
        fs.writeFileSync(path.join(dir, 'a_item.js'), '');
        fs.writeFileSync(path.join(dir, 'a_item.test.js'), '');
        assert.deepStrictEqual(listRegistryFiles(dir).map((e) => e.name), ['a_item', 'b_item']);
        fs.writeFileSync(path.join(dir, 'Bad-Name.js'), '');
        assert.throws(() => listRegistryFiles(dir), /lower_snake_case/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
