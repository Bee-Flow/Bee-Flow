/**
 * The module boundary ratchet on small temp-dir fixtures (each of the four rules, the budget
 * and its --update semantics), and the committed budget against the real tree.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUDGET_REL, analyze, counts, main, nextBudget, scanLookups } from './module-boundary.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = { server: { coreDir: 'server', moduleDir: 'server' } };

/**
 * A throwaway checkout (not a git work tree: the file list comes from a walk).
 * @param {Record<string, object>} modules the `modules` of module-map.json
 * @param {Record<string, string>} files repo-relative path -> content
 */
function fixture(modules, files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'module-boundary-'));
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.writeFileSync(path.join(dir, 'scripts', 'module-map.json'), JSON.stringify({ packages: PACKAGES, modules, core: {} }));
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
    }
    test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

const mod = (server, extra = {}) => ({ requires: [], uses: [], server, ...extra });
const MODULES = { a: mod(['a/**']), b: mod(['b/**']) };
const FILES = {
    'server/core/x.js': [
        "const one = require('../a/one');",
        "const { featureModule, optionalFeatureModule } = require('./featureModules');",
        "const two = () => featureModule('a/two');",
        "const three = () => optionalFeatureModule('a/three');",
        "// featureModule('a/two') in a comment is not a call",
        "const own = () => featureModule('core/featureModules');",
        '',
    ].join('\n'),
    'server/core/featureModules.js': 'module.exports = {};\n',
    'server/core/x.test.js': "require('../a/one');\n",
    'server/a/one.js': "module.exports = require('../b/y.js');\n",
    'server/a/two.js': 'module.exports = 2;\n',
    'server/a/three.js': 'module.exports = 3;\n',
    'server/b/y.js': 'module.exports = 1;\n',
};

/** Run main() with console captured. */
function run(dir, argv = []) {
    const out = [];
    const orig = { log: console.log, error: console.error };
    console.log = (...a) => out.push(a.join(' '));
    console.error = (...a) => out.push(a.join(' '));
    try {
        return { code: main(argv, { repoRoot: dir }), text: out.join('\n') };
    } finally {
        Object.assign(console, orig);
    }
}

const writeBudget = (dir, budget) => fs.writeFileSync(path.join(dir, BUDGET_REL), JSON.stringify(budget));
const readBudget = (dir) => JSON.parse(fs.readFileSync(path.join(dir, BUDGET_REL), 'utf8'));

test('scanLookups: literal featureModule() calls only, with their line', () => {
    const src = "a();\nfeatureModule('x/y');\noptionalFeatureModule('x/z');\n/* featureModule('x/c') */ m.featureModule(\"x/w\");\nfeatureModule(name);\nfeatureModule('x/q' + s);\n";
    assert.deepEqual(scanLookups(src), [{ name: 'x/y', line: 2 }, { name: 'x/w', line: 4 }]);
});

test('rule 1 and 2: core edges and core lookups per module, tests and optional lookups left out', () => {
    const analysis = analyze(fixture(MODULES, FILES));
    assert.deepEqual(analysis.coreEdges.a.map((h) => `${h.from}:${h.line} -> ${h.to}`), ['core/x.js:1 -> a/one.js']);
    assert.deepEqual(analysis.coreLookups.a.map((h) => `${h.from}:${h.line} -> ${h.to}`), ['core/x.js:3 -> a/two.js']);
    assert.deepEqual(counts(analysis), { coreEdges: { a: 1 }, coreLookups: { a: 1 } });
});

test('no budget file: the first run seeds it with the measurement', () => {
    const dir = fixture({ ...MODULES, a: mod(['a/**'], { uses: ['b'] }) }, FILES);
    assert.equal(run(dir).code, 0);
    assert.deepEqual({ coreEdges: readBudget(dir).coreEdges, coreLookups: readBudget(dir).coreLookups }, { coreEdges: { a: 1 }, coreLookups: { a: 1 } });
    const again = run(dir);
    assert.equal(again.code, 0);
    assert.match(again.text, /➖ server: 1 core -> module import edges, at budget/);
});

test('rule 1: over budget fails and names every edge of that module with file:line', () => {
    const dir = fixture({ ...MODULES, a: mod(['a/**'], { uses: ['b'] }) }, FILES);
    writeBudget(dir, { coreEdges: {}, coreLookups: { a: 1 } });
    const { code, text } = run(dir);
    assert.equal(code, 1);
    assert.match(text, /1 core -> module import edges into a, budget is 0 \(1 over\)/);
    assert.match(text, /core\/x\.js:1 -> a\/one\.js/);
});

