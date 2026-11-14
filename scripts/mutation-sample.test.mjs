// Unit tests of the mutation sample: which places it changes (and which it
// leaves alone), that the same seed gives the same sample, the kill rates, and
// a real run in a throwaway package: a tested branch is killed, an untested one
// survives, and the source file is byte-for-byte what it was afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyMutant, buildSample, floorFor, idOf, journalDir, loadTs, mutantsOf, rates, missingPaths, recover, rng, runMutants, runTest, sample, shuffled, siblingTests, sourceFiles, testsFor } from './mutation-sample.mjs';

// The parser is the TypeScript API (root `typescript-api`). The workflow-policy
// job runs the scripts' tests without npm ci, so the parser cases skip there.
let ts = null;
try { ts = loadTs(); } catch { /* not installed */ }
const tsTest = ts ? test : test.skip;

const changes = (text, file = 'x.js') => mutantsOf(ts, text, file).map((m) => `${m.op}:${m.original}->${m.replacement}`);

tsTest('operators: equality, boundary, logical and arithmetic are swapped; string concatenation is left alone', () => {
    assert.deepEqual(changes('const a = b === c;'), ['equality:===->!==']);
    assert.deepEqual(changes('const a = b != c;'), ['equality:!=->==']);
    assert.deepEqual(changes('const a = b < c, d = e >= f;'), ['boundary:<-><=', 'boundary:>=->>']);
    assert.deepEqual(changes('const a = b && c || d;'), ['logical:||->&&', 'logical:&&->||']);
    assert.deepEqual(changes('const a = b + c - 1;'), ['arithmetic:-->+', 'arithmetic:+->-']);
    assert.deepEqual(changes("const a = 'x' + b; const c = `${b}` + d;"), []);
});

tsTest('conditions are negated, a negation is removed (not both for `if (!x)`), returns and booleans are flipped', () => {
    assert.deepEqual(changes('if (a) b = 1;'), ['negate-condition:a->!(a)']);
    assert.deepEqual(changes('if (!a) b = 1;'), ['remove-negation:!->']);
    assert.deepEqual(changes('const v = a ? 1 : 2;'), ['negate-condition:a->!(a)']);
    assert.deepEqual(changes('function f() { return true; }'), ['return-value:true->false']);
    assert.deepEqual(changes('function f() { return a.b; }'), ['return-value:a.b->undefined']);
    assert.deepEqual(changes('function f() { return null; }\nfunction g() { return undefined; }\nfunction h() { return; }'), []);
    assert.deepEqual(changes('const o = { secure: true };'), ['boolean-literal:true->false']);
});

tsTest('a call statement is dropped, awaited or not; logging and super() are not', () => {
    assert.deepEqual(changes('audit(user);'), ['remove-call:audit(user);->;']);
    assert.deepEqual(changes('async function f() { await store.save(x); }'), ['remove-call:await store.save(x);->;']);
    assert.deepEqual(changes("log.warn('x'); console.log(1); logger.info(2);"), []);
    assert.deepEqual(changes('class A extends B { constructor() { super(); } }'), []);
    // A call whose value is used is not a statement.
    assert.deepEqual(changes('const v = compute(x);'), []);
});

tsTest('comments, strings, imports and types are never changed; the line is 1-based', () => {
    assert.deepEqual(changes("// if (a === b) return true;\nconst s = 'a === b && !c';\nimport x from './y';\n", 'x.mjs'), []);
    assert.deepEqual(changes('type T = A extends B ? true : false;\ninterface I { ok: true }\nconst v: T | null = null;\n', 'x.mts'), []);
    const [m] = mutantsOf(ts, '\n\nconst a = b === c;\n', 'x.js');
    assert.equal(m.line, 3);
    assert.equal(applyMutant('\n\nconst a = b === c;\n', m), '\n\nconst a = b !== c;\n');
});

test('the same seed gives the same order; the sample goes round the files and respects the cap', () => {
    assert.deepEqual(shuffled([1, 2, 3, 4, 5, 6], rng(7)), shuffled([1, 2, 3, 4, 5, 6], rng(7)));
    assert.notDeepEqual(shuffled([1, 2, 3, 4, 5, 6, 7, 8], rng(7)), shuffled([1, 2, 3, 4, 5, 6, 7, 8], rng(8)));
    const files = [
        { file: 'a.js', mutants: [1, 2, 3, 4, 5].map((n) => ({ start: n, op: 'x' })) },
        { file: 'b.js', mutants: [{ start: 1, op: 'x' }] },
    ];
    const picked = sample(files, 4, 2, rng(1));
    // b has one, a is capped at two: three in total although four were asked for.
    assert.equal(picked.length, 3);
    assert.equal(picked.filter((m) => m.file === 'a.js').length, 2);
    assert.deepEqual(sample(files, 4, 2, rng(1)).map(idOf), picked.map(idOf));
    assert.equal(sample(files, 1, 5, rng(1)).length, 1);
});

