/**
 * The leaf switch of step dispatch: which executor runs a step, by its type
 * (no iteration, no retry — ./stepDispatch.js wraps those around it).
 *
 * The executors come from `deps.engine` (execution.js's RUN_DEPS), so this
 * module stays outside the server's large import cycle like its caller.
 */

'use strict';

/**
 * @param {object} deps  execution.js's RUN_DEPS
 * @param {() => Function} dispatchStep  the run's dispatchStep, for container
 *   steps (loop, parallel, call_layer, call_block) that recurse through it.
 *   A getter: it is only *called* at run time, when the closure exists.
 * @returns {(step, ctx_, state_, mode_) => Promise<object>}
 */
function makeLeafRunner(deps, dispatchStep) {
    const e = deps.engine;
    const { execFlatten } = deps;
    return async function runStepLeaf(step, ctx_, state_, mode_) {
        switch (step.type) {
            case 'integration_action': return e.execIntegrationAction(step, ctx_, state_, mode_);
            case 'ai_step':            return e.execAiStep(step, ctx_, state_, mode_);
            case 'condition':          return e.execCondition(step, ctx_, state_);
            // Scans a value with the Privacy Shield's own detector and branches
            // on the answer (then = personal data, else = clean).
            case 'guard':              return e.execGuard(step, ctx_, state_, mode_);
            // Reversible placeholders minted into the run vault; the
            // runner's existing restore points put the real values back.
            case 'tokenize':           return e.execTokenize(step, ctx_, state_, mode_);
            // Put the real values back HERE. The runner restores automatically
            // wherever a value round-trips (AI reply, tool result); this is for
            // the values that never do.
            case 'untokenize':         return e.execUntokenize(step, ctx_, state_);
            case 'loop':               return e.execLoop(step, ctx_, state_, mode_, dispatchStep());
            case 'code':               return e.execCode(step, ctx_, state_, mode_);
            case 'notification':       return e.execNotification(step, ctx_, state_, mode_);
            case 'http_request':       return e.execHttpRequest(step, ctx_, state_, mode_);
            case 'generate_document':  return e.execGenerateDocument(step, ctx_, state_, mode_);
            // Fills a Document DESIGNED in Studio (an invoice, a quote, a
            // letter on letterhead) and keeps the PDF. generate_document above
            // is its sibling for the other direction: text in, standard layout.
            case 'fill_document':      return e.execFillDocument(step, ctx_, state_, mode_);
            // The presentation pair: a slide is an object (pure, forEach-able),
            // the deck is a kept file — same ledger as generate_document.
            case 'slide':              return e.execSlide(step, ctx_, state_, mode_);
            case 'presentation':       return e.execPresentation(step, ctx_, state_, mode_);
            case 'approval':           return e.execApproval(step, ctx_, state_, mode_);
            case 'form_page':          return e.execFormPage(step, ctx_, state_, mode_);
            case 'parallel':           return e.execParallel(step, ctx_, state_, mode_, dispatchStep());
            case 'call_layer':         return e.execCallLayer(step, ctx_, state_, mode_, dispatchStep());
            case 'call_block':         return e.execCallBlock(step, ctx_, state_, mode_, dispatchStep());
            case 'layer_output':       return e.execLayerOutput(step, ctx_, state_);
            // n8n-style utility nodes
            case 'set':                return e.execSet(step, ctx_, state_);
            case 'parse_json':         return e.execParseJson(step, ctx_, state_, mode_);
            case 'datetime':           return e.execDateTime(step, ctx_, state_);
            case 'wait':               return e.execWait(step, ctx_, state_, mode_);
            case 'stop_error':         return e.execStopError(step, ctx_, state_);
            // The other TERMINAL step. Unlike stop_error it does NOT throw —
            // it ends the run successfully and its output carries the
            // instructions the app applies (`_appEffects`). The walk stopping
            // afterwards is runDag's job, not this switch's.
            case 'return_to_app':      return e.execReturnToApp(step, ctx_, state_);
            case 'switch':             return e.execSwitch(step, ctx_, state_);
            case 'filter':             return e.execFilter(step, ctx_, state_);
            case 'limit':              return e.execLimit(step, ctx_, state_);
            case 'dedupe':             return e.execDedupe(step, ctx_, state_);
            case 'flatten':            return execFlatten(step, ctx_, state_);
            case 'aggregate':          return e.execAggregate(step, ctx_, state_);
            case 'summarize':          return e.execSummarize(step, ctx_, state_);
            // One of the two steps whose effect outlives the run: rows in an
            // organisation-scoped table, reached through the shared engine.
            case 'datatable':          return e.execDatatable(step, ctx_, state_, mode_);
            // The other one whose effect outlives the run — and the one whose
            // text an agent will later state as fact, which is why its
            // knowledge base is re-authorised at run time rather than trusted
            // from the definition.
            case 'knowledge_write':    return e.execKnowledgeWrite(step, ctx_, state_, mode_);
            // Named, typed fields out of a piece of text. Runs on the ONE
            // extraction model the admin configured, never the automation's
            // tier; a dry run synthesises typed samples and never calls it.
            case 'data_extraction':    return e.execDataExtraction(step, ctx_, state_, mode_);
            // A canvas annotation (BFSF-411) — never reachable in practice
            // (it carries no edges, so runDag never queues it; a nested one
            // is excluded from execFlow.js's buildLinearEdges the same way),
            // but the switch's OWN contract is "never throw for a persisted
            // note step", so this case stands as the second half of that
            // guarantee rather than relying on unreachability alone.
            case 'note':               return { output: null, skippedReason: 'note' };
            default: throw new Error(`Unknown step type: ${step.type}`);
        }
    };
}

module.exports = { makeLeafRunner };
