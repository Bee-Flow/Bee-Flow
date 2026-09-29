/**
 * Three things the code step needed before it could ever have a Run button.
 *
 * 1. THE ISOLATE LEAK. `compileScript` is where a syntax error in the
 *    author's own code throws, and it used to sit OUTSIDE the try/finally
 *    that disposes the isolate. So every typo stranded a whole V8 isolate —
 *    up to `memoryMb` of heap, 64 MB by default — for the life of the
 *    process, with nothing to see: the author got their syntax error, the run
 *    failed cleanly, the pod's memory climbed. It was survivable only because
 *    there was no way to run a code step from the editor. The moment there
 *    is, an author iterating on a function leaks one per run.
 *
 * 2. THE LINE NUMBERS. V8 counts from the top of the script it compiled, and
 *    that script is our ctx bootstrap with the author's code spliced into the
 *    middle — so "line 34" meant their line 1. In a box whose only debugging
 *    tool IS the error message, an error that points at the wrong line is
 *    close to no error at all.
 *
 * 3. THE TEST RUN. A dry run SKIPPED code steps ("code-step skipped in
 *    dry-run"), which is the one step type where skipping teaches nothing:
 *    the whole question about a code step is whether the code works. But it
 *    is also the step type with the broadest reach — ctx.integrations can
 *    send mail, ctx.http can POST anywhere public — so a rehearsal that ran
 *    it for real would mail the customer. The code runs; the outside is
 *    stubbed and recorded.
 *
 * Run: cd server && node --test --test-force-exit automation/codeSandbox.testMode.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const sandbox = require('./codeSandbox');
const { describeCodeError, testBridges } = sandbox;

test('isolated-vm is present — the sandbox assertions below are real', () => {
    assert.ok(sandbox.isAvailable(), sandbox.loadError() || 'expected the sandbox to be available');
});

// ── 1. The leak ─────────────────────────────────────────────────────────────

/**
 * Every isolate this process has made and not yet disposed.
 *
 * There is no counter to read, so the test wraps the constructor: the only
 * honest way to assert "nothing was stranded" is to watch them being made and
 * check afterwards that each one is disposed. isolated-vm exposes
 * `isolate.isDisposed`, which is what the sandbox's own finally checks.
 */
function watchIsolates() {
    // `ivm.Isolate` is a read-only property of the native module, so the
    // constructor is wrapped one level up: the module's cache entry is
    // swapped for an object that inherits everything and shadows `Isolate`,
    // and codeSandbox is re-required so it captures the wrapper in its own
    // module-local `ivm`. Both are put back afterwards.
    const ivmPath = require.resolve('isolated-vm');
    const sandboxPath = require.resolve('./codeSandbox');
    const real = require('isolated-vm');
    const made = [];
    const shim = Object.create(real);
    Object.defineProperty(shim, 'Isolate', {
        value: function Watched(...args) {
            const iso = new real.Isolate(...args);
            made.push(iso);
            return iso;
        },
    });
    const realEntry = require.cache[ivmPath].exports;
    require.cache[ivmPath].exports = shim;
    delete require.cache[sandboxPath];
    const watched = require('./codeSandbox');
    return {
        run: watched.runCode,
        made,
        stranded: () => made.filter(i => !i.isDisposed),
        restore: () => {
            require.cache[ivmPath].exports = realEntry;
            delete require.cache[sandboxPath];
            require('./codeSandbox');
        },
    };
}

test('A SYNTAX ERROR IN THE AUTHOR\'S CODE DOES NOT STRAND AN ISOLATE', async () => {
    const watch = watchIsolates();
    try {
        await assert.rejects(
            () => watch.run({ code: 'function main(inputs, ctx) { return 1;' }),
            /Code step error/,
        );
        assert.strictEqual(watch.made.length, 1, 'expected exactly one isolate for one run');
        assert.deepStrictEqual(watch.stranded(), [], 'a failed compile left an isolate alive');
    } finally {
        watch.restore();
    }
});

test('an input the boundary cannot copy does not strand one either', async () => {
    // ExternalCopy throws on a value it cannot clone, and `inputs` is data the
    // AUTHOR supplied — a function reaching this bridge is a mapping mistake,
    // not an attack, and it happened before the old try/finally began.
    const watch = watchIsolates();
    try {
        await assert.rejects(() => watch.run({ code: 'return 1;', inputs: { fn: () => 1 } }));
        assert.deepStrictEqual(watch.stranded(), [], 'an uncopyable input left an isolate alive');
    } finally {
        watch.restore();
    }
});

