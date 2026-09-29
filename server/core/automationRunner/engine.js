/**
 * Automation execution engine (§WS5, extracted verbatim from automationRunner.js).
 * Holds the step handlers (exec*), the DAG walker (runDag), and their shared
 * helpers/constants. Leaf relative to the runner: it never requires
 * automationRunner.js — executeAutomation/resumeFromStep/runStepAsTool (which
 * call executeAutomation) stay in the runner and import from here.
 *
 * Decomposed by domain: the implementations live in the sibling modules
 * (shared.js, runDag.js, exec*.js, runNotifications.js, sessionResolution.js);
 * this file re-exports the same surface — same names, same function
 * references — so every existing `require('./automationRunner/engine')`
 * keeps working unchanged.
 */

const crypto = require('crypto');
require('../../stores/automationStore');
require('../../stores/configStore');
require('../../stores/notificationStore');
// modelResolver is required lazily inside execAiStep for the
// direct-chat-style tier resolution flow.
require('../aiAgent');
require('../providers');
require('../../db');
require('../privacy/errorSanitizer');
require('../automationErrors');
require('../../automation/bind');
require('../../utils/ssrfGuard');
require('../../automation/expr');
require('../../automation/approvalStages');
require('../../automation/sideEffectMap');
require('../../automation/outputSchemas');
require('../../automation/shapeCache');
require('../../automation/summarise');
require('../../automation/cron');
require('../../automation/codeSandbox');
require('../../automation/notificationDefaults');
require('../runEventBus');
// Feature C — http_request credential injection. MASK_VALUES is the Symbol-
// keyed mask array on runState: unreachable from templates/exprs/code steps
// (bind.js walks string paths only), folded into secretValuesFor below.
const { MASK_VALUES } = require('./httpAuth');
require('./cancellation');
// Safety/monitoring backbone — PII + regex guardrails + egress logging, mirroring
// the agent/direct-chat pipeline so automations stop bypassing those controls.
require('./safety');
require('../http/outboundProbe');
require('../../stores/usageStore');
require('../../stores/terminationStore');

const {
    RUNNER_INTERVAL_MS, POLLING_INTERVAL_MS, REAPER_INTERVAL_MS, RETENTION_INTERVAL_MS,
    MAX_CONCURRENT, MAX_LAYER_DEPTH, RUN_HARD_TIMEOUT_MS, MAX_RUN_TIMEOUT_MS,
    REAPER_FLOOR_MS, REAPER_BUFFER_MS, REAPER_MAX_ATTEMPTS,
    APPROVAL_DEFAULT_TTL_MS, APPROVAL_MAX_TTL_MS, resolveApprovalTtlMs,
    COLLECTION_OP_MAX_ITEMS, clampRunTimeout, cloneRunValue, secretValuesFor,
    isEmptyToolResult, isToolErrorResult, isEnvironmentToolError, enrichNextcloudError,
    buildAdjacency, nextEdgesFor,
    BRANCHER_TYPES, LOOP_ROOT_ID, PARALLEL_ROOT_ID,
} = require('./shared');
const { resolveNotificationPolicy, dispatchRunNotification, sendRunEmail } = require('./runNotifications');
const { withConnectorIdentity, resolveUserSession, mergeEnabled } = require('./sessionResolution');
const { execIntegrationAction, collectAiStepOutputFields, execAiStep } = require('./execAi');
const { execCondition, execWait, execStopError, execReturnToApp, execSwitch } = require('./execControl');
const { execGuard, execTokenize, execUntokenize } = require('./execPrivacy');
const { execNotification, execHttpRequest, execCode } = require('./execOutbound');
const {
    MAX_DOCUMENT_BYTES, DOCUMENT_TTL_MIN_DAYS, DOCUMENT_TTL_MAX_DAYS, DOCUMENT_TTL_DEFAULT_DAYS,
    safeDocumentName, execGenerateDocument,
} = require('./execDocument');
const { execFillDocument } = require('./execFillDocument');
const { execSlide, execPresentation } = require('./execPresentation');
const {
    ApprovalRequiredError, renderApprovalPrompt, renderApprovalExtras, execApproval,
    FORM_WAIT_DEFAULT_MS, FORM_WAIT_MIN_MS, FORM_WAIT_MAX_MS,
    resolveFormWaitMs, FormInputRequiredError, isRunPause, execFormPage,
} = require('./execApproval');
const {
    execParallel, execLoop, buildLinearEdges, execForEachStep,
    execCallLayer, execLayerOutput, callerCanUseBlock, loadBlockForRun, execCallBlock,
} = require('./execFlow');
const {
    execSet, MAX_SET_OPERATIONS,
    compileSetFields, applySetOperations, opRowId, opGroupId, opRename, opKeep, opRemove, opSort,
    execParseJson, MAX_PARSE_JSON_AI_SOURCE_CHARS, MAX_PARSE_JSON_FIELDS,
    resolveParseJsonSource, parseParseJsonSource, normaliseParseJsonFields,
    buildParseJsonAiTool, buildParseJsonAiMessages, applyParseJsonAiResult,
    applyParseJsonAiItems, resolveParseJsonItems, buildParseJsonRow,
} = require('./execData');
const { execDateTime } = require('./execDateTime');
const {
    resolveArrayRef, execFilter, execLimit, execDedupe, execAggregate, execSummarize,
} = require('./execCollections');
// Rows that outlive the run — the datatable step.
const { execDatatable } = require('./execDatatable');
const { execKnowledgeWrite } = require('./execKnowledgeWrite');
// Named, typed fields out of a piece of text — on the admin's extraction
// model, never the routine's tier.
const { execDataExtraction } = require('./execDataExtraction');
const { runDag } = require('./runDag');

