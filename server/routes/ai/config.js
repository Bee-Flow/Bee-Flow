/**
 * AI Config Routes
 *
 * Handles: config CRUD, model tiers, system prompt, tool enablement, model costs
 *
 * The route bodies live in ./config/ (instanceConfig, modelTiers, userSettings,
 * integrations, plus the shared helpers); this file mounts them in the exact
 * order the routes were registered when they were inline here — registration
 * order is semantics.
 */

const express = require('express');
const router = express.Router();

// ─── General AI Config (CRUD, key deletion, service email, reranker test) ─
router.use(require('./config/instanceConfig'));

// ─── Model Tier Config (standard/EU/custom/org + per-user resolution) ─
router.use(require('./config/modelTiers'));

// ─── Web-Search Inference Routing ────────────────────────────────
router.use(require('./config/webSearchInference'));

// ─── Direct Chat System Prompt + Per-Tier Tools ──────────────────
router.use(require('./config/directChatSettings'));

// ─── Model Costs ─────────────────────────────────────────────────
router.use(require('./config/modelCosts'));

// ─── Per-User Settings (Fireflies key etc.) ──────────────────────
router.use(require('./config/userSettings'));

// ─── AI Regex Generator ──────────────────────────────────────────
router.use(require('./config/regexGenerator'));

// ─── n8n / Agent Search / MCP Integration Settings ───────────────
router.use(require('./config/integrations'));

module.exports = router;
