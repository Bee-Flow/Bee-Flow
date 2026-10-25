import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { insertMarker, markerLevel, portBranch, portOne, resolveHunk, stripMarker, summarise, transplantTypedefs, typedefNames } from './port-jsdoc-branch.mjs';

test('stripMarker finds the marker within the header and remembers the line before it', () => {
    const r = stripMarker("'use strict';\n// @typecheck noImplicitAny\nconst a = 1;\n");
    assert.equal(r.text, "'use strict';\nconst a = 1;\n");
    assert.equal(r.marker, '// @typecheck noImplicitAny');
    assert.equal(r.anchor, "'use strict';");
    assert.equal(markerLevel(r.marker), 'noImplicitAny');
    assert.equal(stripMarker('const a = 1;\n').marker, null);
});

test('insertMarker goes after its anchor, else after the shebang, else first', () => {
    assert.equal(insertMarker("'use strict';\nx\n", '// @typecheck', "'use strict';"), "'use strict';\n// @typecheck\nx\n");
    assert.equal(insertMarker('#!/usr/bin/env node\nx\n', '// @typecheck', 'nope'), '#!/usr/bin/env node\n// @typecheck\nx\n');
    assert.equal(insertMarker('x\n', '// @typecheck', null), '// @typecheck\nx\n');
});

test('a marker-only difference merges clean and keeps the higher level', () => {
    const body = "'use strict';\nconst a = 1;\n";
    const r = portOne({ ours: "'use strict';\n// @typecheck\nconst a = 1;\n", base: body, theirs: "'use strict';\n// @typecheck noImplicitAny\nconst a = 1;\n" });
    assert.equal(r.outcome, 'clean');
    assert.equal(r.text, "'use strict';\n// @typecheck noImplicitAny\nconst a = 1;\n");
});

test('JSDoc added on the branch lands next to a change made on main', () => {
    const base = 'function f(a) {\n    return a;\n}\n\nfunction g(b) {\n    return b;\n}\n';
    const ours = 'function f(a) {\n    return a;\n}\n\nfunction g(b) {\n    return b + 1;\n}\n';
    const theirs = '// @typecheck\n/** @param {number} a */\nfunction f(a) {\n    return a;\n}\n\nfunction g(b) {\n    return b;\n}\n';
    const r = portOne({ ours, base, theirs });
    assert.equal(r.outcome, 'clean');
    assert.match(r.text, /@param \{number\} a/);
    assert.match(r.text, /return b \+ 1/);
    assert.match(r.text, /^\/\/ @typecheck/m);
});

test('an edit on the line next to the inserted JSDoc is not a conflict', () => {
    const base = 'function f(a) {\n    return a;\n}\n';
    const ours = 'function f(a, b) {\n    return a;\n}\n';
    const theirs = '/** @param {number} a */\nfunction f(a) {\n    return a;\n}\n';
    const r = portOne({ ours, base, theirs });
    assert.equal(r.outcome, 'clean');
    assert.equal(r.text, '/** @param {number} a */\nfunction f(a, b) {\n    return a;\n}\n');
});

test('resolveHunk: comment lines in front of or behind the base lines are added to ours', () => {
    assert.deepEqual(resolveHunk(['new();'], ['old();'], ['/** @type {X} */', 'old();']), { lines: ['/** @type {X} */', 'new();'], dropped: false });
    assert.deepEqual(resolveHunk(['new();'], ['old();'], ['old();', ' * @param {X} a']), { lines: ['new();', ' * @param {X} a'], dropped: false });
});

test('resolveHunk: type comments inside a line lose to main, code changes on both sides do not resolve', () => {
    assert.deepEqual(resolveHunk(['f((e) => fb(e));'], ['f(() => null);'], ['f(/** @returns {null} */ () => null);']), { lines: ['f((e) => fb(e));'], dropped: true });
    assert.equal(resolveHunk(['a = 2;'], ['a = 1;'], ['a = 3;']), null);
});

test('a hunk main rewrote and the branch only annotated is partial: ours wins there, the rest is ported', () => {
    const base = 'x(() => null);\n\nfunction g(b) {\n    return b;\n}\n';
    const ours = 'x((e) => fb(e));\n\nfunction g(b) {\n    return b;\n}\n';
    const theirs = 'x(/** @returns {null} */ () => null);\n\n/** @param {number} b */\nfunction g(b) {\n    return b;\n}\n';
    const r = portOne({ ours, base, theirs });
    assert.equal(r.outcome, 'partial');
    assert.equal(r.text, 'x((e) => fb(e));\n\n/** @param {number} b */\nfunction g(b) {\n    return b;\n}\n');
});

