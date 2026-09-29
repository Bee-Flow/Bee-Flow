/**
 * Direct Chat Routes
 *
 * Handles: streaming direct chat, conversation CRUD.
 * Uses LLMClient for all LLM interactions — no provider-specific code here.
 *
 * The route bodies live in ./directChat/ (streamTurn, imageGeneration,
 * conversationRoutes, plus the shared helpers/toolExec modules); this file
 * mounts them in the exact order the routes were registered when they were
 * inline here — registration order is semantics.
 */

const express = require('express');
const router = express.Router();

// ─── Streaming Direct Chat ───────────────────────────────────────
router.use(require('./directChat/streamTurn'));

// ─── Image Generation (Google Nano Banana 2) ──────────────────────
router.use(require('./directChat/imageGeneration'));

// ─── Conversation CRUD (+ session skills, labels, workspace) ─────
router.use(require('./directChat/conversationRoutes'));

module.exports = router;
