// @typecheck noImplicitAny
'use strict';

/**
 * An in-memory stand-in for the run side of stores/automationStore, for the
 * runner suites that execute a whole automation without a database.
 *
 *   const mem = makeMemoryRunStore();
 *   Object.assign(storeStub, mem.methods);       // or: const storeStub = { ...mem.methods };
 *   beforeEach(mem.reset);
 *   mem.automation = myAutomation;               // what getAutomation hands back
 *
 * `runs`, `stepsByRun`, `updateRunCalls` and `fullCopies` are the live
 * collections; `reset` empties them in place, so a destructured reference stays
 * valid.
 */

function makeMemoryRunStore() {
    /** @type {Map<string, any>} */
    const runs = new Map();
    /** @type {Map<string, any[]>} runId → [recordRunStep args] */
    const stepsByRun = new Map();
    /** @type {Array<{ id: string, updates: any }>} */
    const updateRunCalls = [];
    // The kept full copies of truncated outputs (automation_run_full_outputs),
    // keyed `runId|stepId|attempts`.
    /** @type {Map<string, any>} */
    const fullCopies = new Map();
    const mem = { runs, stepsByRun, updateRunCalls, fullCopies, automation: /** @type {any} */ (null), seq: 0 };

    /**
     * @param {{ automationId: string, version?: number, userId: string, triggerKind: string, triggerPayload?: unknown,
     *           mode?: string, parentRunId?: string | null, rootRunId?: string | null }} args
     */
    function makeRun({ automationId, version, userId, triggerKind, triggerPayload, mode, parentRunId, rootRunId }) {
        const id = `run-${++mem.seq}`;
        const row = {
            id, automationId, version, userId, triggerKind,
            triggerPayload: triggerPayload || null, mode, status: 'queued',
            startedAt: new Date().toISOString(), finishedAt: /** @type {string | null} */ (null), durationMs: /** @type {number | null} */ (null),
            // The journey: a run is its own root unless it CONTINUES a paused one.
            // Mirrors createRun's COALESCE($rootRunId, id).
            error: /** @type {string | null} */ (null), summary: /** @type {string | null} */ (null), parentRunId: parentRunId ?? null, rootRunId: rootRunId ?? id,
            cancelRequested: false, awaitingStepId: /** @type {string | null} */ (null), approvalToken: /** @type {string | null} */ (null),
            awaitingStepExpiresAt: /** @type {string | null} */ (null), errorClass: /** @type {string | null} */ (null), handledErrorCount: 0,
        };
        runs.set(id, row);
        stepsByRun.set(id, []);
        return row;
    }

    const methods = {
        initDB: async () => {},
        createRun: async (/** @type {any} */ args) => makeRun(args),
        getRun: async (/** @type {string} */ id) => runs.get(id) || null,
        updateRun: async (/** @type {string} */ id, /** @type {any} */ updates) => {
            updateRunCalls.push({ id, updates: { ...updates } });
            const r = runs.get(id);
            if (!r) return false;
            Object.assign(r, updates);
            return true;
        },
        getRunsForAutomation: async () => /** @type {unknown[]} */ ([]),
        getRunSteps: async (/** @type {string} */ id) => (stepsByRun.get(id) || []).map(s => ({ ...s })),
        // Upsert on (runId, stepId, attempts), exactly like the real store's
        // ON CONFLICT clause. The runner writes a 'running' row when a step starts
        // and the real row when it lands; a stub that merely appended kept both,
        // so a lookup by stepId found the placeholder instead of the result.
        recordRunStep: async (/** @type {any} */ row) => {
            const rows = stepsByRun.get(row.runId) || [];
            const i = rows.findIndex(r => r.stepId === row.stepId && r.attempts === row.attempts);
            if (i >= 0) rows[i] = { ...row }; else rows.push({ ...row });
        },
        markRunning: async () => true,
        releaseAutomation: async () => {},
        resetAttempts: async () => {},
        updateAutomation: async () => true,
        touchRunHeartbeat: async () => {},
        requestCancelRun: async () => /** @type {unknown} */ (null),
        getAutomation: async () => mem.automation,
        getRunFullOutput: async (/** @type {string} */ runId, /** @type {string} */ stepId, attempts = 1) => fullCopies.get(`${runId}|${stepId}|${attempts}`) ?? null,
    };

    function reset() {
        runs.clear();
        stepsByRun.clear();
        mem.seq = 0;
        updateRunCalls.length = 0;
        mem.automation = null;
        fullCopies.clear();
    }

    return Object.assign(mem, { methods, reset });
}

module.exports = { makeMemoryRunStore };
