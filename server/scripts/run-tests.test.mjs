// @typecheck
/**
 * The runner is the server's quality gate, so what matters here is that it can
 * still FAIL — and that it counts everything.
 *
 * It used to pass --test-force-exit, which ended the run as soon as the runner
 * thought it was done and threw away results that had not been reported yet.
 * Measured on 25 real files: 367 tests with the flag, 430 without, while the
 * summary cheerfully said `# fail 0`. Two full runs on one unchanged tree
 * reported 16.945 and 16.908. The flag was there for a real reason — a few
 * files finish their tests and then keep the event loop alive — so the fix had
 * to keep handling the hang without cutting results off.
 *
 * These tests therefore pin the two halves of that trade: a handle-leaking file
 * must not hang the run AND must not cost anyone their results, and a failure
 * anywhere must still reach the exit code.
 *
 * Sandbox style is the one scripts/eslint-budget.test.mjs uses: a throwaway
 * checkout with the real scripts copied in. SERVER_DIR is resolved from the
 * script's own location, so copying it to <tmp>/server/scripts/ makes
 * <tmp>/server the server root; the roots helper, the ownership map code and the
 * resolver are copied to their places beside it, and the map is a small fixture.
 * The scope, --files and core-mode flags are tested at the end of this file.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
/** What the runner needs from the checkout, at the same place in the sandbox. */
const COPIED = [
    'server/scripts/run-tests.mjs', 'server/scripts/testShards.mjs', 'server/scripts/coverageUrls.mjs', 'server/scripts/testScope.mjs',
    'server/moduleRoots.cjs', 'server/modules/roots/rootSet.cjs', 'server/modules/roots/resolveHooks.cjs', 'server/modules/roots/treeCheck.cjs',
    'scripts/lib/roots.mjs', 'scripts/module-map.mjs', 'scripts/module-map-edges.mjs', 'scripts/entry-point.mjs',
];
/** Two modules: alpha still sits in server/, beta has a module root of its own. */
const FIXTURE_MAP = {
    packages: { server: { coreDir: 'server', moduleDir: 'server' } },
    modules: {
        alpha: { requires: [], uses: [], server: ['alpha/**'] },
        beta: { requires: [], uses: [], server: ['beta/**'] },
    },
    core: {},
};

/** A file whose tests all pass and which then refuses to let the process exit. */
const LEAKS_A_HANDLE = `
import test from 'node:test';
const held = setInterval(() => {}, 1000);
test('one', () => {});
test('two', () => {});
test('three', () => {});
// deliberately never cleared, and deliberately not unref'd: this is the exact
// shape that made someone reach for --test-force-exit in the first place.
void held;
`;

const PASSES = `
import test from 'node:test';
test('alpha', () => {});
test('beta', () => {});
`;

/** Finishes, but late enough that a scheduling-dependent runner could miss it. */
const SLOW_BUT_FINISHES = `
import test from 'node:test';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
test('slow one', async () => { await wait(250); });
test('slow two', async () => { await wait(250); });
test('slow three', async () => { await wait(250); });
test('slow four', async () => { await wait(250); });
`;

const FAILS = `
import test from 'node:test';
import assert from 'node:assert';
test('this one is meant to fail', () => assert.strictEqual(1, 2));
`;

/** @param {string} file @param {string} body */
function put(file, body) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
}

/**
 * @param {Record<string, string>} files by tree path, in server/
 * @param {object[]} [exclusions]
 * @param {Record<string, Record<string, string>>} [moduleFiles] per module id, by tree path, in modules/<id>/server
 * @returns {string} the sandbox's server root
 */
function sandbox(files, exclusions = [], moduleFiles = {}) {
    const top = fs.mkdtempSync(path.join(os.tmpdir(), 'run-tests-'));
    for (const rel of COPIED) put(path.join(top, rel), fs.readFileSync(path.join(REPO, rel), 'utf8'));
    put(path.join(top, 'scripts/module-map.json'), JSON.stringify(FIXTURE_MAP));
    const dir = path.join(top, 'server');
    put(path.join(dir, 'scripts/test-exclusions.json'), JSON.stringify({ exclusions }));
    for (const [name, body] of Object.entries(files)) put(path.join(dir, name), body);
    for (const [id, own] of Object.entries(moduleFiles)) {
        for (const [name, body] of Object.entries(own)) put(path.join(top, 'modules', id, 'server', name), body);
    }
    return dir;
}

