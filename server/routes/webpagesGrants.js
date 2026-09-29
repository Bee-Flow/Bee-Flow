/**
 * Webpage bridge-grant routes — owner-only REST surface for the SAME grants
 * the studio AI manages through webpageBridgeTools (both delegate to
 * integrations/webpageGrants.js, so policy can never diverge). This is what
 * the IDE "Apps & data" panel talks to.
 *
 * Endpoints:
 *   GET    /:id/grants                          — current grants, integrations
 *                                                 enriched with availability
 *   POST   /:id/grants/integrations             — { tool, fixedArgs?, label? }
 *   DELETE /:id/grants/integrations/:tool       — revoke one tool grant
 *   POST   /:id/grants/automations              — { automationId, label? }
 *   DELETE /:id/grants/automations/:automationId
 *   GET    /:id/data-cards                      — het kaartenmodel van de
 *                                                 Data-tab (tabellen, voedende
 *                                                 routines, waarschuwingen)
 *   GET    /:id/bindings                        — wat de pagina ZELF doet: de
 *                                                 statische scan op uitgaande
 *                                                 oproepen in eigen code, WAAR
 *                                                 haar `bf-*`-elementen staan
 *                                                 (bestand + regel, voor de
 *                                                 markeringen in de Code-tab),
 *                                                 plus de stand van formulieren
 *                                                 en het Agent-blok
 *
 * Granting an integration the author hasn't connected fails with
 * 409 { code: 'connection_required', provider } — the UI deep-links to
 * Settings → Integrations from that.
 *
 * ── What a caller may send ───────────────────────────────────────────────
 *
 * Both grant bodies are `.strict()`, and for the integration grant that is the
 * whole point. `fixedArgs` are the arguments the author PINS — the recipient,
 * the channel, the sheet id a visitor must not be able to choose — and the
 * bridge runs acts-as-author. grantIntegration copied them over only when they
 * arrived as an object under exactly that name, so:
 *
 *   - `{"tool": "slack_send_message", "fixedargs": {"channel": "#sales"}}` and
 *   - `{"tool": "slack_send_message", "fixedArgs": "{\"channel\":\"#sales\"}"}`
 *
 * both stored an UNPINNED grant — the page could send anywhere the author can —
 * and answered `{ success: true }`. The upsert replaces the tool's entry, so
 * the same request also wiped the pins of a grant that already had them.
 */

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();

const webpageStore = require('../stores/webpageStore');
const webpageGrants = require('../integrations/webpageGrants');
const webpageBindings = require('../core/webpages/webpageBindings');
const webpageDataCards = require('../core/webpages/webpageDataCards');
const { requireAuth } = require('../auth/permissions');
const { validate } = require('../core/http/validate');
const { z } = require('zod');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const TOOL_TEXT = 'Name the integration action to grant (tool).';
const FIXED_TEXT = 'fixedArgs is a JSON object of pinned arguments, e.g. { "channel": "#general" }.';
const AUTOMATION_TEXT = 'Name the automation to grant (automationId).';
const LABEL_TEXT = 'A grant label must be text.';

const IntegrationGrantBody = z.object({
    tool: worded(TOOL_TEXT).trim().min(1, TOOL_TEXT),
    // Its keys are the TOOL's own arguments, so the map itself stays open.
    fixedArgs: z.record(z.unknown(), { required_error: FIXED_TEXT, invalid_type_error: FIXED_TEXT }).optional(),
    label: worded(LABEL_TEXT).optional(),
}).strict();

const AutomationGrantBody = z.object({
    automationId: worded(AUTOMATION_TEXT).trim().min(1, AUTOMATION_TEXT),
    label: worded(LABEL_TEXT).optional(),
}).strict();

/** Flatten a grantError (or unexpected throw) into the HTTP contract. */
function sendError(res, err, fallback) {
    const status = err.status || 500;
    if (status === 500) log.error(`[Webpages/grants] ${fallback}:`, err);
    res.status(status).json({
        error: status === 500 ? fallback : err.message,
        ...(err.code ? { code: err.code } : {}),
        ...(err.provider ? { provider: err.provider } : {}),
    });
}

/**
 * Owner-scoped webpage lookup shared by every route here. Grants are
 * owner-only: the bridge runs acts-as-author, so letting an org-viewer read
 * or mutate them would leak (or widen) the owner's delegated access. Resolves
 * to the webpage, or null after sending the 404.
 */
