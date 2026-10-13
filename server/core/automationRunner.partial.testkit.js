/**
 * Shared harness for the runPartial() suites (automationRunner.partial.*.test.js):
 * an in-memory automationStore plus stubs for the runner's heavy load-time
 * dependencies, so pure in-process `set` / `layer_output` / `loop` steps run
 * deterministically (no LLM / tool / sandbox / DB) and `node --test` can exit.
 *
 *   const { runner, runs, runStepsByRun, makeRun, storeStub, reset } = installPartialRunHarness();
 *
 * `getRunsForAutomation` overrides the store's default (every run recorded in
 * this harness for the automation, most recently created first).
 */

function stub(modPath, exportsObj) {
    const resolved = require.resolve(modPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

function installPartialRunHarness({ getRunsForAutomation } = {}) {
    const runs = new Map();          // runId -> run row
    const runStepsByRun = new Map(); // runId -> [step row]
    let runSeq = 0;

    function makeRun({ automationId, version, userId, triggerKind, triggerPayload, mode, parentRunId }) {
        const id = `run-${++runSeq}`;
        const row = {
            id, automationId, version, userId, triggerKind,
            triggerPayload: triggerPayload || null, mode, status: 'queued',
            startedAt: new Date().toISOString(), finishedAt: null, durationMs: null,
            error: null, summary: null, parentRunId: parentRunId ?? null,
            cancelRequested: false, awaitingStepId: null, approvalToken: null,
            awaitingStepExpiresAt: null, errorClass: null, handledErrorCount: 0,
        };
        runs.set(id, row);
        runStepsByRun.set(id, []);
        return row;
    }

    const storeStub = {
        initDB: async () => {},
        createRun: async (args) => makeRun(args),
        getRun: async (id) => runs.get(id) || null,
        updateRun: async (id, updates) => {
            const r = runs.get(id);
            if (!r) return false;
            Object.assign(r, updates);
            return true;
        },
        // Most-recently-created run for this automation first — lets a test seed a
        // "prior run" whose recorded call_layer input becomes the layer's input.
        getRunsForAutomation: getRunsForAutomation || (async (automationId, { limit = 50 } = {}) =>
            [...runs.values()]
                .filter(r => r.automationId === automationId)
                .reverse()
                .slice(0, limit)),
        getRunSteps: async (runId) => (runStepsByRun.get(runId) || []).slice(),
        recordRunStep: async (rec) => {
            const list = runStepsByRun.get(rec.runId);
            if (!list) return;
            const existing = list.find(s => s.stepId === rec.stepId && s.attempts === (rec.attempts ?? 1));
            const row = {
                runId: rec.runId,
                stepId: rec.stepId,
                parentStepId: rec.parentStepId ?? null,
                stepType: rec.stepType,
                attempts: rec.attempts ?? 1,
                status: rec.status,
                startedAt: rec.startedAt ?? null,
                finishedAt: rec.finishedAt ?? null,
                input: rec.input ?? null,
                output: rec.output ?? null,
                error: rec.error ?? null,
                errorClass: rec.errorClass ?? null,
                branchIndex: rec.branchIndex ?? null,
            };
            if (existing) Object.assign(existing, row);
            else list.push(row);
        },
        markRunning: async () => {},
        releaseAutomation: async () => {},
        resetAttempts: async () => {},
        updateAutomation: async () => {},
        requestCancelRun: async () => null,
    };

    stub('../stores/automationStore', storeStub);
    stub('../stores/userStore', { getUser: async () => null, getOrganization: async () => null });
    stub('../stores/configStore', { getConfig: async () => null, setConfig: async () => {} });
    stub('../stores/notificationStore', { createNotification: async () => {} });
    // Heavy load-time deps the runner pulls in. Mocking them keeps the process
    // from holding open a DB pool / pricing-fetch interval, so `node --test`
    // can exit. The steps under test live inside the runner itself and don't
    // touch any of these.
    stub('../db', { pool: {} });
    stub('./aiAgent', { getProviderForModel: async () => null });
    stub('./providers', { getAdapter: () => ({}) });
    stub('../automation/codeSandbox', { run: async () => ({}) });

    process.env.AUTOMATION_AUTH_LEGACY = '0';
    process.env.NODE_ENV = 'test';

    const runner = require('./automationRunner');

    function reset() { runs.clear(); runStepsByRun.clear(); runSeq = 0; }

    return { runner, runs, runStepsByRun, makeRun, storeStub, reset };
}

module.exports = { installPartialRunHarness };
