/**
 * App Studio Builder — conversational SSE endpoint (trimmed clone of
 * routes/ai/automationBuilder.js for App Studio component trees).
 *
 *   POST /stream           mounted at /api/studio-apps/builder in
 *   GET  /session/:appId   server/index.js, behind requireCapability('app_studio')
 *
 * Body: { message, appId?, builderSessionId?, modelTier='auto', timezone?,
 *         images?: string[] }
 *   images — up to 4 base64 image data URLs (png/jpeg/webp/gif, ≤5MB each
 *   decoded) the human is SHOWING the builder. Validated server-side against
 *   the data-URL header (never a client-declared mime) and attached as image
 *   content blocks on the role:'user' turn message — never the system prompt.
 *   A non-vision model gets a machine note instead and the user is told
 *   in-stream that the picture was ignored.
 *
 * The builder owns a per-turn draft (appStudio/builderTools draftWrap) that
 * is persisted to studio_apps after every mutation, so a refresh recovers
 * the app via the normal CRUD routes and the chat via GET /session/:appId.
 *
 * The route bodies live in ./appStudioBuilder/ — the persisted-session GET
 * (sessionSnapshot) and the SSE build turn (chatStream, with turnSetup,
 * modelSelection, promptAssembly, buildLoop, turnClosing and the event
 * builders beside it). This file mounts them in the exact order the routes
 * were registered when they were inline here: registration order is
 * semantics. The SSE event contract, the observability contract and the
 * prompt-cache discipline are documented on ./appStudioBuilder/chatStream.js,
 * where they are implemented.
 */

const express = require('express');
const router = express.Router();

const { isTransientChatError, applyBuilderTierFloor } = require('./builderShared');
const turnLoop = require('./appStudioBuilder/turnLoop');
const toolCallEvents = require('./appStudioBuilder/toolCallEvents');
const turnNotes = require('./appStudioBuilder/turnNotes');
const dataModelEvents = require('./appStudioBuilder/dataModelEvent');
const inboundImages = require('./appStudioBuilder/inboundImages');
const { streamWithRetry } = require('./appStudioBuilder/modelStream');
const { MAX_TOKENS_PER_ROUND } = require('./appStudioBuilder/buildLoop');

// ─── Persisted builder-session snapshot ──────────────────────────
router.use(require('./appStudioBuilder/sessionSnapshot'));

// ─── Conversational build loop (SSE) ─────────────────────────────
router.use(require('./appStudioBuilder/chatStream'));

module.exports = router;
// Internals exposed for unit tests (server/routes/ai/appStudioBuilder.test.js).
module.exports._test = {
    parseToolArgs: turnLoop.parseToolArgs,
    isTransientChatError,
    streamWithRetry,
    applyBuilderTierFloor,
    sanitizeHistory: turnLoop.sanitizeHistory,
    renderValidationNote: turnLoop.renderValidationNote,
    MAX_TOKENS_PER_ROUND,
    summariseToolResult: toolCallEvents.summariseToolResult,
    toolCallEvent: toolCallEvents.toolCallEvent,
    addedOf: toolCallEvents.addedOf,
    labelForTool: toolCallEvents.labelForTool,
    truncateJson: turnLoop.truncateJson,
    sanitizeEditorContext: turnNotes.sanitizeEditorContext,
    renderEditorContextNote: turnNotes.renderEditorContextNote,
    normalizeRowCounts: dataModelEvents.normalizeRowCounts,
    dataModelEvent: dataModelEvents.dataModelEvent,
    renderApprovedPlanNote: turnNotes.renderApprovedPlanNote,
    renderPlanPolicyNote: turnNotes.renderPlanPolicyNote,
    sanitizeInboundImages: inboundImages.sanitizeInboundImages,
    renderUserImageFraming: inboundImages.renderUserImageFraming,
    renderBlindImageNote: inboundImages.renderBlindImageNote,
    base64ByteLength: inboundImages.base64ByteLength,
    MAX_IMAGES_PER_TURN: inboundImages.MAX_IMAGES_PER_TURN,
    MAX_IMAGE_BYTES: inboundImages.MAX_IMAGE_BYTES,
    IMAGE_MIME_ALLOWLIST: inboundImages.IMAGE_MIME_ALLOWLIST,
    VALIDATION_NOTE_PREFIX: turnLoop.VALIDATION_NOTE_PREFIX,
    DRAFT_STATE_PREFIX: turnLoop.DRAFT_STATE_PREFIX,
    EDITOR_CONTEXT_PREFIX: turnLoop.EDITOR_CONTEXT_PREFIX,
    APPROVED_PLAN_PREFIX: turnLoop.APPROVED_PLAN_PREFIX,
    PLAN_POLICY_PREFIX: turnLoop.PLAN_POLICY_PREFIX,
    IMAGE_NOTE_PREFIX: turnLoop.IMAGE_NOTE_PREFIX,
};