async function ownedWebpage(req, res) {
    const wp = await webpageStore.getWebpage(req.params.id, req.session.user.id);
    if (!wp) {
        res.status(404).json({ error: 'Webpage not found' });
        return null;
    }
    return wp;
}

router.get('/:id/grants', requireAuth, async (req, res) => {
    try {
        const wp = await ownedWebpage(req, res);
        if (!wp) return;
        const { userId } = { userId: req.session.user.id };
        const result = await webpageGrants.describeGrants({ webpageId: wp.id, userId, session: req.session });
        res.json(result);
    } catch (err) {
        sendError(res, err, 'Failed to load grants');
    }
});

router.post('/:id/grants/integrations', requireAuth, validate({ body: IntegrationGrantBody }), async (req, res) => {
    try {
        const wp = await ownedWebpage(req, res);
        if (!wp) return;
        const { tool, fixedArgs, label } = req.body;
        const result = await webpageGrants.grantIntegration({
            webpageId: wp.id, userId: req.session.user.id, session: req.session, tool, fixedArgs, label,
        });
        res.json({ success: result.success, tool: result.tool, integrationId: result.integrationId, grants: result.grants });
    } catch (err) {
        sendError(res, err, 'Failed to grant integration');
    }
});

router.delete('/:id/grants/integrations/:tool', requireAuth, async (req, res) => {
    try {
        const wp = await ownedWebpage(req, res);
        if (!wp) return;
        const result = await webpageGrants.revokeIntegration({
            webpageId: wp.id, userId: req.session.user.id, tool: req.params.tool,
        });
        res.json({ success: result.success, removed: result.removed, grants: result.grants });
    } catch (err) {
        sendError(res, err, 'Failed to revoke integration');
    }
});

router.post('/:id/grants/automations', requireAuth, validate({ body: AutomationGrantBody }), async (req, res) => {
    try {
        const wp = await ownedWebpage(req, res);
        if (!wp) return;
        const { automationId, label } = req.body;
        const result = await webpageGrants.grantAutomation({
            webpageId: wp.id, userId: req.session.user.id, automationId, label,
        });
        res.json({ success: result.success, automationId: result.automationId, title: result.title, grants: result.grants });
    } catch (err) {
        sendError(res, err, 'Failed to grant automation');
    }
});

router.delete('/:id/grants/automations/:automationId', requireAuth, async (req, res) => {
    try {
        const wp = await ownedWebpage(req, res);
        if (!wp) return;
        const result = await webpageGrants.revokeAutomation({
            webpageId: wp.id, userId: req.session.user.id, automationId: req.params.automationId,
        });
        res.json({ success: result.success, removed: result.removed, grants: result.grants });
    } catch (err) {
        sendError(res, err, 'Failed to revoke automation');
    }
});

/**
 * Het kaartenmodel van de Data-tab.
 *
 * Eigenaar-only, net als alles hierboven en om dezelfde reden: dit vertelt wat
 * er aan de pagina hangt, inclusief de kolomnamen van andermans tabellen.
 */
router.get('/:id/data-cards', requireAuth, async (req, res) => {
    try {
        const wp = await ownedWebpage(req, res);
        if (!wp) return;
        const cards = await webpageDataCards.buildDataCards({ webpageId: wp.id, userId: req.session.user.id });
        res.json(cards);
    } catch (err) {
        sendError(res, err, 'Failed to load the data cards');
    }
});

/**
 * Wat de pagina zelf doet — de kolom "Laat gebeuren".
 *
 * Eigenaar-only, en hier weegt dat zwaarder dan bij de kaarten hiernaast: het
 * antwoord is afgeleid uit de INHOUD van `script.js` en `index.html`, tot en
 * met de URL's die erin staan. Dat is auteurscode, geen leesoppervlak.
 */
router.get('/:id/bindings', requireAuth, async (req, res) => {
    try {
        const wp = await ownedWebpage(req, res);
        if (!wp) return;
        const out = await webpageBindings.describePageActions({ webpageId: wp.id, userId: req.session.user.id });
        res.json(out);
    } catch (err) {
        sendError(res, err, 'Failed to read what this page does');
    }
});

module.exports = router;
