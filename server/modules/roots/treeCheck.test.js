/**
 * modules/roots/treeCheck.cjs: every tree path lives in exactly one root, and a file `x.js`
 * does not shadow a directory `x/` of another root. One small fixture per case, each checked
 * in a child process (testUtils/moduleRootsFixture.testkit.js).
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { buildFixture, runProbe } = require('../../testUtils/moduleRootsFixture.testkit');

const M1 = 'modules/m1/server';
const M2 = 'modules/m2/server';

const CASES = {
    clean: {
        'core/lib/a.js': '',
        [`${M1}/lib/b.js`]: '',
        [`${M2}/other/c.js`]: '',
    },
    sameTreePath: {
        'core/lib/a.js': '',
        [`${M1}/lib/a.js`]: '',
        [`${M2}/lib/a.js`]: '',
    },
    fileNextToDirectory: {
        // m1's thing.js against m2's thing/index.js, and the core's lone.js against m1's lone/index.js
        [`${M1}/thing.js`]: '',
        [`${M2}/thing/index.js`]: '',
        'core/deep/lone.js': '',
        [`${M1}/deep/lone/index.js`]: '',
    },
    controlFiles: {
        'core/eslint.config.js': '',
        'core/eslint-suppressions.json': '{}',
        'core/node_modules/pkg/index.js': '',
        [`${M1}/eslint.config.js`]: '',
        [`${M1}/eslint-suppressions.json`]: '{}',
        [`${M1}/node_modules/pkg/index.js`]: '',
        [`${M2}/eslint.config.js`]: '',
    },
};

/** @type {Record<string, ReturnType<typeof buildFixture>>} */
const fixtures = {};
before(() => {
    for (const [name, files] of Object.entries(CASES)) fixtures[name] = buildFixture(files);
});
after(() => {
    for (const fx of Object.values(fixtures)) fx.remove();
});

/** @param {string} name */
function duplicates(name) {
    const r = runProbe(fixtures[name], 'duplicates', 'out(require(ROOTS_LIB).duplicateTreePaths());');
    assert.strictEqual(r.status, 0, r.stderr);
    return r.value;
}

test('a clean tree has no duplicates', () => {
    assert.deepStrictEqual(duplicates('clean'), []);
});

test('the same tree path in two module roots and the core is reported from each module root', () => {
    assert.deepStrictEqual(duplicates('sameTreePath'), [
        { treePath: 'lib/a.js', roots: ['m1', null, 'm2'] },
        { treePath: 'lib/a.js', roots: ['m2', null, 'm1'] },
    ]);
});

test('x.js in one root next to x/index.js in another is reported, also when the file is in the core', () => {
    assert.deepStrictEqual(duplicates('fileNextToDirectory'), [
        { treePath: 'deep/lone.js', roots: [null, 'm1'] },
        { treePath: 'thing.js', roots: ['m1', 'm2'] },
    ]);
});

test('per-root control files (node_modules, eslint.config.js, eslint-suppressions.json) are not reported', () => {
    assert.deepStrictEqual(duplicates('controlFiles'), []);
});