test('a clean run disposes too — the common path is not the one at risk, but pin it', async () => {
    const watch = watchIsolates();
    try {
        const { result } = await watch.run({ code: 'function main() { return 7; }' });
        assert.strictEqual(result, 7);
        assert.deepStrictEqual(watch.stranded(), []);
    } finally {
        watch.restore();
    }
});

test('code that throws at run time disposes as well', async () => {
    const watch = watchIsolates();
    try {
        await assert.rejects(() => watch.run({ code: 'function main() { throw new Error("boom"); }' }), /boom/);
        assert.deepStrictEqual(watch.stranded(), []);
    } finally {
        watch.restore();
    }
});

// ── 2. The line numbers ─────────────────────────────────────────────────────

test('A SYNTAX ERROR POINTS AT THE LINE THE AUTHOR WROTE', async () => {
    // Three blank-ish lines, then the mistake on line 4. Before the offset it
    // reported a number in the thirties — a line of our bootstrap.
    const code = ['const a = 1;', 'const b = 2;', '', 'const c = ;'].join('\n');
    await assert.rejects(() => sandbox.runCode({ code }), (e) => {
        assert.match(e.message, /line 4/, `expected the author's line 4, got: ${e.message}`);
        // And it must not still be carrying the compiled-script number.
        assert.doesNotMatch(e.message, /step\.js:\d/);
        return true;
    });
});

test('describeCodeError does not re-shift a number V8 already fixed', () => {
    // compileScript's negative lineOffset corrects the numbers AT THE SOURCE,
    // for the syntax error and every frame of a runtime stack alike. Shifting
    // again here is how a fix like this becomes a second, opposite bug — so
    // this function only respells.
    assert.strictEqual(describeCodeError(new Error("Unexpected token ';' [step.js:4:11]")),
        "Unexpected token ';' at line 4, column 11");
    assert.strictEqual(describeCodeError(new Error('boom [step.js:7]')), 'boom at line 7');
    assert.strictEqual(describeCodeError(new Error('at step.js:2:5')), 'at line 2, column 5');
});

test('describeCodeError passes an ordinary message straight through', () => {
    // "step.js" is a name we invented for a file the author has never seen —
    // their code lives in a step. Nothing else in the message is touched.
    assert.strictEqual(describeCodeError(new Error('boom')), 'boom');
    assert.strictEqual(describeCodeError('a string'), 'a string');
});

test('a runtime error points at the author\'s line too', async () => {
    const code = ['const a = 1;', '', 'function main() {', '    throw new Error("from line 4");', '}'].join('\n');
    await assert.rejects(() => sandbox.runCode({ code }), (e) => {
        assert.match(e.message, /from line 4/);
        assert.doesNotMatch(e.message, /step\.js:\d/, `raw coordinate left in: ${e.message}`);
        return true;
    });
});

// ── 3. The test run ─────────────────────────────────────────────────────────

test('THE CODE ACTUALLY RUNS IN TEST MODE — that is the whole difference from skipping', async () => {
    const { result, logs } = await sandbox.runCode({
        mode: 'test',
        code: 'ctx.log("here"); function main(inputs) { return inputs.n * 2; }',
        inputs: { n: 21 },
    });
    assert.strictEqual(result, 42);
    assert.deepStrictEqual(logs, ['here']);
});

test('a tool call is RECORDED, not sent', async () => {
    let reallyCalled = false;
    const { result, calls } = await sandbox.runCode({
        mode: 'test',
        code: 'async function main(i, ctx) { return await ctx.integrations.gmail_send({ to: "a@b.nl" }); }',
        bridges: {
            allowedTools: new Set(['gmail_send']),
            executeTool: async () => { reallyCalled = true; return { ok: true }; },
        },
    });
    assert.strictEqual(reallyCalled, false, 'a test run must not reach the real bridge');
    assert.deepStrictEqual(calls, [{ kind: 'tool', name: 'gmail_send', args: { to: 'a@b.nl' } }]);
    // The line AFTER the call still runs, which is the point: the author gets
    // to find out their code throws on line 12.
    assert.strictEqual(result._stub, true);
    assert.strictEqual(result.tool, 'gmail_send');
});

test('a stub cannot be mistaken for data that came back from anywhere', async () => {
    // A stubbed body of "" or {} reads like a real empty answer and sends
    // someone hunting for a bug at the far end.
    const { result } = await sandbox.runCode({
        mode: 'test',
        code: 'async function main(i, ctx) { return await ctx.http("https://example.com"); }',
        bridges: { fetchHttp: async () => ({ status: 200, body: 'real' }) },
    });
    assert.strictEqual(result._stub, true);
    assert.match(result.note, /test run/i);
    assert.notStrictEqual(result.body, 'real');
});

