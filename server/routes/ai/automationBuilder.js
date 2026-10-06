/**
 * Automation Builder Routes
 *
 * Handles: the conversational SSE build loop, the flowlet sub-agent, the
 * fast-tier naming/summarising surfaces, parse_json field mapping, the code
 * step's AI assistant, and the "find repeating work" suggestion scan.
 *
 * The route bodies live in ./automationBuilder/ (chatStream, layerAgent,
 * suggestions, …, plus the shared draft + chat-loop helpers); this file mounts
 * them in the exact order the routes were registered when they were inline
 * here — registration order is semantics.
 */

const express = require('express');
const router = express.Router();

const { isTransientChatError, applyBuilderTierFloor } = require('./builderShared');
const layerSummary = require('./automationBuilder/layerSummary');
const mapJsonFields = require('./automationBuilder/mapJsonFields');
const chatTurnLoop = require('./automationBuilder/chatTurnLoop');
const { chatWithRetry } = require('./automationBuilder/modelStream');

// ─── Persisted builder-session snapshot ──────────────────────────
router.use(require('./automationBuilder/sessionSnapshot'));

// ─── Flowlet summary (fast tier) ─────────────────────────────────
router.use(layerSummary);

// ─── Auto-label + auto-icon for steps ────────────────────────────
router.use(require('./automationBuilder/stepLabels'));

// ─── Map-with-AI for parse_json steps ────────────────────────────
router.use(mapJsonFields);

// ─── Auto-map's AI fallback (the wand, after the deterministic pass) ─
router.use(require('./automationBuilder/suggestMappings'));

// ─── Code step AI assistant (SSE) ────────────────────────────────
router.use(require('./automationBuilder/codeAssist'));

// ─── Condition-node output suggestions (model fallback) ──────────
router.use(require('./automationBuilder/routeRules'));

// ─── Condition-node "is about": score the sample rows ────────────
router.use(require('./automationBuilder/topicPreview'));

// ─── "Find repeating work" suggestions (+ last scan, feedback) ───
router.use(require('./automationBuilder/suggestions'));

// ─── Flowlet sub-agent (SSE) ─────────────────────────────────────
router.use(require('./automationBuilder/layerAgent'));

// ─── Conversational build loop (SSE) ─────────────────────────────
router.use(require('./automationBuilder/chatStream'));

module.exports = router;
// Internals exposed for unit tests (server/routes/ai/automationBuilder.test.js).
module.exports._test = {
    parseToolArgs: chatTurnLoop.parseToolArgs,
    isTransientChatError,
    chatWithRetry,
    applyBuilderTierFloor,
    validateLayerForSummary: layerSummary.validateLayerForSummary,
    sanitiseLayerSummary: layerSummary.sanitiseLayerSummary,
    accumulateUsage: chatTurnLoop.accumulateUsage,
    renderValidationNote: chatTurnLoop.renderValidationNote,
    sanitizeHistory: chatTurnLoop.sanitizeHistory,
    VALIDATION_NOTE_PREFIX: chatTurnLoop.VALIDATION_NOTE_PREFIX,
    TRUNCATION_PLACEHOLDER: chatTurnLoop.TRUNCATION_PLACEHOLDER,
    isTruncatedStop: chatTurnLoop.isTruncatedStop,
    truncationRetryMessages: chatTurnLoop.truncationRetryMessages,
    applyPlanMarkDone: chatTurnLoop.applyPlanMarkDone,
    validateMapJsonRequest: mapJsonFields.validateMapJsonRequest,
    verifyMappedFields: mapJsonFields.verifyMappedFields,
    verifyMapJsonItemsRef: mapJsonFields.verifyMapJsonItemsRef,
    MAP_JSON_FIELDS_TOOL: mapJsonFields.MAP_JSON_FIELDS_TOOL,
};