// ── Run cancellation registry ───────────────────────────
//
// Maps runId → AbortController so the cancel endpoint can signal an
// in-flight run. The runner registers a controller on start, checks
// `signal.aborted` between dispatched steps, and cleans up on completion.
//
// Note: we still set `cancel_requested = TRUE` in the DB so a cancel
// issued against a run owned by a different runner pod is honoured on the
// next "between-steps" check (the DB flag is the cross-process signal,
// the AbortController is the in-process one).

/**
 * Resume a paused or failed run from a specific step. Loads the original
 * run + automation, rebuilds runState by replaying the persisted
 * automation_run_steps rows, then invokes runDag with `skipUntilStepId`
 * pointing at the resumption boundary. Used by:
 *   - approval-step approve/reject endpoint (skip past the paused step)
 *   - retry-from-step UI button (skip everything that already ran cleanly)
 *
 * The new execution is recorded as a CHILD run linked via parent_run_id
 * so the original lineage stays intact in the history.
 *
 * `decision` is the synthetic output assigned to the skipped step. For
 * approval steps that's typically `{approved: true, by: <userId>}`.
 */

// Stable per-process token. Identifies which runner instance currently
// owns a claimed row — useful for diagnostics and for the reaper's logs.
const INSTANCE_ID = `runner-${crypto.randomBytes(6).toString('hex')}`;


// ── Top-level executeAutomation ─────────────────────────


module.exports = { BRANCHER_TYPES, LOOP_ROOT_ID, PARALLEL_ROOT_ID, RUNNER_INTERVAL_MS, POLLING_INTERVAL_MS, REAPER_INTERVAL_MS, RETENTION_INTERVAL_MS, MAX_CONCURRENT, MAX_LAYER_DEPTH, RUN_HARD_TIMEOUT_MS, MAX_RUN_TIMEOUT_MS, REAPER_FLOOR_MS, REAPER_BUFFER_MS, REAPER_MAX_ATTEMPTS, APPROVAL_DEFAULT_TTL_MS, APPROVAL_MAX_TTL_MS, COLLECTION_OP_MAX_ITEMS, INSTANCE_ID, MASK_VALUES, resolveApprovalTtlMs, clampRunTimeout, cloneRunValue, secretValuesFor, resolveNotificationPolicy, dispatchRunNotification, sendRunEmail, withConnectorIdentity, resolveUserSession, mergeEnabled, isEmptyToolResult, isToolErrorResult, isEnvironmentToolError, enrichNextcloudError, buildAdjacency, nextEdgesFor, execIntegrationAction, collectAiStepOutputFields, execAiStep, execCondition, execGuard, execTokenize, execUntokenize, execNotification, execCode, execHttpRequest, execGenerateDocument, execFillDocument, execSlide, execPresentation, safeDocumentName, MAX_DOCUMENT_BYTES, DOCUMENT_TTL_MIN_DAYS, DOCUMENT_TTL_MAX_DAYS, DOCUMENT_TTL_DEFAULT_DAYS, ApprovalRequiredError, execApproval, renderApprovalPrompt, renderApprovalExtras, FormInputRequiredError, execFormPage, resolveFormWaitMs, isRunPause, FORM_WAIT_DEFAULT_MS, FORM_WAIT_MIN_MS, FORM_WAIT_MAX_MS, execParallel, execLoop, buildLinearEdges, execForEachStep, execCallLayer, execLayerOutput, callerCanUseBlock, loadBlockForRun, execCallBlock, execSet, MAX_SET_OPERATIONS, _setTest: { compileSetFields, applySetOperations, opRowId, opGroupId, opRename, opKeep, opRemove, opSort }, execParseJson, MAX_PARSE_JSON_AI_SOURCE_CHARS, MAX_PARSE_JSON_FIELDS, _parseJsonTest: { resolveParseJsonSource, parseParseJsonSource, normaliseParseJsonFields, buildParseJsonAiTool, buildParseJsonAiMessages, applyParseJsonAiResult, applyParseJsonAiItems, resolveParseJsonItems, buildParseJsonRow }, execDateTime, execWait, execStopError, execReturnToApp, execSwitch, resolveArrayRef, execFilter, execLimit, execDedupe, execAggregate, execSummarize, execDatatable, execKnowledgeWrite, execDataExtraction, runDag };
