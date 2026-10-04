/**
 * `onRunFinished` — the hook the app-event fan-out and the playbook stage
 * runner wait on.
 *
 * A caller that wants to know a run ENDED gets told after the run row is
 * terminal on disk, never before: the first thing such a caller does is read
 * the row back, and a hook that fires early hands it "running". It also may
 * not take the run down with it — a throwing listener is the listener's
 * problem, not the automation's.
 *
 * The runner is driven here with the automation store cut at the require seam,
 * so what the hook is handed and what order it happens in are the answers of
 * the shipped code. (This file used to read execution.js and resume.js as
 * text, on the belief that the runner could not be loaded without a database.
 * It can.)
 *
 * Run: cd server && node --test --test-force-exit core/automationRunner/execution.onRunFinished.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');

process.env.NODE_ENV = 'test';

/** Every write the runner made, in order. */
let ops = [];
const storeStub = {
    createRun: async (row) => { const r = { id: 'run-1', ...row }; ops.push({ op: 'createRun', row: r }); return r; },
    updateRun: async (id, patch) => { ops.push({ op: 'updateRun', id, patch }); return { id, ...patch }; },
    getRun: async (id) => {
        // The paused row a resume starts from — and, once the run is under
        // way, what a listener reading the row back would see.
        const last = [...ops].reverse().find(o => o.op === 'updateRun');
        if (last) return { id, ...last.patch };
        return { id, automationId: 'a1', status: 'awaiting_approval', triggerKind: 'manual', rootRunId: null, rootStepId: null };
    },
    getAutomation: async () => AUTOMATION,
    getRunSteps: async () => [],
    getRunStepsForRuns: async () => [],
    getRunsForAutomation: async () => [],
    markRunning: async () => true,
    advanceSchedule: async () => {},
    getRunTokenMap: async () => ({}),
    recordRunStep: async () => ({ id: 'step-1' }),
    releaseAutomation: async () => {},
    resetAttempts: async () => {},
    touchAutomationRunning: async () => {},
    touchRunHeartbeat: async () => {},
    updateAutomation: async () => {},
};

// The store is replaced wholesale: Node caches a relative resolution per
// (directory, request), so a parent-scoped stub reaches only whichever module
// in core/automationRunner/ asked for it first.
const storePath = require.resolve('../../stores/automationStore');
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: storeStub };

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /automationRunner[\\/]resume\.js$/.test(parent.filename) && request === './execution') {
        return 'mock:on-run-finished:execution';
    }
    return originalResolve.call(this, request, parent, ...rest);
};
test.after(() => { Module._resolveFilename = originalResolve; });

// By absolute path on purpose: Node caches a relative resolution per
// (directory, request), and resume.js sits in this very directory and asks
// for './execution' too — a plain relative require here would hand it the
// real engine out of that cache, behind the recorder below.
const { executeAutomation } = require(path.join(__dirname, 'execution.js'));

// resume.js is asked a narrower question — does it hand the hook on to the
// run it starts — so its one collaborator is recorded rather than run. The
// engine itself is exercised by everything above.
const resumeStarts = [];
const execId = 'mock:on-run-finished:execution';
require.cache[execId] = {
    id: execId, filename: execId, loaded: true,
    exports: {
        executeAutomation: async (automation, options) => {
            resumeStarts.push({ automation, options });
            if (typeof options.onRunCreated === 'function') await options.onRunCreated({ id: 'child-run' });
            if (typeof options.onRunFinished === 'function') await options.onRunFinished({ id: 'child-run' }, { status: 'success' });
            return { id: 'child-run', status: 'success' };
        },
    },
};
const { resumeFromStep } = require('./resume');

const AUTOMATION = {
    id: 'a1', name: 'test automation', user_id: 'u1', organization_id: null, is_active: true,
    definition: { trigger: { type: 'manual' }, steps: [{ id: 's1', type: 'set', fields: { greeting: 'hi' } }] },
};

