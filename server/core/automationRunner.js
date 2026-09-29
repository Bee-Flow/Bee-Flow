/**
 * Automation Runner — DAG-based execution engine for the conversational
 * automation builder.
 *
 * Sibling of aiTaskRunner.js (which keeps running for prompt-only tasks).
 *
 *   - 60s tick: schedule trigger pickup (next_run_at <= NOW()).
 *   - 30s tick: app-event subscription renewal + polling.
 *   - executeAutomation(...) traverses the DAG and dispatches by step type.
 *
 * Per-org access is gated by the 'automations' beta feature (set in
 * the admin dashboard → Security → Beta). The runner always boots; due
 * rows owned by orgs without the beta are skipped each tick.
 *
 * Decomposed by domain: the implementations live in ./automationRunner/
 * (engine.js and its step modules, execution.js, resume.js, stepAsTool.js,
 * partialRuns.js, replaySeeding.js, scheduler/ticks.js, scheduler/reapers.js);
 * this file re-exports the same surface — same names, same function
 * references — so every existing `require('./automationRunner')` keeps
 * working unchanged.
 */

const { requestCancel } = require('./automationRunner/cancellation');

// §WS5 — execution primitives live in ./automationRunner/engine.js.
const {
    MAX_LAYER_DEPTH,
    COLLECTION_OP_MAX_ITEMS,
    INSTANCE_ID,
    resolveApprovalTtlMs,
    resolveNotificationPolicy,
    dispatchRunNotification,
    sendRunEmail,
    execAiStep,
    execCondition,
    execGuard,
    execTokenize,
    execUntokenize,
    execHttpRequest,
    ApprovalRequiredError,
    execApproval,
    FormInputRequiredError,
    execFormPage,
    execLoop,
    buildLinearEdges,
    execForEachStep,
    execCallLayer,
    execLayerOutput,
    loadBlockForRun,
    execCallBlock,
    execParseJson,
    execSwitch,
    execFilter,
    execDedupe,
    runDag,
} = require('./automationRunner/engine');

const { executeAutomation, runOrgFor, disabledPassThroughBranch } = require('./automationRunner/execution');
const { resumeFromStep } = require('./automationRunner/resume');
const { runStepAsTool } = require('./automationRunner/stepAsTool');
const { runPartial } = require('./automationRunner/partialRuns');
const { reapStuckAutomations } = require('./automationRunner/scheduler/reapers');
const { start, stop, isStopping, processDueAutomations } = require('./automationRunner/scheduler/ticks');

module.exports = {
    start,
    stop,
    isStopping,
    executeAutomation,
    processDueAutomations,
    reapStuckAutomations,
    requestCancel,
    resumeFromStep,
    runPartial,
    ApprovalRequiredError,
    FormInputRequiredError,
    INSTANCE_ID,
    // Exported for unit tests.
    execCallLayer,
    execCallBlock,
    execHttpRequest,
    runStepAsTool,
    loadBlockForRun,
    execLayerOutput,
    execLoop,
    buildLinearEdges,
    execForEachStep,
    execApproval,
    resolveApprovalTtlMs,
    execFormPage,
    MAX_LAYER_DEPTH,
    runDag,
    execFilter,
    execDedupe,
    execAiStep,
    execCondition,
    execGuard,
    execTokenize,
    execUntokenize,
    execSwitch,
    execParseJson,
    COLLECTION_OP_MAX_ITEMS,
    resolveNotificationPolicy,
    dispatchRunNotification,
    sendRunEmail,
    // Test seam: the org-resolution rule, which is invisible from the
    // outside — a run with the wrong answer still 'works', quietly unprotected.
    _runOrgFor: runOrgFor,
    // Test seam: which port a disabled brancher passes through. Invisible the
    // same way — the wrong answer is a run that ends early and still says
    // 'success'.
    _disabledPassThroughBranch: disabledPassThroughBranch,
};
