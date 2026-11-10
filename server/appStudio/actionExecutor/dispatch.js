// @typecheck
/**
 * App Studio action executor — the DISPATCHER (extracted verbatim from
 * actionExecutor.js). Validates the step, routes it to the module for its
 * family and maps every thrown error onto the client-safe step result.
 */

'use strict';

const path = require('node:path');
const { DATA_MUTATING_STEP_KINDS } = require('../componentSpecs');
const { stepMetaOf } = require('../componentSpecs/stepRegistry');
const { findTable, buildServerScope, resolveBinding, writeViewer } = require('./shared');
const { writeRecord, createRecord, updateRecord, deleteRecord } = require('./records');
const { runAutomationStep } = require('./automationBridge');
const { requestApprovalStep } = require('./approvalStep');
const { aiExtractStep, aiGenerateStep, kbQueryStep } = require('./aiSteps');
const { sendEmailStep } = require('./emailStep');
const { generateFileStep } = require('./fileStep');
const { fillDocumentStep } = require('./documentStep');
const { generatePresentationStep } = require('./presentationStep');
const { redactPdfStep } = require('./redactStep');

// Required by a variable path, like core/versioning/stats.js does its bundle:
// agent-hub's typecheck follows literal requires into this file's imports, and
// a .mts module needs compiler options that check does not run with.
const COPY_DOCUMENT_STEP = './copyDocumentStep.mts';
const STEP_ERRORS = './stepErrors.mts';
const TRANSACTION_STEP = './transactionStep.mts';
const BULK_RECORDS = './bulkRecords.mts';
const KB_LOG_STEPS = './kbLogSteps.mts';

/**
 * The executor of a step kind of the registry (componentSpecs/steps/<kind>.js with
 * `handler: 'file'`): `runStep` of actionExecutor/steps/<kind>.mts. Null for every other
 * kind. The kind is a file name the registry checked at load, never request text.
 *
 * @param {string} kind
 * @param {(kind: string) => { side?: string, handler?: string } | null} [metaOf]
 * @param {string} [dir]
 * @returns {((app: unknown, model: unknown, step: unknown, ctx: unknown) => Promise<unknown>) | null}
 */
function fileStepHandler(kind, metaOf = stepMetaOf, dir = path.join(__dirname, 'steps')) {
    const meta = metaOf(kind);
    if (!meta || meta.side !== 'server' || meta.handler !== 'file') return null;
    const mod = require(path.join(dir, `${kind}.mts`));
    if (typeof mod.runStep !== 'function') throw new Error(`Step module ${kind}.mts does not export runStep`);
    return mod.runStep;
}

// ── Public entry ────────────────────────────────────────────────────

/**
 * Execute ONE server-authoritative data step, ONE attempt. Never throws: every
 * failure is a `{ ok:false, error, code, retryable }` whose `error` is the real
 * reason (stepErrors.mts). Retries and onError handlers live in the walkers.
 */
async function executeDataStep(app, model, step, ctx = {}) {
    if (!app || typeof app !== 'object' || !app.id || !app.userId) {
        return { ok: false, error: 'App unavailable' };
    }
    if (!step || typeof step !== 'object' || typeof step.kind !== 'string') {
        return { ok: false, error: 'Invalid step' };
    }
    // Defense in depth — the route already enforces this, but a client-only
    // kind must never execute here.
    if (!DATA_MUTATING_STEP_KINDS.includes(step.kind)) {
        return { ok: false, error: `Step "${step.kind}" is not a server step` };
    }
    return withRetryFlag(await runStepKind(app, model, step, ctx));
}

/**
 * A failure a step module RETURNED (not threw) is a deterministic refusal
 * ("Record not found", "Table not found"): trying again cannot help, so it
 * says so unless the module said otherwise.
 *
 * @param {Record<string, unknown> | null | undefined} res
 */
function withRetryFlag(res) {
    if (res && typeof res === 'object' && res.ok === false && typeof res.retryable !== 'boolean') return { ...res, retryable: false };
    return res;
}

