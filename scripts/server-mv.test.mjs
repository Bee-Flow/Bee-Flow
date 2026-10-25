/**
 * server-mv: a move has to rewrite every importer (also lazy requires, require.resolve and
 * require.cache stub keys, rooted mock paths), re-base the moved file's own requires, leave
 * no shim, and pass the move-equivalence gate.
 */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkEquivalent, move } from './server-mv.mjs';

function fixture(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-mv-'));
    for (const [name, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), text);
    }
    return dir;
}
const read = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8');
const exists = (dir, name) => fs.existsSync(path.join(dir, name));
const run = (dir, from, to, opts = {}) => move([[path.join(dir, from), path.join(dir, to)]], { root: dir, git: false, ...opts });

const FILES = {
    'server/migrations/ddl.js': "const db = require('../db');\nconst u = require('./util');\nmodule.exports = { db, u };\n",
    'server/migrations/util.js': 'module.exports = {};\n',
    'server/db.js': 'module.exports = {};\n',
    'server/stores/a.js': "const d = require('../migrations/ddl');\nfunction f() { return require('../migrations/ddl.js'); }\n/** @type {import('../migrations/ddl').X} */\nmodule.exports = { d, f };\n",
    'server/stores/a.test.js': "const path = require('path');\nconst SERVER = path.join(__dirname, '..');\nconst id = require.resolve('../migrations/ddl');\nrequire.cache[id] = { exports: {} };\nconst { mockModule } = require('../testUtils/moduleMock');\nmockModule(path.join(SERVER, 'migrations/ddl'), {});\n",
    'server/migrations/ddl.test.js': "require('./ddl');\n",
    'server/index.js': "require('./migrations/ddl');\nrequire('./stores/a');\n",
    'mobile/src/contract.test.ts': "const p = 'server/migrations/ddl.js';\n",
    'server/.file-budget.json': '{"files":{"migrations/ddl.js":500}}\n',
};

test('moves the file, rewrites importers, tests, stub keys and rooted mocks, and re-bases its own requires', () => {
    const dir = fixture(FILES);
    const report = run(dir, 'server/migrations/ddl.js', 'server/stores/ddl.js');
    assert.ok(!exists(dir, 'server/migrations/ddl.js'), 'no shim left behind');
    assert.ok(exists(dir, 'server/stores/ddl.js'));
    assert.ok(exists(dir, 'server/stores/ddl.test.js'), 'the colocated test moves along');
    assert.strictEqual(read(dir, 'server/stores/ddl.js'), "const db = require('../db');\nconst u = require('../migrations/util');\nmodule.exports = { db, u };\n");
    assert.strictEqual(read(dir, 'server/stores/ddl.test.js'), "require('./ddl');\n");
    const a = read(dir, 'server/stores/a.js');
    assert.match(a, /require\('\.\/ddl'\)/);
    assert.match(a, /return require\('\.\/ddl\.js'\)/, 'lazy require keeps its extension style');
    assert.match(a, /import\('\.\/ddl'\)/, 'JSDoc import types follow');
    const t = read(dir, 'server/stores/a.test.js');
    assert.match(t, /require\.resolve\('\.\/ddl'\)/);
    assert.match(t, /path\.join\(SERVER, 'stores\/ddl'\)/, 'rooted mock path follows');
    assert.match(read(dir, 'server/index.js'), /require\('\.\/stores\/ddl'\)/);
    assert.match(read(dir, 'mobile/src/contract.test.ts'), /server\/stores\/ddl\.js/);
    assert.match(read(dir, 'server/.file-budget.json'), /"stores\/ddl\.js":500/);
    assert.ok(report.rewritten.length >= 4);
});

test('--dry writes nothing', () => {
    const dir = fixture(FILES);
    const report = run(dir, 'server/migrations/ddl.js', 'server/stores/ddl.js', { dry: true });
    assert.ok(exists(dir, 'server/migrations/ddl.js'));
    assert.strictEqual(report.moved.length, 2);
});

test('moving several files in one call keeps their mutual requires', () => {
    const dir = fixture(FILES);
    move([
        [path.join(dir, 'server/migrations/ddl.js'), path.join(dir, 'server/stores/ddl.js')],
        [path.join(dir, 'server/migrations/util.js'), path.join(dir, 'server/stores/util.js')],
    ], { root: dir, git: false });
    assert.match(read(dir, 'server/stores/ddl.js'), /require\('\.\/util'\)/);
});

test('refuses an existing target and a target outside server/', () => {
    const dir = fixture({ ...FILES, 'server/stores/ddl.js': '' });
    assert.throws(() => run(dir, 'server/migrations/ddl.js', 'server/stores/ddl.js'), /target exists/);
    assert.throws(() => run(dir, 'server/migrations/ddl.js', 'elsewhere/ddl.js'), /outside server/);
});

test('the equivalence gate accepts changed specifiers only', () => {
    assert.strictEqual(checkEquivalent("const a = require('../x');\nf();\n", "const a = require('./x');\nf();\n"), null);
    assert.match(checkEquivalent("const a = require('../x');\nf();\n", "const a = require('./x');\ng();\n"), /differs/);
});
