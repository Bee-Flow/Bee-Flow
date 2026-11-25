// @typecheck
/**
 * The cap on the child processes of out-of-process scripts (./codeSandboxProcess.js): at most
 * COWORK_SANDBOX_MAX_CHILDREN (default 4) run at once in the process, the next one waits for a free slot, and one that
 * waits too long fails its step with a plain message. The fork is handed in: a child here is a stand-in that answers
 * when the test says so.
 *
 * Run: cd server && node --test automation/codeSandboxProcess.slots.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { runCodeIsolated, createChildSlots, MAX_CHILDREN } = require('./codeSandboxProcess');

const tick = () => new Promise((r) => setImmediate(r));

/** A fork whose children answer only when told to. */
function standInFork() {
    /** @type {any[]} */
    const children = [];
    const fork = () => {
        const child = Object.assign(new EventEmitter(), {
            exitCode: /** @type {number | null} */ (null),
            kill() { child.exitCode = 0; },
            send() {},
            answer() { child.emit('message', { ok: true, result: { done: true }, logs: [] }); },
        });
        children.push(child);
        return child;
    };
    return { children, fork: /** @type {any} */ (fork) };
}

const job = { code: 'return 1', inputs: {} };

test('no more than COWORK_SANDBOX_MAX_CHILDREN (default 4) children run at once; the next starts when one ends', async () => {
    assert.strictEqual(MAX_CHILDREN, 4);
    const { children, fork } = standInFork();
    const runs = Array.from({ length: MAX_CHILDREN + 1 }, (_, i) => runCodeIsolated({ ...job, concurrencyKey: `org-${i}` }, { fork }));
    await tick();
    assert.strictEqual(children.length, MAX_CHILDREN, 'the fifth script waits for a slot');
    children[0].answer();
    assert.deepStrictEqual((await runs[0]).result, { done: true });
    await tick();
    assert.strictEqual(children.length, MAX_CHILDREN + 1, 'a slot freed: the waiting script starts');
    for (const child of children.slice(1)) child.answer();
    await Promise.all(runs);
});

test('a script that waits too long for a slot fails its step with a plain message', async () => {
    const { children, fork } = standInFork();
    const slots = createChildSlots({ maxChildren: 1, waitMs: 20 });
    const first = runCodeIsolated(job, { fork, slots });
    await assert.rejects(runCodeIsolated(job, { fork, slots }), /Too many scripts are running on this server right now/);
    assert.strictEqual(children.length, 1, 'the refused script never started a process');
    children[0].answer();
    await first;
});

test('one organisation holds at most CODE_STEP_MAX_CONCURRENCY_PER_ORG (default 2) children; another still gets a slot', async () => {
    const { children, fork } = standInFork();
    const slots = createChildSlots({ maxChildren: 4, maxPerOrg: 2, waitMs: 1000 });
    const ofA = [1, 2, 3].map(() => runCodeIsolated({ ...job, concurrencyKey: 'org-a' }, { fork, slots }));
    const ofB = runCodeIsolated({ ...job, concurrencyKey: 'org-b' }, { fork, slots });
    await tick();
    assert.strictEqual(children.length, 3, 'two of org A and the one of org B run; the third of org A waits');
    for (const child of children) child.answer();
    await tick();
    assert.strictEqual(children.length, 4);
    children[3].answer();
    await Promise.all([...ofA, ofB]);
});

test('a child that ends without an answer frees its slot too', async () => {
    const { children, fork } = standInFork();
    const slots = createChildSlots({ maxChildren: 1, waitMs: 1000 });
    const first = runCodeIsolated(job, { fork, slots });
    const second = runCodeIsolated(job, { fork, slots });
    await tick();
    children[0].emit('exit', 1, null);
    await assert.rejects(first, /ended without an answer/);
    await tick();
    assert.strictEqual(children.length, 2);
    children[1].answer();
    await second;
});

test('the cap is read from COWORK_SANDBOX_MAX_CHILDREN', () => {
    const script = `process.stdout.write(String(require(${JSON.stringify(path.join(__dirname, 'codeSandboxProcess.js'))}).MAX_CHILDREN))`;
    const read = execFileSync(process.execPath, ['-e', script], {
        cwd: path.join(__dirname, '..'), env: { ...process.env, NODE_ENV: 'test', COWORK_SANDBOX_MAX_CHILDREN: '2' }, encoding: 'utf8',
    });
    assert.strictEqual(read, '2');
});
