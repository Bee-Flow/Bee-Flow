/**
 * The AI's dry run is shown while it runs, and the model hears only what
 * went wrong (owner, 2026-09-18: "laat de dry run zien, en alleen als daar
 * iets in fout gaat geef dat terug").
 *
 *   - chatStream installs a watcher on the draft BEFORE dispatching
 *     builder_request_dry_run, so `dryrun_started` — carrying the run's id —
 *     is on the wire while the tool is still running. The frontend turns it
 *     into the same 'running' stub a manual run gets, and the canvas follows
 *     the steps live;
 *   - the watcher is cleared once the call has landed, so a later tool cannot
 *     announce a run that is over;
 *   - the tool passes the runner an onRunCreated hook that fires the watcher
 *     (the runner is stubbed), and works without one — the MCP surface has no
 *     watcher to fire.
 *
 * Run: cd server && node --test --test-force-exit routes/ai/automationBuilder/chatStream.dryRunLive.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');

const { createBuilderStream, call } = require('../../../testUtils/builderStreamHarness');

const h = createBuilderStream();
after(() => h.restore());

test('the run is announced the moment it has a row — before the tool call returns', async () => {
    const seenWatcher = [];
    const run = await h.run({
        rounds: [
            { toolCalls: [call('builder_request_dry_run', {}), call('builder_summarise', {})] },
            { text: 'Klaar.' },
        ],
        onTool: async (name, _args, wrap) => {
            seenWatcher.push([name, typeof wrap._onDryRunStarted]);
            if (name === 'builder_request_dry_run') {
                await wrap._onDryRunStarted({ id: 'run_live_1', status: 'running', startedAt: 't0' });
                return { run: { id: 'run_live_1', status: 'success', startedAt: 't0', finishedAt: 't1' }, steps: [{ stepId: 's1', status: 'success' }] };
            }
            return { summary: 'Doet iets.' };
        },
    });

    assert.deepStrictEqual(run.first('dryrun_started'), {
        run: { id: 'run_live_1', status: 'running', startedAt: 't0' },
    });
    const names = run.names;
    assert.ok(names.indexOf('dryrun_started') < names.indexOf('tool_call'),
        'the canvas starts following the run while the tool is still going');
    assert.deepStrictEqual(run.last('dryrun'), {
        run: { id: 'run_live_1', status: 'success', startedAt: 't0', finishedAt: 't1' },
        steps: [{ stepId: 's1', status: 'success' }],
    }, 'and the finished run follows, with every step row');

    assert.deepStrictEqual(seenWatcher, [['builder_request_dry_run', 'function'], ['builder_summarise', 'object']],
        'the watcher is installed for the dry run only, and cleared once the call landed');
});

test('builder_request_dry_run hands the runner an onRunCreated hook that fires the draft\'s watcher', async () => {
    const runnerPath = require.resolve('../../../core/automationRunner');
    const seen = [];
    const fakeRun = { id: 'run_live_1', status: 'success', startedAt: 't0', finishedAt: 't1' };
    require.cache[runnerPath] = {
        id: runnerPath, filename: runnerPath, loaded: true,
        exports: {
            async executeAutomation(automation, opts) {
                seen.push(opts);
                if (typeof opts.onRunCreated === 'function') await opts.onRunCreated({ id: fakeRun.id, status: 'running', startedAt: 't0' });
                return fakeRun;
            },
        },
    };
    const storePath = require.resolve('../../../stores/automationStore');
    const origStore = require.cache[storePath];
    require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: { async getRunSteps() { return [{ stepId: 's1', status: 'success', output: { count: 1 } }]; } } };
    // The persistence layer is stubbed the way builderTools.test.js does it: a
    // draft that is already persisted needs no store round trip here.
    const persistencePath = require.resolve('../../../automation/builderTools/persistence');
    const origPersistence = require.cache[persistencePath];
    require.cache[persistencePath] = { id: persistencePath, filename: persistencePath, loaded: true, exports: { ...(origPersistence ? origPersistence.exports : require(persistencePath)), async persistDraft(wrap) { return { id: wrap.automationId || 'auto_1', definition: wrap.def }; } } };
    delete require.cache[require.resolve('../../../automation/builderTools')];
    try {
        const { applyToolCall } = require('../../../automation/builderTools');
        const announced = [];
        const wrap = {
            userId: 'u1', automationId: 'auto_1', title: 'T', description: '',
            def: { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [], edges: [] },
            _onDryRunStarted: (run) => announced.push(run),
        };
        const out = await applyToolCall('builder_request_dry_run', {}, wrap);
        assert.equal(seen.length, 1, 'the runner ran once');
        assert.equal(typeof seen[0].onRunCreated, 'function', 'the hook was passed');
        assert.deepEqual(announced, [{ id: 'run_live_1', status: 'running', startedAt: 't0' }], 'the watcher heard the run as soon as it existed');
        assert.equal(out.run.id, 'run_live_1');
        assert.equal(out.steps.length, 1);
        // No watcher (the MCP surface): no hook, no error.
        const quiet = await applyToolCall('builder_request_dry_run', {}, { ...wrap, _onDryRunStarted: undefined });
        assert.equal(seen[1].onRunCreated, null);
        assert.equal(quiet.run.id, 'run_live_1');
    } finally {
        delete require.cache[runnerPath];
        if (origStore) require.cache[storePath] = origStore; else delete require.cache[storePath];
        if (origPersistence) require.cache[persistencePath] = origPersistence; else delete require.cache[persistencePath];
        delete require.cache[require.resolve('../../../automation/builderTools')];
    }
});

test('through the facade, a staged dry run never reaches persistDraft and runs the staged steps', async () => {
    const runnerPath = require.resolve('../../../core/automationRunner');
    const ran = [];
    require.cache[runnerPath] = {
        id: runnerPath, filename: runnerPath, loaded: true,
        exports: { async executeAutomation(automation, opts) { ran.push({ definition: automation.definition, mode: opts.mode }); return { id: 'run_staged', status: 'success' }; } },
    };
    const storePath = require.resolve('../../../stores/automationStore');
    const origStore = require.cache[storePath];
    require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: {
        async getAutomation(id) { return { id, userId: 'u1', version: 2, definition: { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [], edges: [] } }; },
        async getRunSteps() { return []; },
    } };
    const persistencePath = require.resolve('../../../automation/builderTools/persistence');
    const origPersistence = require.cache[persistencePath];
    const persisted = [];
    require.cache[persistencePath] = { id: persistencePath, filename: persistencePath, loaded: true, exports: { ...(origPersistence ? origPersistence.exports : require(persistencePath)), async persistDraft(wrap) { persisted.push(wrap.automationId); return { id: wrap.automationId, definition: wrap.def }; } } };
    delete require.cache[require.resolve('../../../automation/builderTools')];
    try {
        const { applyToolCall } = require('../../../automation/builderTools');
        const def = { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [{ id: 'proposed', type: 'set' }], edges: [] };
        const out = await applyToolCall('builder_request_dry_run', {}, { userId: 'u1', automationId: 'auto_1', title: 'T', description: '', def, _stagedDryRun: true });
        assert.equal(out.run.id, 'run_staged');
        assert.deepEqual(persisted, [], 'a proposal is not saved to be run');
        assert.equal(ran[0].mode, 'dry_run');
        assert.deepEqual(ran[0].definition.steps.map(s => s.id), ['proposed']);
        await applyToolCall('builder_request_dry_run', {}, { userId: 'u1', automationId: 'auto_1', title: 'T', description: '', def });
        assert.deepEqual(persisted, ['auto_1'], 'a direct build still saves first');
    } finally {
        delete require.cache[runnerPath];
        if (origStore) require.cache[storePath] = origStore; else delete require.cache[storePath];
        if (origPersistence) require.cache[persistencePath] = origPersistence; else delete require.cache[persistencePath];
        delete require.cache[require.resolve('../../../automation/builderTools')];
    }
});

test('a staged dry run with a write on a PROPOSED table synthesises the step, makes no datatable store call and says the table is not created', async () => {
    const { execDatatable } = require('../../../core/automationRunner/execDatatable');
    const runnerPath = require.resolve('../../../core/automationRunner');
    const rows = [];
    require.cache[runnerPath] = {
        id: runnerPath, filename: runnerPath, loaded: true,
        exports: {
            // The runner, reduced to what matters here: every datatable step goes
            // through the real executor in dry-run mode.
            async executeAutomation(automation) {
                for (const step of automation.definition.steps.filter((s) => s.type === 'datatable')) {
                    const r = await execDatatable(step, { userId: 'u1' }, { steps: {}, trigger: { output: { email: 'a@b.c' } } }, 'dry_run');
                    rows.push({ stepId: step.id, status: 'success', output: r.output });
                }
                return { id: 'run_pending', status: 'success' };
            },
        },
    };
    const storePath = require.resolve('../../../stores/automationStore');
    const origStore = require.cache[storePath];
    require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: {
        async getAutomation(id) { return { id, userId: 'u1', definition: { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [], edges: [] } }; },
        async getRunSteps() { return rows; },
    } };
    // A table that does not exist must not be looked up anywhere.
    const touched = [];
    const guard = (name) => new Proxy({}, { get: (_t, prop) => () => { touched.push(`${name}.${String(prop)}`); throw new Error('the store must not be touched'); } });
    const dtStore = require.resolve('../../../stores/datatableStore');
    const dbStore = require.resolve('../../../stores/datatableDbStore');
    const origDt = require.cache[dtStore]; const origDb = require.cache[dbStore];
    require.cache[dtStore] = { id: dtStore, filename: dtStore, loaded: true, exports: guard('datatableStore') };
    require.cache[dbStore] = { id: dbStore, filename: dbStore, loaded: true, exports: guard('datatableDbStore') };
    delete require.cache[require.resolve('../../../automation/builderTools')];
    try {
        const { applyToolCall } = require('../../../automation/builderTools');
        const def = {
            trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, edges: [],
            steps: [
                { id: 'w', type: 'datatable', op: 'add_row', datatableId: 'pending:1', datatableKey: 'facturen', values: { email: { kind: 'ref', path: 'trigger.output.email' } } },
                { id: 'r', type: 'datatable', op: 'find_rows', datatableId: 'pending:1', datatableKey: 'facturen' },
            ],
        };
        const out = await applyToolCall('builder_request_dry_run', {}, { userId: 'u1', automationId: 'auto_1', title: 'T', description: '', def, _stagedDryRun: true });
        assert.deepEqual(touched, [], 'no datatable store call');
        const [write, read] = out.steps;
        assert.deepEqual(write.output.row, { email: 'a@b.c' }, 'the write returns what it would have written');
        assert.equal(write.output._pendingTable, 'pending:1');
        assert.deepEqual([read.output.rows, read.output.found], [[], false], 'a read of a new table is empty');
        assert.match(write._hint.note, /table not created yet: a preview reads no rows and writes nothing/);
    } finally {
        delete require.cache[runnerPath];
        if (origStore) require.cache[storePath] = origStore; else delete require.cache[storePath];
        if (origDt) require.cache[dtStore] = origDt; else delete require.cache[dtStore];
        if (origDb) require.cache[dbStore] = origDb; else delete require.cache[dbStore];
        delete require.cache[require.resolve('../../../automation/builderTools')];
    }
});