test('overlapping edits are a conflict: the working tree wins, the file is listed', () => {
    const base = 'const a = 1;\n';
    const r = portOne({ ours: 'const a = 2;\n', base, theirs: '// @typecheck\n/** @type {number} */\nconst a = 3;\n' });
    assert.equal(r.outcome, 'conflict');
    assert.equal(r.text, 'const a = 2;\n');
});

test('absent files: deleted here is gone, new on the branch is added', () => {
    assert.equal(portOne({ ours: null, base: 'x\n', theirs: 'y\n' }).outcome, 'gone');
    assert.equal(portOne({ ours: null, base: null, theirs: 'y\n' }).outcome, 'added');
    assert.equal(portOne({ ours: 'x\n', base: 'x\n', theirs: null }).outcome, 'same');
});

/** A throwaway repo: base commit, a branch with JSDoc, and main moved on. */
function fixtureRepo() {
    const dir = mkdtempSync(path.join(tmpdir(), 'port-fixture-'));
    const run = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 't@example.com');
    run('config', 'user.name', 't');
    mkdirSync(path.join(dir, 'server'));
    const w = (f, t) => writeFileSync(path.join(dir, 'server', f), t);
    w('clean.js', 'function f(a) {\n    return a;\n}\n\nmodule.exports = { f };\n');
    w('marker.js', 'const a = 1;\n');
    w('real.js', 'const a = 1;\n');
    run('add', '.');
    run('commit', '-q', '-m', 'base');
    const base = run('rev-parse', 'HEAD').trim();
    run('checkout', '-q', '-b', 'jsdoc');
    w('clean.js', '// @typecheck\n/** @param {number} a */\nfunction f(a) {\n    return a;\n}\n\nmodule.exports = { f };\n');
    w('marker.js', '// @typecheck noImplicitAny\nconst a = 1;\n');
    w('real.js', '// @typecheck\n/** @type {number} */\nconst a = 3;\n');
    w('fresh.js', '// @typecheck\nmodule.exports = 1;\n');
    run('add', '.');
    run('commit', '-q', '-m', 'jsdoc');
    run('checkout', '-q', 'main');
    w('clean.js', 'function f(a) {\n    return a;\n}\n\nfunction h() {\n    return 2;\n}\n\nmodule.exports = { f, h };\n');
    w('marker.js', '// @typecheck\nconst a = 1;\n');
    w('real.js', 'const a = 2;\n');
    run('commit', '-q', '-am', 'main moves');
    return { dir, base, branch: 'jsdoc' };
}

test('on a fixture repo: clean, marker-only, real conflict and added files', () => {
    const { dir, base, branch } = fixtureRepo();
    try {
        const dry = portBranch({ cwd: dir, branch, base, write: false });
        assert.deepEqual(summarise(dry), { clean: 2, conflict: 1, added: 1 });
        assert.equal(readFileSync(path.join(dir, 'server/marker.js'), 'utf8'), '// @typecheck\nconst a = 1;\n', 'a dry run writes nothing');

        const res = portBranch({ cwd: dir, branch, base });
        const byFile = Object.fromEntries(res.map((r) => [r.file, r.outcome]));
        assert.deepEqual(byFile, { 'server/clean.js': 'clean', 'server/marker.js': 'clean', 'server/real.js': 'conflict', 'server/fresh.js': 'added' });
        const text = (f) => readFileSync(path.join(dir, 'server', f), 'utf8');
        assert.equal(text('marker.js'), '// @typecheck noImplicitAny\nconst a = 1;\n');
        assert.match(text('clean.js'), /@param \{number\} a[\s\S]*function h/);
        assert.equal(text('real.js'), 'const a = 2;\n');
        assert.equal(text('fresh.js'), '// @typecheck\nmodule.exports = 1;\n');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a conflict file keeps main\'s code but gets the typedefs the branch declared', () => {
    const typedef = '/**\n * @typedef {object} Row\n * @property {string} id\n */';
    assert.deepEqual(typedefNames(`${typedef}\n/** @callback Done\n */`), ['Row', 'Done']);
    const base = 'const a = 1;\n';
    const r = portOne({ ours: 'const a = 2;\n', base, theirs: `// @typecheck\n${typedef}\nconst a = 3;\n` });
    assert.equal(r.outcome, 'conflict');
    assert.equal(r.text, `const a = 2;\n\n${typedef}\n`);
    assert.equal(transplantTypedefs(`${typedef}\nx\n`, typedef), `${typedef}\nx\n`, 'a name ours has is not added twice');
    assert.equal(transplantTypedefs('x\n', '/** @param {Row} a */'), 'x\n');
});