function run(dir, env = {}, args = []) {
    // This file runs under `node --test`, which marks its children with
    // NODE_TEST_CONTEXT. A nested `node --test` seeing that marker decides it
    // is a recursive call and silently skips every file — so the sandbox would
    // be testing nothing at all. Strip it for the child.
    // The resolver and core mode of THIS run must not leak into the sandbox's.
    const clean = { ...process.env };
    for (const k of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'BEEFLOW_MODULE_ROOTS', 'BEEFLOW_HIDE_MODULES']) delete clean[k];
    const r = spawnSync(process.execPath, ['scripts/run-tests.mjs', ...args], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...clean, TEST_FILE_TIMEOUT_MS: '20000', ...env },
    });
    return { ...r, all: `${r.stdout || ''}${r.stderr || ''}` };
}

test('a file that never lets go is named, and does not take the other files down with it', () => {
    // The regression this file exists for. The old flag hid this file by
    // cutting the whole run short; now it is named and the clean file beside
    // it still reports every one of its tests.
    const dir = sandbox({ 'leaky.test.mjs': LEAKS_A_HANDLE, 'clean.test.mjs': PASSES });
    const r = run(dir, { TEST_FILE_TIMEOUT_MS: '3000' });
    assert.notStrictEqual(r.status, 0, `a file that never exits must fail the run:\n${r.all}`);
    assert.match(r.all, /HUNG {2}leaky\.test\.mjs/, `the culprit must be named:\n${r.all}`);
    assert.match(r.all, /keeps the event loop alive/);
    assert.match(r.all, /^# tests 2$/m, `the clean file's tests still count:\n${r.all}`);
    assert.match(r.all, /^# pass 2$/m);
});

test('a failing file is named and fails the run, whatever else is in the set', () => {
    // The whole point of the gate. If this ever goes green, the suite has
    // stopped being able to say no.
    const dir = sandbox({ 'clean.test.mjs': PASSES, 'bad.test.mjs': FAILS });
    const r = run(dir);
    assert.notStrictEqual(r.status, 0, `a failing test must fail the run:\n${r.all}`);
    assert.match(r.all, /FAIL {2}bad\.test\.mjs/);
    assert.match(r.all, /^# fail 1$/m);
    assert.match(r.all, /^# pass 2$/m, 'and the passing file is still counted');
});

test('the totals are the sum of every file, not of whatever got reported in time', () => {
    // The bug in one line: the old runner's totals depended on scheduling.
    // Three files, eight tests, every run.
    const dir = sandbox({ 'a.test.mjs': PASSES, 'b.test.mjs': PASSES, 'c.test.mjs': SLOW_BUT_FINISHES });
    for (let i = 0; i < 2; i += 1) {
        const r = run(dir);
        assert.strictEqual(r.status, 0, r.all);
        assert.match(r.all, /^# tests 8$/m, `run ${i + 1} must count all eight:\n${r.all}`);
    }
});

test('an ordinary failing run exits non-zero', () => {
    const dir = sandbox({ 'bad.test.mjs': FAILS });
    assert.notStrictEqual(run(dir).status, 0);
});

test('killing a wedged file kills what IT spawned, not just the direct child', () => {
    // The expensive one. `node --test` spawns a further process per test file,
    // so SIGKILL on the direct child left the actually-wedged grandchild
    // running — orphaned, at 100% of a core, forever. Six accumulated on this
    // machine from the fixture below before anyone noticed, the load average
    // hit 26 on four cores, and every suite slowed to a crawl while looking
    // like it had frozen.
    //
    // Checked by making the wedged file KEEP WRITING. If a descendant survived
    // the kill it goes on appending, so the file keeps growing after the run
    // has returned. No process-table lookup, so this works wherever the suite
    // does.
    const dir = sandbox({});
    const marker = path.join(dir, 'still-alive.txt');
    fs.writeFileSync(path.join(dir, 'wedged.test.mjs'),
        `import fs from 'node:fs';\nfor (;;) { fs.appendFileSync(${JSON.stringify(marker)}, 'x'); }\n`);

    const r = run(dir, { TEST_FILE_TIMEOUT_MS: '2000' });
    assert.notStrictEqual(r.status, 0, r.all);

    const sizeAtExit = fs.statSync(marker).size;
    // Busy-wait briefly without a timer: a survivor would add megabytes here.
    const until = Date.now() + 1500;
    while (Date.now() < until) { /* deliberately spinning, ~1.5s */ }
    assert.strictEqual(
        fs.statSync(marker).size, sizeAtExit,
        'something the wedged file spawned outlived the run and is still writing',
    );
});

test('a file that wedges before reporting anything is a failure, not a hang', () => {
    // The runner must give up on its own and say which file, rather than sit
    // there until CI's own timeout kills the job with no diagnosis.
    const dir = sandbox({ 'wedged.test.mjs': 'while (true) {}\n' });
    const r = run(dir, { TEST_FILE_TIMEOUT_MS: '2000' });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.all, /HUNG {2}wedged\.test\.mjs/, `expected the file to be named:\n${r.all}`);
});

test('an exclusion naming a file that no longer exists still fails the run', () => {
    // Pre-existing guard: a rename must update the list, so coverage cannot
    // shrink quietly. Kept here because the run block around it was rewritten.
    const dir = sandbox(
        { 'clean.test.mjs': PASSES },
        [{ file: 'gone.test.js', bucket: 'failing', reason: 'removed in a refactor' }],
    );
    const r = run(dir);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.all, /no longer exists/);
});

test('an unknown bucket is refused', () => {
    const dir = sandbox(
        { 'clean.test.mjs': PASSES },
        [{ file: 'clean.test.mjs', bucket: 'temporarily-annoying', reason: 'nope' }],
    );
    const r = run(dir);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.all, /Invalid bucket/);
});

test('a reporter flag is refused before anything runs, not read as "reported nothing"', () => {
    // The exact arguments ci.yml's server step carried: spec prints `ℹ tests N`
    // where the runner reads `# tests N`, so both files came back NO SUMMARY and
    // a green suite failed; and every child rewrote the one lcov file, leaving
    // only the last file's coverage. A refusal that names the flag is the
    // cheap answer to both.
    const dir = sandbox({ 'a.test.mjs': PASSES, 'b.test.mjs': PASSES });
    fs.mkdirSync(path.join(dir, 'coverage'));
    const r = run(dir, {}, [
        '--experimental-test-coverage',
        '--test-reporter=spec', '--test-reporter-destination=stdout',
        '--test-reporter=lcov', '--test-reporter-destination=coverage/lcov.info',
    ]);
    assert.notStrictEqual(r.status, 0, r.all);
    assert.match(r.all, /--test-reporter=spec .*refused/);
    assert.doesNotMatch(r.all, /NO SUMMARY/, `nothing may have run:\n${r.all}`);
    assert.strictEqual(fs.existsSync(path.join(dir, 'coverage/lcov.info')), false, 'no child may have started');

    // The space-separated form is the same flag.
    const spaced = run(dir, {}, ['--test-reporter', 'spec']);
    assert.notStrictEqual(spaced.status, 0, spaced.all);
    assert.match(spaced.all, /refused/);

    // And the plain run the CI step now uses still counts both files.
    const plain = run(dir);
    assert.strictEqual(plain.status, 0, plain.all);
    assert.match(plain.all, /^# tests 4$/m);
});

test('shards together run every file exactly once, a file unknown to the durations file included', () => {
    const files = {};
    for (const n of ['a', 'b', 'c', 'd', 'e']) files[`${n}.test.mjs`] = PASSES;
    const dir = sandbox(files);
    // only two files have a recorded duration; the other three must still run
    fs.writeFileSync(path.join(dir, 'scripts/test-durations.json'), JSON.stringify({ durations: { 'a.test.mjs': 900, 'b.test.mjs': 100 } }));
    const seen = [];
    for (const i of [1, 2, 3]) {
        const r = run(dir, {}, ['--shard', `${i}/3`, '--list']);
        assert.strictEqual(r.status, 0, r.all);
        seen.push(...JSON.parse(r.all.trim().split('\n').pop()));
    }
    assert.deepStrictEqual(seen.sort(), Object.keys(files).sort());

    // and running a shard really runs only its files, with the tally of those
    const ran = [1, 2, 3].map((i) => run(dir, {}, ['--shard', `${i}/3`]));
    for (const r of ran) assert.strictEqual(r.status, 0, r.all);
    const total = ran.reduce((t, r) => t + Number(/^# files (\d+)$/m.exec(r.all)[1]), 0);
    assert.strictEqual(total, 5);
    assert.notStrictEqual(run(dir, {}, ['--shard', '4/3']).status, 0);
});

const EXITS_ITSELF = `
import test from 'node:test';
test('one', () => {});
test('two', () => {});
test('then leaves', () => { setImmediate(() => process.exit(0)); });
`;

const IN_PROCESS = `
import test from 'node:test';
import assert from 'node:assert';
test('runs in the node --test process itself', () => {
    assert.ok(process.execArgv.includes('--experimental-test-isolation=none'), process.execArgv.join(' '));
});
`;

test('a file that calls process.exit() itself still reports, the others run in-process', () => {
    const dir = sandbox({ 'exits.test.mjs': EXITS_ITSELF, 'inproc.test.mjs': IN_PROCESS });
    const r = run(dir);
    assert.equal(r.status, 0, r.all);
    assert.match(r.all, /^# tests 4$/m, r.all);
    assert.match(r.all, /^# pass 4$/m, r.all);
    assert.doesNotMatch(r.all, /NO SUMMARY/, r.all);
});

test('every child shares one compile cache, under node_modules/.cache unless the environment names one', () => {
    const dir = sandbox({ 'a.test.mjs': PASSES });
    // This file itself runs under the runner, which hands every child its
    // cache directory; an empty value is "unset" to the runner under test.
    const r = run(dir, { NODE_COMPILE_CACHE: '' });
    assert.equal(r.status, 0, r.all);
    assert.ok(fs.existsSync(path.join(dir, 'node_modules/.cache/node-compile-cache')), 'default cache directory');
    const own = path.join(dir, 'own-cache');
    assert.equal(run(dir, { NODE_COMPILE_CACHE: own }).status, 0);
    assert.ok(fs.existsSync(own), 'explicit NODE_COMPILE_CACHE directory');
});

// ── Scope, --files and core mode ────────────────────────────────────────────

/** core: a.test.mjs; alpha (still in server/): alpha/x.test.mjs; beta (own root): beta/b.test.mjs. */
const scoped = (exclusions = []) => sandbox(
    { 'a.test.mjs': PASSES, 'alpha/x.test.mjs': PASSES },
    exclusions,
    { beta: { 'beta/b.test.mjs': PASSES } },
);
/** @param {string} dir @param {string[]} args */
const listed = (dir, args) => {
    const r = run(dir, {}, [...args, '--list']);
    assert.strictEqual(r.status, 0, r.all);
    return JSON.parse(r.all.trim().split('\n').pop());
};

test('test files are collected over every root and named by tree path; --scope picks by owner', () => {
    const dir = scoped();
    assert.deepStrictEqual(listed(dir, []), ['a.test.mjs', 'alpha/x.test.mjs', 'beta/b.test.mjs']);
    assert.deepStrictEqual(listed(dir, ['--scope', 'full']), ['a.test.mjs', 'alpha/x.test.mjs', 'beta/b.test.mjs']);
    assert.deepStrictEqual(listed(dir, ['--scope', 'core']), ['a.test.mjs']);
    assert.deepStrictEqual(listed(dir, ['--scope', 'alpha']), ['alpha/x.test.mjs']);
    assert.deepStrictEqual(listed(dir, ['--scope', 'alpha,beta']), ['alpha/x.test.mjs', 'beta/b.test.mjs']);
    // the module root's file really runs, from where it lies
    const r = run(dir, {}, ['--scope', 'beta']);
    assert.strictEqual(r.status, 0, r.all);
    assert.match(r.all, /^Running 1 of 1 test files \(scope beta\)/m);
    assert.match(r.all, /^# pass 2$/m);
});

test('shards split the files of the scope, every one once', () => {
    const dir = sandbox({ 'a.test.mjs': PASSES, 'b.test.mjs': PASSES, 'c.test.mjs': PASSES, 'alpha/x.test.mjs': PASSES });
    const seen = [1, 2].flatMap((i) => listed(dir, ['--scope', 'core', '--shard', `${i}/2`]));
    assert.deepStrictEqual(seen.sort(), ['a.test.mjs', 'b.test.mjs', 'c.test.mjs']);
});

test('an unknown module id is an error, for --scope and --hide-modules alike', () => {
    const dir = scoped();
    for (const args of [['--scope', 'gamma'], ['--scope', 'alpha,gamma'], ['--hide-modules', 'gamma']]) {
        const r = run(dir, {}, [...args, '--list']);
        assert.strictEqual(r.status, 2, r.all);
        assert.match(r.all, /unknown module gamma/);
    }
});

test('--files runs exactly the named tree paths, and refuses one it cannot run', () => {
    const dir = scoped([{ file: 'alpha/x.test.mjs', bucket: 'failing', reason: 'fixture' }]);
    assert.deepStrictEqual(listed(dir, ['--files', 'beta/b.test.mjs,a.test.mjs']), ['a.test.mjs', 'beta/b.test.mjs']);
    /** @type {[string, RegExp][]} */
    const refused = [['nope.test.mjs', /not a test file of any root/], ['alpha/x.test.mjs', /is excluded/]];
    for (const [files, why] of refused) {
        const r = run(dir, {}, ['--files', files, '--list']);
        assert.strictEqual(r.status, 2, r.all);
        assert.match(r.all, why);
    }
    const outside = run(dir, {}, ['--scope', 'core', '--files', 'beta/b.test.mjs', '--list']);
    assert.strictEqual(outside.status, 2, outside.all);
    assert.match(outside.all, /outside the chosen --scope/);
});

test('a stale exclusion fails only the runs whose scope it belongs to', () => {
    const dir = scoped([{ file: 'alpha/gone.test.mjs', bucket: 'failing', reason: 'removed' }]);
    for (const args of [[], ['--scope', 'alpha']]) {
        const r = run(dir, {}, [...args, '--list']);
        assert.strictEqual(r.status, 1, r.all);
        assert.match(r.all, /no longer exists: alpha\/gone\.test\.mjs/);
    }
    assert.deepStrictEqual(listed(dir, ['--scope', 'core']), ['a.test.mjs']);
    assert.deepStrictEqual(listed(dir, ['--scope', 'beta']), ['beta/b.test.mjs']);
});

const SEES_THE_RESOLVER = `
import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
test('the resolver is in NODE_OPTIONS, after what was there', () => {
    const opts = process.env.NODE_OPTIONS || '';
    assert.ok(opts.startsWith('--max-old-space-size=512 '), opts);
    assert.ok(opts.includes('--require=' + path.resolve('moduleRoots.cjs')), opts);
});
test('core mode reaches the child', () => {
    assert.strictEqual(process.env.BEEFLOW_HIDE_MODULES, process.env.EXPECT_HIDE || undefined);
    if (process.env.EXPECT_HIDE) assert.throws(() => require('./alpha/helper.cjs'), { code: 'MODULE_NOT_FOUND' });
    else assert.strictEqual(require('./alpha/helper.cjs'), 'alpha');
});
`;

test('every child gets the resolver through NODE_OPTIONS, and --hide-modules hides', () => {
    const dir = sandbox({ 'sees.test.mjs': SEES_THE_RESOLVER, 'alpha/helper.cjs': "module.exports = 'alpha';\n" });
    const env = { NODE_OPTIONS: '--max-old-space-size=512' };
    const plain = run(dir, env);
    assert.strictEqual(plain.status, 0, plain.all);
    assert.match(plain.all, /^# pass 2$/m);
    // `--scope core` alone hides nothing; hiding is its own switch.
    const hidden = run(dir, { ...env, EXPECT_HIDE: 'alpha' }, ['--scope', 'core', '--hide-modules', 'alpha']);
    assert.strictEqual(hidden.status, 0, hidden.all);
    assert.match(hidden.all, /\(hiding alpha\)/);
    assert.match(hidden.all, /^# pass 2$/m);
    const all = run(dir, { ...env, EXPECT_HIDE: 'all' }, ['--hide-modules', 'all']);
    assert.strictEqual(all.status, 0, all.all);
});
