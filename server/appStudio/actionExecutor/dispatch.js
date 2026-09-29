/**
 * App Studio action executor — the DISPATCHER (extracted verbatim from
 * actionExecutor.js). Validates the step, routes it to the module for its
 * family and maps every thrown error onto the client-safe step result.
 */

'use strict';

const { DATA_MUTATING_STEP_KINDS } = require('../componentSpecs');
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
const log = require('../../telemetry/log');

// ── Public entry ────────────────────────────────────────────────────

/**
 * Execute ONE server-authoritative data step. Never throws — every failure is
 * a `{ ok:false, error }` with a generic message (access/compile details are
 * safe to surface; anything else collapses to "Step failed").
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

    try {
        switch (step.kind) {
            case 'create_record': return await createRecord(app, model, step, ctx);
            case 'update_record': return await updateRecord(app, model, step, ctx);
            case 'delete_record': return await deleteRecord(app, model, step, ctx);
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
            default: return { ok: false, error: `Step "${step.kind}" is not a server step` };
        }
    } catch (e) {
        const status = e && e.status;
        // Quota errors (studioAppQuota) carry the frozen 409 contract — the
        // step error keeps the code so callers can surface "app is full".
        if (status === 409 && e.code === 'quota_exceeded') {
            return { ok: false, error: e.message || 'Storage quota exceeded', code: 'quota_exceeded', limit: e.limit, used: e.used };
        }
        // AccessError (403 forbidden / 400 bad filter) and CompileError (422
        // bad field/descriptor) carry client-safe messages; everything else is
        // an internal fault we collapse to a generic string.
        if (status === 403 || status === 422 || status === 400) {
            return { ok: false, error: e.message || 'Step failed' };
        }
        // Een weigering van de tabellaag (appStudio/readError.js) draagt de vlag
        // `safe` én een status, en juist de statussen die hierboven NIET staan —
        // 503 "we konden het niet vaststellen", 501 "dit kan hier nog niet". Die
        // tot "Step failed" samenvouwen zou de enige zin weghalen waar iemand op
        // kan handelen: "leeg", "mag niet" en "kon niet" worden dan één woord.
        if (e && e.safe === true && typeof status === 'number') {
            return { ok: false, error: e.message || 'Step failed', code: 'datatable_source' };
        }
        log.error(`[ActionExecutor] ${step.kind} failed: ${e && e.message}`);
        return { ok: false, error: 'Step failed' };
    }
}

module.exports = { executeDataStep };