test('rule 2: a lookup over budget fails on its own section', () => {
    const dir = fixture({ ...MODULES, a: mod(['a/**'], { uses: ['b'] }) }, FILES);
    writeBudget(dir, { coreEdges: { a: 1 }, coreLookups: {} });
    const { code, text } = run(dir);
    assert.equal(code, 1);
    assert.match(text, /1 core featureModule\(\) lookups of module files into a, budget is 0 \(1 over\)/);
    assert.match(text, /core\/x\.js:3 -> a\/two\.js/);
});

test('under budget passes and says --update would lower it', () => {
    const dir = fixture({ ...MODULES, a: mod(['a/**'], { uses: ['b'] }) }, FILES);
    writeBudget(dir, { coreEdges: { a: 3 }, coreLookups: { a: 1 } });
    const { code, text } = run(dir);
    assert.equal(code, 0);
    assert.match(text, /✅ server: 1 core -> module import edges, under the budget of 3/);
});

test('rule 3: a module -> module edge needs the target in requires or uses', () => {
    const undeclared = analyze(fixture(MODULES, FILES)).undeclared;
    assert.equal(undeclared.length, 1);
    assert.match(undeclared[0], /^a\/one\.js:1 -> b\/y\.js {2}\(a -> b/);
    assert.deepEqual(analyze(fixture({ ...MODULES, a: mod(['a/**'], { requires: ['b'] }) }, FILES)).undeclared, []);
    const dir = fixture(MODULES, FILES);
    writeBudget(dir, { coreEdges: { a: 1 }, coreLookups: { a: 1 } });
    const { code, text } = run(dir);
    assert.equal(code, 1);
    assert.match(text, /module -> module import edge\(s\) not declared/);
});

test('rule 3: a cycle in requires fails', () => {
    const dir = fixture({ a: mod(['a/**'], { requires: ['b'] }), b: mod(['b/**'], { requires: ['a'] }) }, FILES);
    assert.deepEqual(analyze(dir).cycle, ['a', 'b', 'a']);
    writeBudget(dir, { coreEdges: { a: 1 }, coreLookups: { a: 1 } });
    assert.match(run(dir).text, /requires has a cycle: a -> b -> a/);
});

test('rule 4: with modules/<id>/server present, no file of <id> stays in server/ and no stranger sits there', () => {
    const modules = { ...MODULES, a: mod(['a/**'], { uses: ['b'] }) };
    const { 'server/a/one.js': one, ...rest } = FILES;
    const dir = fixture(modules, { ...rest, 'modules/a/server/a/one.js': one, 'modules/a/server/core/stray.js': '1;\n' });
    const location = analyze(dir).location;
    assert.deepEqual(location.sort(), [
        'modules/a/server/core/stray.js: the map gives it to core; move it back or change the globs',
        'server/a/three.js: owned by a, which has modules/a/server; move it there (git mv, same tree path)',
        'server/a/two.js: owned by a, which has modules/a/server; move it there (git mv, same tree path)',
    ]);
    assert.deepEqual(analyze(fixture(modules, FILES)).location, [], 'vacuous while no module directory exists');
});

test('nextBudget: --update lowers, never raises, and drops the modules that reached zero', () => {
    const existing = { coreEdges: { a: 5, b: 2, c: 1 }, coreLookups: { a: 1 } };
    const next = nextBudget(existing, { coreEdges: { a: 3, b: 4, d: 2 }, coreLookups: {} });
    assert.deepEqual(next.coreEdges, { a: 3, b: 2 });
    assert.deepEqual(next.coreLookups, {});
    assert.deepEqual(nextBudget(null, { coreEdges: { a: 3 }, coreLookups: { b: 1 } }).coreLookups, { b: 1 });
});

test('--update through main writes the lowered budget', () => {
    const dir = fixture({ ...MODULES, a: mod(['a/**'], { uses: ['b'] }) }, FILES);
    writeBudget(dir, { coreEdges: { a: 4, b: 1 }, coreLookups: { a: 0 } });
    assert.equal(run(dir, ['--update']).code, 0);
    assert.deepEqual(readBudget(dir).coreEdges, { a: 1 });
    assert.deepEqual(readBudget(dir).coreLookups, {});
});

test('the committed budget covers today\'s tree, and the tree has no undeclared edge, cycle or misplaced file', () => {
    const budget = JSON.parse(fs.readFileSync(path.join(REPO, BUDGET_REL), 'utf8'));
    const analysis = analyze(REPO);
    const measured = counts(analysis);
    for (const section of ['coreEdges', 'coreLookups']) {
        for (const [id, n] of Object.entries(measured[section])) assert.ok(n <= (budget[section][id] ?? 0), `${section}.${id}: measured ${n}, budget ${budget[section][id] ?? 0}`);
    }
    assert.deepEqual(analysis.undeclared, []);
    assert.equal(analysis.cycle, null);
    assert.deepEqual(analysis.location, []);
});
