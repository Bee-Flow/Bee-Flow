/**
 * runComponent bounds a component run in time and in output size.
 *
 * It used to have no kill timer and appended every stdout chunk to a string,
 * settling only on 'close': a component that hangs kept its workflow (and the
 * chat turn or request awaiting it) pending forever, and one that floods stdout
 * grew the shared server's heap without limit. These tests spawn real children.
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runComponent } = require('./executionEngine');

/** @type {string} */
let root;

/** @param {string} name @param {string} source */
function component(name, source) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'index.js'), source);
    return dir;
}

let hang;
let flood;
let echo;
let noisyStderr;
let crash;

before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'component-limits-'));
    // Never exits on its own.
    hang = component('hang', 'setInterval(() => {}, 1000);\n');
    // Writes stdout forever.
    flood = component('flood', `
const chunk = 'x'.repeat(64 * 1024);
function more() { while (process.stdout.write(chunk)) {} process.stdout.once('drain', more); }
more();
`);
    echo = component('echo', `
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
    process.stdout.write(JSON.stringify({ result: JSON.parse(input), text: 'héllo €' }));
});
`);
    noisyStderr = component('noisy-stderr', `
process.stderr.write('e'.repeat(200 * 1024));
process.exitCode = 3;
`);
    crash = component('crash', "process.stderr.write('boom'); process.exit(2);\n");
});

after(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
});

test('a component that hangs is killed after the timeout and the run rejects', async () => {
    const started = Date.now();
    await assert.rejects(runComponent(hang, {}, { timeoutMs: 300 }), /timed out after 300 ms/);
    assert.ok(Date.now() - started < 10_000, 'the run settled promptly');
});

test('a component that floods stdout is killed at the cap and the run rejects', async () => {
    await assert.rejects(
        runComponent(flood, {}, { maxStdoutBytes: 1024 * 1024, timeoutMs: 30_000 }),
        /output exceeded 1048576 bytes/,
    );
});

test('stderr is truncated, not unbounded, and the exit code still decides the error', async () => {
    await assert.rejects(runComponent(noisyStderr, {}, { maxStderrBytes: 1000 }), (err) => {
        assert.match(err.message, /^Component exited with code 3: e+$/);
        assert.ok(err.message.length < 1100, `stderr kept: ${err.message.length} chars`);
        return true;
    });
});

test('a normal component still returns its parsed JSON with the default limits', async () => {
    const out = await runComponent(echo, { a: 1, nested: { b: [1, 2] } });
    assert.deepEqual(out, { result: { a: 1, nested: { b: [1, 2] } }, text: 'héllo €' });
});

test('a non-zero exit still rejects with the code and stderr', async () => {
    await assert.rejects(runComponent(crash, {}), /^Error: Component exited with code 2: boom$/);
});