test('an http call is recorded with the url it would have used', async () => {
    const { calls } = await sandbox.runCode({
        mode: 'test',
        code: 'async function main(i, ctx) { await ctx.http("https://example.com/x", { method: "POST" }); }',
        bridges: { fetchHttp: async () => ({ status: 200 }) },
    });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].kind, 'http');
    assert.strictEqual(calls[0].name, 'https://example.com/x');
    assert.strictEqual(calls[0].args.method, 'POST');
});

test('a live run is untouched — no calls list, and the real bridge is reached', async () => {
    let reallyCalled = false;
    const out = await sandbox.runCode({
        code: 'async function main(i, ctx) { return await ctx.integrations.t({}); }',
        bridges: {
            allowedTools: new Set(['t']),
            executeTool: async () => { reallyCalled = true; return { ok: true }; },
        },
    });
    assert.strictEqual(reallyCalled, true);
    assert.strictEqual(out.calls, undefined, 'a live run must not carry a test-run field');
    assert.deepStrictEqual(out.result, { ok: true });
});

test('testBridges keeps a db bridge stubbed too, and only when there was one', () => {
    // A read is as stubbed as a write: answering a query with real rows would
    // put customer data in a rehearsal's output.
    assert.strictEqual(typeof testBridges({}).bridges.db, 'undefined');
    assert.strictEqual(typeof testBridges({ db: async () => ({}) }).bridges.db, 'function');
});

test('a test run still refuses a tool the step never declared', async () => {
    // The allow-list is not a production-only concern: a rehearsal that
    // quietly permits more than the real run would teach the wrong lesson.
    const { result } = await sandbox.runCode({
        mode: 'test',
        code: 'async function main(i, ctx) { return await ctx.integrations.not_declared({}); }',
        bridges: { allowedTools: new Set(['only_this']), executeTool: async () => ({ ok: true }) },
    });
    assert.match(result.error, /not allowed for this step/);
});

// ── 4. The rehearsal, end to end through execCode ───────────────────────────

test('A DRY RUN NOW RUNS THE CODE instead of reporting that it skipped it', async (t) => {
    // Of every step type this is the one where skipping teaches nothing: the
    // whole question about a code step is whether the code works, and the
    // first time an author used to find out about a typo was a LIVE run —
    // exactly the run a rehearsal exists to save them from.
    const configStore = require('../stores/configStore');
    const beta = require('../core/entitlements/betaFeatures');
    t.mock.method(configStore, 'getConfig', async (k) => (k === 'automation_code_step_enabled' ? true : null));
    t.mock.method(beta, 'orgHasBetaFeature', async () => true);

    const { execCode } = require('../core/automationRunner/execOutbound');
    const step = { id: 's1', type: 'code', code: 'function main() { return 6 * 7; }', inputs: {} };
    const out = await execCode(step, { userId: 'u1', orgId: null, session: {} }, { steps: {} }, 'dry_run');
    assert.strictEqual(out.output.result, 42);
    assert.strictEqual(out.output._dryRun, true);
});

test('a rehearsal reports what it WOULD have called, so a stub cannot pass for a real call', async (t) => {
    const configStore = require('../stores/configStore');
    const beta = require('../core/entitlements/betaFeatures');
    t.mock.method(configStore, 'getConfig', async (k) => (k === 'automation_code_step_enabled' ? true : null));
    t.mock.method(beta, 'orgHasBetaFeature', async () => true);

    const { execCode } = require('../core/automationRunner/execOutbound');
    const step = {
        id: 's1', type: 'code', inputs: {},
        code: 'async function main(i, ctx) { await ctx.http("https://example.com/x"); return "done"; }',
    };
    const out = await execCode(step, { userId: 'u1', orgId: null, session: {} }, { steps: {} }, 'dry_run');
    assert.strictEqual(out.output.result, 'done');
    assert.deepStrictEqual(out.output.wouldHaveCalled.map(c => c.kind), ['http']);
    assert.strictEqual(out.output.wouldHaveCalled[0].name, 'https://example.com/x');
});

test('there is no switch: whatever the config holds, code steps run, in a rehearsal and live', async (t) => {
    // The platform flag `automation_code_step_enabled` is gone. A config store
    // answering `false` to every key (the old way to switch code off) changes
    // nothing any more.
    const configStore = require('../stores/configStore');
    t.mock.method(configStore, 'getConfig', async () => false);

    const { execCode } = require('../core/automationRunner/execOutbound');
    const step = { id: 's1', type: 'code', code: 'function main() { return 1; }', inputs: {} };
    const dry = await execCode(step, { userId: 'u1', orgId: null, session: {} }, { steps: {} }, 'dry_run');
    assert.strictEqual(dry.output.result, 1);
    const live = await execCode(step, { userId: 'u1', orgId: null, session: {} }, { steps: {} }, 'live');
    assert.strictEqual(live.output.result, 1);
});