test('kill rates per group: a time-out is a kill; the floor sits five points under', () => {
    const r = rates([
        { group: 'auth', verdict: 'killed' }, { group: 'auth', verdict: 'timeout' }, { group: 'auth', verdict: 'survived' }, { group: 'auth', verdict: 'killed' },
        { group: 'license', verdict: 'survived' },
    ]);
    assert.deepEqual(r.groups, [
        { group: 'auth', mutants: 4, killed: 3, survived: 1, rate: 75 },
        { group: 'license', mutants: 1, killed: 0, survived: 1, rate: 0 },
    ]);
    assert.equal(r.total.rate, 60);
    assert.equal(rates([]).total.rate, null);
    assert.equal(floorFor(72.4), 67);
    assert.equal(floorFor(3), 0);
});

/** A throwaway package: one source file, one test next to it that checks only `isAdult`. */
function sandbox() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-sample-'));
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.writeFileSync(path.join(dir, 'lib', 'age.js'), "function isAdult(age) {\n    return age >= 18;\n}\nfunction untested(a) {\n    return a === 1;\n}\nmodule.exports = { isAdult, untested };\n");
    fs.writeFileSync(path.join(dir, 'lib', 'age.test.js'), "const test = require('node:test');\nconst assert = require('node:assert');\nconst { isAdult } = require('./age');\ntest('eighteen is adult, seventeen is not', () => { assert.equal(isAdult(18), true); assert.equal(isAdult(17), false); });\n");
    fs.writeFileSync(path.join(dir, 'lib', 'age.extra.test.js'), "require('node:test')('nothing', () => {});\n");
    fs.writeFileSync(path.join(dir, 'lib', 'alone.js'), 'module.exports = (a) => a === 2;\n');
    return dir;
}

