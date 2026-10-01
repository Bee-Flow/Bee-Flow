/**
 * Per-step-type field rules: everything the validator checks INSIDE one step —
 * integration_action, approval (incl. panel + stage chain), ai_step, condition,
 * guard/tokenize/untokenize, loop, parallel, forEach, code, notification,
 * http_request, layer_output, set, parse_json, datetime, wait, stop_error,
 * form_page, generate_document, switch, the collection ops — plus the
 * reference-scoping pass over every binding the step carries, the checks on
 * its v2 mapping (pick, compose, repeat; mappingRules.js), and the two
 * compliance findings a definition can justify on its own (complianceRules.js).
 *
 * The checker closes over the graph it validates (edges, known ids, the
 * outputs seen so far), so it is built per graph rather than imported as a
 * plain function: validate/graph.js hands those bindings to createStepChecker
 * and calls the returned checkStep for top-level and nested steps alike.
 */

const { NESTED_FORBIDDEN_RULES } = require('../constants');
const { createStepContext } = require('./stepContext');
const { checkPinnedOutput } = require('./pinnedOutput');
const { checkIntegrationAction, checkHttpRequest, checkAskOnce, checkCacheInto } = require('./integrationRules');
const { checkApproval } = require('./approvalRules');
const { checkAiStep, checkDataExtraction } = require('./modelStepRules');
const { checkCondition, checkBranchWiring, checkPrivacyScan, checkSwitch } = require('./branchingRules');
const { checkLoop, checkParallel, checkForEach, checkCollectionOps } = require('./iterationRules');
const { checkTopics } = require('./topicRules');
const { checkCode, checkLayerOutput, checkSet, checkParseJson, checkDatetime } = require('./dataShapingRules');
const { checkGenerateDocument, checkFillDocument, checkSlide, checkPresentation } = require('./documentRules');
const { checkKnowledgeWrite, checkDatatable } = require('./persistenceRules');
const {
    checkNotification, checkWait, checkStopError, checkReturnToApp, checkNote, checkFormPage,
} = require('./runFlowRules');
const { checkReferences } = require('./referenceScoping');
const { checkMappings } = require('./mappingRules');
const { checkComplianceFindings } = require('./complianceRules');

/**
 * Build the per-step checker for ONE graph. `ctx` carries the graph-level
 * bindings the rules read: the graph itself (its edges), its trigger, the
 * known step ids, the set of ids whose output is available so far, the two
 * record sinks, and the optional catalogs the caller supplied.
 */
function createStepChecker({
    graph, trigger, ids, seenSoFar, pushE, pushW,
    availableTools, toolRequiredParams, knownConnectionIds, availableAgents, topicClassifier, isContractScope,
}) {
    const base = createStepContext({
        graph, trigger, ids, seenSoFar, pushE, pushW,
        availableTools, toolRequiredParams, knownConnectionIds, availableAgents, topicClassifier, isContractScope,
    });
    const { outgoingLabelsFor } = base;

    // Per-step validation + reference scoping. `checkStep` holds ALL the
    // per-type field rules and runs for top-level steps AND (via the nested
    // walker below) for every step inside a loop body / parallel branch —
    // those used to skip per-type validation entirely, so an HTTP Request
    // with an empty URL nested in a loop activated green and only failed at
    // run time (node-audit C3/C4).
    //
    // Edge-dependent rules (condition/switch branch wiring) stay top-level
    // only: bodies are linear step arrays with no edges — the runtime
    // synthesizes brancher-aware chains itself (engine buildLinearEdges).
    //
    // opts:
    //   nested     — true inside a body/branch (switches a few rules)
    //   idsForRefs — known step ids for ref checks (top-level ∪ container chain)
    //   seen       — ids whose output is available at this point
    const checkStep = (step, at, { nested = false, idsForRefs = null, seen = null } = {}) => {
        const refIds = idsForRefs || ids;
        const refSeen = seen || seenSoFar;
        const ctx = { ...base, nested, refIds, refSeen };

        // Pinned sample data — type-agnostic, so it runs before the per-type
        // rules. The edge-dependent half is top-level only: a loop body /
        // parallel branch has no authored edges of its own.
        checkPinnedOutput(step, at, { pushE, outgoingLabels: nested ? null : outgoingLabelsFor(step.id) });

        // Een stap die in een loop-body / parallelle tak niet kan bestaan —
        // zie NESTED_FORBIDDEN_RULES voor de twee families en het mechanisme
        // per familie. Dit is de ENIGE plek die genestelde plaatsing toetst:
        // de contract-scope-regels in graph.js kijken alleen naar top-level
        // stappen, dus wat hier niet staat, valideert binnen een lus schoon.
        // De regel woonde ooit in het form_page-blok zelf, waardoor `approval`
        // (dat via dezelfde machinerie pauzeert) geen tegenhanger had; en de
        // nieuwe eindstap `return_to_app` had er om dezelfde reden geen.
        if (nested) {
            const nestedRule = NESTED_FORBIDDEN_RULES.get(step.type);
            if (nestedRule) {
                pushE({ code: nestedRule.code, severity: 'error', path: at + '.type', message: nestedRule.message(step.id), hint: nestedRule.hint });
            }
        }

        // Step-type-specific structural checks, in the order they have always
        // run: the record arrays are built by appending, so the order is part
        // of what every caller sees.
        checkIntegrationAction(ctx, step, at);
        checkApproval(ctx, step, at);
        checkAiStep(ctx, step, at);
        checkCondition(ctx, step, at);
        checkBranchWiring(ctx, step, at);
        checkPrivacyScan(ctx, step, at);
        checkLoop(ctx, step, at);
        checkParallel(ctx, step, at);
        checkForEach(ctx, step, at);
        checkCode(ctx, step, at);
        checkNotification(ctx, step, at);
        checkHttpRequest(ctx, step, at);
        checkLayerOutput(ctx, step, at);
        checkSet(ctx, step, at);
        checkParseJson(ctx, step, at);
        checkDatetime(ctx, step, at);
        checkWait(ctx, step, at);
        checkStopError(ctx, step, at);
        checkReturnToApp(ctx, step, at);
        checkNote(ctx, step, at);
        checkFormPage(ctx, step, at);
        checkGenerateDocument(ctx, step, at);
        checkFillDocument(ctx, step, at);
        checkSlide(ctx, step, at);
        checkPresentation(ctx, step, at);
        checkDataExtraction(ctx, step, at);
        checkSwitch(ctx, step, at);
        checkCollectionOps(ctx, step, at);
        checkTopics(ctx, step, at);
        checkAskOnce(ctx, step, at);
        checkCacheInto(ctx, step, at);
        checkKnowledgeWrite(ctx, step, at);
        checkDatatable(ctx, step, at);
        checkReferences(ctx, step, at);
        // The v2 mapping (pick, compose, repeat) beside the legacy refs.
        checkMappings(ctx, step, at);
        // Last, and never in front of a field rule: a compliance warning is
        // about a step that is already wired, so it reads after the step's own
        // shape has been reported. Warnings only — see complianceRules.js.
        checkComplianceFindings(ctx, step, at);
    };

    return checkStep;
}

module.exports = { createStepChecker, checkPinnedOutput };