/** The step's module, one attempt; a throw becomes its real reason (stepErrors.mts). */
async function runStepKind(app, model, step, ctx) {
    try {
        switch (step.kind) {
            case 'create_record': return await createRecord(app, model, step, ctx);
            // With a `filter` instead of a recordId: every matching row up to `limit` (bulkRecords.mts).
            case 'update_record': return step.filter != null
                ? await require(BULK_RECORDS).bulkUpdateRecordStep(app, model, step, ctx)
                : await updateRecord(app, model, step, ctx);
            case 'delete_record': return step.filter != null
                ? await require(BULK_RECORDS).bulkDeleteRecordStep(app, model, step, ctx)
                : await deleteRecord(app, model, step, ctx);
            case 'run_automation': return await runAutomationStep(app, step, ctx);
            case 'request_approval': return await requestApprovalStep(app, model, step, ctx);
            case 'ai_extract': return await aiExtractStep(app, model, step, ctx);
            case 'ai_generate': return await aiGenerateStep(app, model, step, ctx);
            case 'kb_query': return await kbQueryStep(app, model, step, ctx);
            case 'send_email': return await sendEmailStep(app, model, step, ctx);
            case 'generate_file': return await generateFileStep(app, model, step, ctx);
            // Its sibling: a DESIGNED document (invoice/quote/letter) filled
            // with this run's values, rendered to a PDF in the same store and
            // returning the same attachment descriptor.
            case 'fill_document': return await fillDocumentStep(app, model, step, ctx);
            // The third file-producing sibling: slides (an outline, a JSON
            // deck, table rows) → a .pptx / PDF deck in the same store, same
            // attachment descriptor.
            case 'generate_presentation': return await generatePresentationStep(app, model, step, ctx);
            // A PDF in, the same PDF without the marks that identify a person
            // or the customer out: same store, same attachment descriptor.
            case 'redact_pdf': return await redactPdfStep(app, model, step, ctx);
            // A Studio document copied into the owner's library (optionally
            // wearing another deck's look), the start of a compare. Reads go
            // through the app's document pool, which the run route puts in ctx.
            case 'copy_document': return await require(COPY_DOCUMENT_STEP).copyDocumentStep(app, model, step, ctx);
            // Record writes that land together or not at all: one database transaction.
            case 'transaction': return await require(TRANSACTION_STEP).transactionStep(app, model, step, ctx);
            case 'file_intake': {
                // Lives in its own module (it is a whole small pipeline); the
                // helpers travel as an argument so the modules never require
                // each other at load time.
                const { fileIntakeStep } = require('../fileIntake');
                return await fileIntakeStep(app, model, step, ctx, {
                    resolveBinding, buildServerScope, writeViewer, findTable, writeRecord,
                });
            }
            case 'dataset_query': {
                // Same injection discipline as file_intake — the module owns
                // the dataset resolution + slice query, the executor lends it
                // the binding/scope/write machinery.
                const { datasetQueryStep } = require('../datasetQueryStep');
                return await datasetQueryStep(app, model, step, ctx, {
                    resolveBinding, buildServerScope, writeViewer, findTable, writeRecord,
                });
            }
            // The KB query log as steps (Enterprise): rules in core/kb/queryLog/builderSteps.mts.
            case 'kb_log_query': return await require(KB_LOG_STEPS).kbLogQueryStep(app, model, step, ctx);
            case 'kb_log_review': return await require(KB_LOG_STEPS).kbLogReviewStep(app, model, step, ctx);
            case 'ai_browse': {
                // Streaming-only: the browse driver emits frames through
                // ctx.browse.send. Absent it, this is the plain /step route
                // trying to run a streaming step — refuse (defense in depth;
                // the route also 400s the kind).
                if (!ctx.browse || typeof ctx.browse.send !== 'function') {
                    return { ok: false, error: 'This step runs on the streaming endpoint' };
                }
                const { executeBrowseStep } = require('../browseStep');
                return await executeBrowseStep(app, ctx.def || null, step, ctx, {
                    resolveBinding, buildServerScope,
                });
            }
            // A kind of the step registry runs its own module; anything else is not a server step.
            default: {
                const runStep = fileStepHandler(step.kind);
                return runStep ? await runStep(app, model, step, ctx) : { ok: false, error: `Step "${step.kind}" is not a server step` };
            }
        }
    } catch (e) {
        // The real reason, never "Step failed" (stepErrors.mts): access/compile/quota
        // messages pass through, database and provider failures get fixed sentences,
        // an unknown error a reference that is also in the log.
        return require(STEP_ERRORS).describeStepError(e, step);
    }
}

module.exports = { executeDataStep, fileStepHandler };
