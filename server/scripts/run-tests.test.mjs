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
 * tree with the real script copied in. SERVER_DIR is resolved from the script's
 * own location, so copying it to <tmp>/scripts/ makes <tmp> the server root.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'run-tests.mjs');

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

function sandbox(files, exclusions = []) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-tests-'));
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts/run-tests.mjs'));
    fs.copyFileSync(path.join(HERE, 'testShards.mjs'), path.join(dir, 'scripts/testShards.mjs'));
    fs.writeFileSync(path.join(dir, 'scripts/test-exclusions.json'), JSON.stringify({ exclusions }));
    for (const [name, body] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), body);
    }
    return dir;
}

function run(dir, env = {}, args = []) {
    // This file runs under `node --test`, which marks its children with
    // NODE_TEST_CONTEXT. A nested `node --test` seeing that marker decides it
    // is a recursive call and silently skips every file — so the sandbox would
    // be testing nothing at all. Strip it for the child.
    const clean = { ...process.env };
    delete clean.NODE_TEST_CONTEXT;
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
