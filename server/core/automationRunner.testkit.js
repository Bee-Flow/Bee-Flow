// @typecheck
/**
 * Test kit for suites that drive the REAL automationRunner with its stores
 * stubbed in the require cache: an in-memory automationStore whose runs are
 * plain rows shaped like rowToRun (stores/automationStore/rowMappers.js), so
 * NO `lastOutput` key, plus null userStore / configStore / notificationStore.
 *
 *   const { runs, resetRuns, stub } = installRunnerStoreStubs();
 *   // more stub('./automationRunner/x', {...}) here if needed
 *   const runner = require('./automationRunner');
 *
 * Install BEFORE the first require of the runner. It also registers the
 * feature ports boot registers for the server and sets the test env.
 */

// The runner reaches automation/, integrations/ and services/ through
// core/automationRunner/featurePorts.js; boot registers these for the server.
require('../automation/runnerPorts');
require('../integrations/runnerPorts');
require('../services/runnerPorts');

/**
 * Put `exportsObj` in the require cache under `modPath` (resolved from core/).
 * @param {string} modPath
 */
function stub(modPath, exportsObj) {
    const resolved = require.resolve(modPath);
    require.cache[resolved] = /** @type {any} */ ({ id: resolved, filename: resolved, loaded: true, exports: exportsObj });
}

function installRunnerStoreStubs() {
    const runs = new Map();
    let runSeq = 0;

    function makeRun({ automationId, version, userId, triggerKind, triggerPayload, mode, parentRunId }) {
        const id = `run-${++runSeq}`;
        // Deliberately mirrors rowToRun's shape: NO lastOutput key.
        const row = {
            id, automationId, version, userId, triggerKind,
            triggerPayload: triggerPayload || null, mode, status: 'queued',
            startedAt: new Date().toISOString(), finishedAt: null, durationMs: null,
            error: null, summary: null, parentRunId: parentRunId ?? null,
            cancelRequested: false, awaitingStepId: null, approvalToken: null,
            awaitingStepExpiresAt: null, errorClass: null, handledErrorCount: 0,
        };
        runs.set(id, row);
        return row;
    }

    const storeStub = {
        initDB: async () => {},
        createRun: async (args) => makeRun(args),
        getRun: async (id) => (runs.has(id) ? { ...runs.get(id) } : null),
        updateRun: async (id, updates) => {
            const r = runs.get(id);
            if (!r) return false;
            Object.assign(r, updates);
            return true;
        },
        getRunsForAutomation: async () => [],
        getRunSteps: async () => [],
        recordRunStep: async () => {},
        markRunning: async () => true,
        releaseAutomation: async () => {},
        resetAttempts: async () => {},
        updateAutomation: async () => true,
        touchRunHeartbeat: async () => {},
        requestCancelRun: async () => null,
        getAutomation: async () => null,
    };

    stub('../stores/automationStore', storeStub);
    stub('../stores/userStore', { getUser: async () => null, getOrganization: async () => null });
    stub('../stores/configStore', { getConfig: async () => null, setConfig: async () => {} });
    stub('../stores/notificationStore', { createNotification: async () => {} });

    process.env.AUTOMATION_AUTH_LEGACY = '0';
    process.env.NODE_ENV = 'test';

    /** Empty the run table and restart the ids at run-1. */
    const resetRuns = () => { runs.clear(); runSeq = 0; };
    return { runs, resetRuns, stub, storeStub };
}

module.exports = { installRunnerStoreStubs, stub };

/**
 * What createRun is called with.
 * @typedef {{ automationId?: string, version?: number, userId?: string, triggerKind?: string, triggerPayload?: unknown, mode?: string, parentRunId?: string|null }} FakeRunArgs
 */

/**
 * An in-memory run row, shaped like rowToRun's output.
 * @typedef {{ id: string, automationId: string, version: number, userId: string, triggerKind: string,
 *   triggerPayload: unknown, mode: string, status: string, startedAt: string, finishedAt: string|null,
 *   durationMs: number|null, error: string|null, summary: unknown, parentRunId: string|null,
 *   cancelRequested: boolean, awaitingStepId: string|null, approvalToken: string|null,
 *   awaitingStepExpiresAt: string|null, errorClass: string|null, handledErrorCount: number,
 *   rootRunId?: string, [key: string]: unknown }} FakeRun
 */