function run(opts = {}) {
    ops = [];
    return executeAutomation({ ...AUTOMATION, definition: { ...AUTOMATION.definition, ...(opts.definition || {}) } }, {
        triggerKind: 'manual',
        ...opts.options,
    });
}

/** The index of the last updateRun that wrote a terminal status. */
function terminalIndex() {
    return ops.findLastIndex(o => o.op === 'updateRun' && o.patch && o.patch.finishedAt);
}

test('a finished run tells the hook its final status, after the row is terminal', async () => {
    const seen = [];
    await run({ options: { onRunFinished: (r, info) => { seen.push({ r, info, at: ops.length }); } } });

    assert.strictEqual(seen.length, 1, 'the hook must fire exactly once');
    assert.strictEqual(seen[0].r.id, 'run-1', 'the hook gets the run it is about');
    assert.ok(['success', 'error'].includes(seen[0].info.status), `unexpected status ${seen[0].info.status}`);

    const terminal = terminalIndex();
    assert.ok(terminal > -1, 'the run row never reached a terminal status');
    assert.ok(seen[0].at > terminal,
        'the hook fired before the terminal updateRun — a listener that reads the row back sees "running"');
    assert.strictEqual(ops[terminal].patch.status, seen[0].info.status,
        'the status the hook is told must be the one written to the row');
});

test('a listener that throws does not take the run down with it', async () => {
    const result = await run({
        options: { onRunFinished: () => { throw new Error('the listener exploded'); } },
    });
    assert.ok(result && result.id === 'run-1', 'the run must still return its row');
    assert.ok(terminalIndex() > -1, 'and the row must still be terminal');
});

test('a listener that rejects is awaited and swallowed the same way', async () => {
    const result = await run({
        options: { onRunFinished: async () => { throw new Error('async listener exploded'); } },
    });
    assert.ok(result && result.id === 'run-1');
    assert.ok(terminalIndex() > -1);
});

test('no hook is not an error — the ordinary run is unchanged', async () => {
    const withHook = await run({ options: { onRunFinished: () => {} } });
    const opsWithHook = ops.map(o => o.op).join(',');
    const without = await run();
    assert.deepStrictEqual(ops.map(o => o.op).join(','), opsWithHook,
        'passing a hook must not change what the runner writes');
    assert.strictEqual(without.id, withHook.id);
});

test('onRunCreated still fires first, and before the run is terminal', async () => {
    const order = [];
    await run({
        options: {
            onRunCreated: () => order.push({ hook: 'created', at: ops.length }),
            onRunFinished: () => order.push({ hook: 'finished', at: ops.length }),
        },
    });
    assert.deepStrictEqual(order.map(o => o.hook), ['created', 'finished']);
    assert.ok(order[0].at <= terminalIndex(), 'the created hook fires while the run is still open');
});

test('a resume forwards both hooks to the child run it starts', async () => {
    ops = [];
    resumeStarts.length = 0;
    const seen = [];
    const created = [];
    await resumeFromStep('run-paused', 's1', {
        userId: 'u1',
        onRunCreated: (r) => created.push(r.id),
        onRunFinished: (r, info) => seen.push(info),
    });

    assert.strictEqual(resumeStarts.length, 1, 'the resume must start exactly one run');
    assert.strictEqual(typeof resumeStarts[0].options.onRunFinished, 'function',
        'resumeFromStep must pass the hook on — the caller that paused the run is the one waiting for it');
    assert.deepStrictEqual(seen, [{ status: 'success' }]);
    assert.deepStrictEqual(created, ['child-run']);
    assert.strictEqual(resumeStarts[0].options.parentRunId, 'run-paused',
        'and the child run must know which run it continues');
});

test('a resume without hooks starts the run all the same', async () => {
    ops = [];
    resumeStarts.length = 0;
    await resumeFromStep('run-paused', 's1', { userId: 'u1' });
    assert.strictEqual(resumeStarts.length, 1);
    assert.strictEqual(resumeStarts[0].options.onRunFinished, null);
});
