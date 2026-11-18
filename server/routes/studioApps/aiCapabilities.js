// @typecheck strict
/**
 * GET /:id/ai-capabilities: what the AI of an app can reach on this installation (web search,
 * browsing), for the "What the AI can do" panel in App settings (appStudio/aiCapabilities.mts).
 *
 * Owner only, like the triggers: the AI steps run as the owner, so the answer is about the owner's
 * integrations. Every other caller gets the 404 of an unknown app.
 */

const express = require('express');
const { requireAuth } = require('../../auth/permissions');
const { gateOwnedApp } = require('./access');
const { aiCapabilitiesFor } = require('../../appStudio/aiCapabilities.mts');

const router = express.Router();

router.get('/:id/ai-capabilities', requireAuth, gateOwnedApp, async (_req, res) => {
    res.json(await aiCapabilitiesFor(res.locals.ownedApp));
});

module.exports = router;