test('files and the tests next to them', () => {
    const dir = sandbox();
    try {
        assert.deepEqual(sourceFiles(dir, 'lib'), ['lib/age.js', 'lib/alone.js']);
        assert.deepEqual(sourceFiles(dir, 'lib/age.js'), ['lib/age.js']);
        assert.deepEqual(sourceFiles(dir, 'missing'), []);
        assert.deepEqual(siblingTests(dir, 'lib/age.js'), ['lib/age.extra.test.js', 'lib/age.test.js']);
        assert.deepEqual(siblingTests(dir, 'lib/alone.js'), []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

tsTest('a real run: the tested boundary is killed, the untested comparison survives, the file is restored byte for byte', async () => {
    const dir = sandbox();
    try {
        const built = buildSample(ts, dir, { groups: { lib: ['lib'] }, count: 20, seed: 1, perFile: 20 });
        // alone.js has no test next to it: named, not sampled.
        assert.deepEqual(built.skipped, [{ group: 'lib', file: 'lib/alone.js' }]);
        assert.ok(built.mutants.every((m) => m.file === 'lib/age.js' && m.group === 'lib'));
        const before = fs.readFileSync(path.join(dir, 'lib', 'age.js'));
        const results = await runMutants(dir, built.mutants, { minTimeoutMs: 60000 });
        assert.ok(fs.readFileSync(path.join(dir, 'lib', 'age.js')).equals(before));
        const verdict = (op, original) => results.find((r) => r.op === op && r.original === original)?.verdict;
        assert.equal(verdict('boundary', '>='), 'killed');
        assert.equal(verdict('return-value', 'age >= 18'), 'killed');
        assert.equal(verdict('equality', '==='), 'survived');
        assert.equal(verdict('return-value', 'a === 1'), 'survived');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/** A test under another name that checks `untested`, the function the test next to age.js leaves alone. */
function addFeatureTest(dir) {
    fs.mkdirSync(path.join(dir, 'feature'));
    fs.writeFileSync(path.join(dir, 'feature', 'rules.test.js'), "const test = require('node:test');\nconst assert = require('node:assert');\nconst { untested } = require('../lib/age');\ntest('one is one, two is not', () => { assert.equal(untested(1), true); assert.equal(untested(2), false); });\n");
}

test('the test map adds tests under another name to the ones next to a file, each once', () => {
    const dir = sandbox();
    try {
        addFeatureTest(dir);
        const testMap = { 'lib/age.js': ['feature/rules.test.js', 'lib/age.test.js'] };
        assert.deepEqual(testsFor(dir, 'lib/age.js', testMap), ['lib/age.extra.test.js', 'lib/age.test.js', 'feature/rules.test.js']);
        assert.deepEqual(testsFor(dir, 'lib/age.js'), ['lib/age.extra.test.js', 'lib/age.test.js']);
        assert.deepEqual(testsFor(dir, 'lib/alone.js', testMap), []);
        // A moved group entry, map source or mapped test is named instead of silently dropped.
        assert.deepEqual(missingPaths(dir, { groups: { lib: ['lib', 'gone'] }, tests: testMap }), ['gone']);
        assert.deepEqual(missingPaths(dir, { groups: { lib: ['lib'] }, tests: { 'lib/moved.js': ['feature/rules.test.js', 'feature/none.test.js'] } }), ['feature/none.test.js', 'lib/moved.js']);
        assert.deepEqual(missingPaths(dir, { groups: { lib: ['lib/age.js'] } }), []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

tsTest('a mapped test kills what the tests next to the file miss; the sample itself does not move', async () => {
    const dir = sandbox();
    try {
        addFeatureTest(dir);
        const config = { groups: { lib: ['lib'] }, count: 20, seed: 1, perFile: 20 };
        const built = buildSample(ts, dir, config);
        // A file that only the map covers stays out of the sample.
        const mapped = buildSample(ts, dir, { ...config, tests: { 'lib/age.js': ['feature/rules.test.js'], 'lib/alone.js': ['feature/rules.test.js'] } });
        assert.deepEqual(mapped.mutants.map(idOf), built.mutants.map(idOf));
        const results = await runMutants(dir, built.mutants, { minTimeoutMs: 60000, testMap: { 'lib/age.js': ['feature/rules.test.js'] } });
        const verdict = (op, original) => results.find((r) => r.op === op && r.original === original)?.verdict;
        assert.equal(verdict('equality', '==='), 'killed');
        assert.equal(verdict('return-value', 'a === 1'), 'killed');
        assert.equal(verdict('boundary', '>='), 'killed');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

tsTest('a file whose tests fail unchanged is reported as such and not mutated', async () => {
    const dir = sandbox();
    try {
        fs.writeFileSync(path.join(dir, 'lib', 'age.extra.test.js'), "require('node:test')('red', () => { throw new Error('red'); });\n");
        const built = buildSample(ts, dir, { groups: { lib: ['lib'] }, count: 3, seed: 1 });
        const results = await runMutants(dir, built.mutants, { minTimeoutMs: 60000 });
        assert.ok(results.length > 0 && results.every((r) => r.verdict === 'baseline-red'));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a run that was killed with a mutant in the tree is undone from the journal', () => {
    const dir = sandbox();
    const file = path.join(dir, 'lib', 'age.js');
    const original = fs.readFileSync(file);
    try {
        assert.equal(recover(dir), null, 'nothing to recover on a clean start');
        // What runMutants leaves behind when the process dies between writing a mutant and restoring it.
        fs.mkdirSync(journalDir(dir), { recursive: true });
        fs.writeFileSync(path.join(journalDir(dir), 'original'), original);
        fs.writeFileSync(path.join(journalDir(dir), 'journal.json'), JSON.stringify({ file }));
        fs.writeFileSync(file, 'module.exports = {}; // a mutant');
        assert.equal(recover(dir), file);
        assert.ok(fs.readFileSync(file).equals(original));
        assert.equal(fs.existsSync(journalDir(dir)), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(journalDir(dir), { recursive: true, force: true }); }
});

tsTest('a finished run leaves no journal behind', async () => {
    const dir = sandbox();
    try {
        const built = buildSample(ts, dir, { groups: { lib: ['lib'] }, count: 2, seed: 1 });
        await runMutants(dir, built.mutants, { minTimeoutMs: 60000 });
        assert.equal(fs.existsSync(journalDir(dir)), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a test that never ends is stopped by the time-out and counts as not ok', async () => {
    const dir = sandbox();
    try {
        fs.writeFileSync(path.join(dir, 'lib', 'spin.test.js'), "require('node:test')('spins', () => { for (;;); });\n");
        const r = await runTest(dir, 'lib/spin.test.js', 1500);
        assert.deepEqual({ ok: r.ok, timedOut: r.timedOut }, { ok: false, timedOut: true });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a test that keeps allocating outside the heap is stopped by the memory watch', { skip: process.platform !== 'linux' }, async () => {
    const dir = sandbox();
    const before = process.env.MUTATION_CHILD_MAX_RSS_MB;
    process.env.MUTATION_CHILD_MAX_RSS_MB = '300';
    try {
        fs.writeFileSync(path.join(dir, 'lib', 'grow.test.js'), "require('node:test')('grows', async () => { const keep = []; for (;;) { keep.push(Buffer.alloc(32 * 1024 * 1024, 1)); await new Promise((r) => setTimeout(r, 20)); } });\n");
        const r = await runTest(dir, 'lib/grow.test.js', 60000);
        assert.equal(r.ok, false);
        assert.ok(r.ms < 30000, `stopped by the watch, not the time-out (${r.ms} ms)`);
    } finally {
        if (before === undefined) delete process.env.MUTATION_CHILD_MAX_RSS_MB; else process.env.MUTATION_CHILD_MAX_RSS_MB = before;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