test('an install without the sandbox: a rehearsal SKIPS, a live run refuses out loud', async (t) => {
    // A rehearsal must not be the thing that fails on a missing sandbox; a live
    // run is where that refusal belongs.
    const sandbox = require('./codeSandbox');
    t.mock.method(sandbox, 'isAvailable', () => false);
    t.mock.method(sandbox, 'loadError', () => "Cannot find module 'isolated-vm'");

    const { execCode } = require('../core/automationRunner/execOutbound');
    const step = { id: 's1', type: 'code', code: 'function main() { return 1; }', inputs: {} };
    const out = await execCode(step, { userId: 'u1', orgId: null, session: {} }, { steps: {} }, 'dry_run');
    assert.match(out.output.skipped, /sandbox is not installed/);
    assert.strictEqual(out.output._dryRun, true);
    await assert.rejects(
        () => execCode(step, { userId: 'u1', orgId: null, session: {} }, { steps: {} }, 'live'),
        /Code step unavailable/,
    );
});

test('a rehearsal SAYS when the data it ran on was invented upstream', async (t) => {
    // The code still runs — a syntax error, a null deref or a wrong branch is
    // worth finding whatever the data was. But a throw on a shape the real
    // data would never have had is a false alarm, and a false alarm that reads
    // like a real one is how people learn to ignore the rehearsal.
    const configStore = require('../stores/configStore');
    const shared = require('../core/automationRunner/shared');
    t.mock.method(configStore, 'getConfig', async (k) => (k === 'automation_code_step_enabled' ? true : null));
    t.mock.method(shared, 'stepInputsSynthetic', () => true);

    delete require.cache[require.resolve('../core/automationRunner/execOutbound')];
    const { execCode } = require('../core/automationRunner/execOutbound');
    const step = { id: 's1', type: 'code', code: 'function main() { return 1; }', inputs: {} };
    const out = await execCode(step, { userId: 'u1', orgId: null, session: {} }, { steps: {} }, 'dry_run');
    assert.strictEqual(out.output._dryRunSyntheticInputs, true);
    // It still ran — the label is a caveat, not a refusal.
    assert.strictEqual(out.output.result, 1);
    delete require.cache[require.resolve('../core/automationRunner/execOutbound')];
});

test('real data carries no such caveat', async (t) => {
    const configStore = require('../stores/configStore');
    t.mock.method(configStore, 'getConfig', async (k) => (k === 'automation_code_step_enabled' ? true : null));

    const { execCode } = require('../core/automationRunner/execOutbound');
    const step = { id: 's1', type: 'code', code: 'function main() { return 1; }', inputs: {} };
    const out = await execCode(step, { userId: 'u1', orgId: null, session: {} }, { steps: {} }, 'dry_run');
    assert.strictEqual(out.output._dryRunSyntheticInputs, undefined);
});

test('a LIVE run carries neither label', async (t) => {
    const configStore = require('../stores/configStore');
    t.mock.method(configStore, 'getConfig', async (k) => (k === 'automation_code_step_enabled' ? true : null));

    const { execCode } = require('../core/automationRunner/execOutbound');
    const step = { id: 's1', type: 'code', code: 'function main() { return 1; }', inputs: {} };
    const out = await execCode(step, { userId: 'u1', orgId: null, session: {} }, { steps: {} }, 'live');
    assert.strictEqual(out.output._dryRun, undefined);
    assert.strictEqual(out.output.wouldHaveCalled, undefined);
});

// ── 5. On by default ────────────────────────────────────────────────────────

test('a LIVE code step runs with no config at all, for an org with no beta', async (t) => {
    // Code steps used to need a platform flag written as true AND the org
    // beta `ai_code_execution`. Nothing in the product wrote either, so a
    // fresh install refused every code step. Now there is no switch and no
    // org question.
    const configStore = require('../stores/configStore');
    const beta = require('../core/entitlements/betaFeatures');
    t.mock.method(configStore, 'getConfig', async () => null);
    t.mock.method(beta, 'orgHasBetaFeature', async () => { throw new Error('the org beta must not be asked'); });

    const { execCode } = require('../core/automationRunner/execOutbound');
    const step = {
        id: 's1', type: 'code', code: 'function main(i) { return { sum: i.a + i.b }; }',
        inputs: { a: { kind: 'literal', value: 2 }, b: { kind: 'literal', value: 40 } },
    };
    const out = await execCode(step, { userId: 'u1', orgId: 'org-without-betas', session: {} }, { steps: {} }, 'live');
    assert.deepStrictEqual(out.output.result, { sum: 42 });
});
