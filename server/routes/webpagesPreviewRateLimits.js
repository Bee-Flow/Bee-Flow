/**
 * Rate limiters for the webpages-preview bridge routes (server/routes/webpagesPreview.js).
 *
 * Split into its own dependency-free module (only `express-rate-limit`) so it
 * can be unit-tested without pulling in webpagesPreview.js's full graph of
 * stores/providers, most of which require live env config (DB, secrets) at
 * import time.
 *
 * These endpoints act AS THE AUTHOR (see webpageBridgeAuth) and spend real
 * money (LLM tokens) or cause real side effects (integrations/automations,
 * arbitrary DB writes) — but the token that gates them can be held by any
 * org/group viewer of a shared page (it's scoped to the owner, not the
 * viewer). Three tiers, keyed per-token (not IP) so viewers sharing a
 * NAT/proxy don't share a bucket and a single leaked token can't be amplified
 * by IP rotation.
 *
 * Must be mounted AFTER requirePreviewToken — the key generator reads
 * req.previewClaims, which that middleware sets.
 *
 * No request schema lives here, and none belongs here: this file declares no
 * route. The one input it reads — `req.body.tool`, to pick a tier — belongs to
 * the route that mounts it (webpagesPreview.js), and it reads it fail-closed:
 * anything that is not a known read-only tool gets the strict side-effect tier.
 */

const rateLimit = require('express-rate-limit');
// Pure data module (two Sets + a predicate, no DB/env) — safe to require here
// without breaking this file's "testable in isolation" property.
const { isSideEffect } = require('../automation/sideEffectMap');

function previewTokenKey(req) {
    const c = req.previewClaims;
    return c ? `${c.userId}:${c.webpageId}` : 'anon';
}

const llmBridgeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: previewTokenKey,
    message: 'Too many AI requests for this page. Please try again in a minute.',
});

// Tightest tier — real side effects (Slack messages, Sheets writes, etc.).
const sideEffectBridgeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: previewTokenKey,
    message: 'Too many integration/automation runs for this page. Please try again in a minute.',
});

const dbBridgeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: previewTokenKey,
    message: 'Too many database requests for this page. Please try again in a minute.',
});

/**
 * Tabelbindingen (window.beeflowTables) hebben hun EIGEN sleutel.
 *
 * `previewTokenKey` hierboven bevat de EIGENAAR van de pagina, want daar draait
 * de rest van de brug als. De tabelroutes draaien juist als de INGELOGDE
 * BEZOEKER, en dan is een gedeelde emmer verkeerd om: één drukke bezoeker zou
 * de tabel voor alle anderen dichtzetten. Vandaar de bezoeker in de sleutel.
 * Zonder bezoekersclaim (een token van vóór W3) wordt dat 'noviewer' — die
 * verzoeken worden verderop toch geweigerd, en één krappe emmer is de goede
 * kant om daarop te wachten.
 */
function tableViewerKey(req) {
    const c = req.previewClaims;
    if (!c) return 'anon';
    return `${c.viewerUserId || 'noviewer'}:${c.webpageId}`;
}

// Lezen uit een gebonden tabel: dezelfde ruimte als de paginadatabase.
const tableReadBridgeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: tableViewerKey,
    message: 'Too many table reads for this page. Please try again in a minute.',
});

// Schrijven raakt gedeelde organisatiedata, niet de eigen paginadatabase:
// eigen, krappere emmer, zodat een schrijfstorm de leesbudgetten niet opeet.
const tableWriteBridgeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: tableViewerKey,
    message: 'Too many table writes for this page. Please try again in a minute.',
});

// Read-only integration reads (vplan_*, *_list_*, *_get_* …) share the bridge
// route with side-effecting tools, but not their risk: they spend no money, send
// no messages and change nothing upstream. Putting them on the 10/min
// side-effect tier made a dashboard page unusable — five read tools on page load
// plus one refresh already exceeds it. They get the db-tier budget (60/min) in
// their OWN bucket, so a burst of reads can't drain the side-effect allowance.
const readIntegrationBridgeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: previewTokenKey,
    message: 'Too many integration reads for this page. Please try again in a minute.',
});

/**
 * Tier selector for POST /:id/integrations/run.
 *
 * Reads `req.body.tool` and routes to the read tier only when sideEffectMap
 * says the tool is read-only. That map is fail-closed (an unlisted tool counts
 * as side-effecting), so a new or misspelled tool keeps the strict 10/min
 * budget — the safe direction. Must be mounted after the JSON body parser;
 * a missing/!string body yields `undefined`, which isSideEffect treats as
 * side-effecting, and the handler rejects it with a 400 anyway.
 */
function integrationBridgeLimiter(req, res, next) {
    const tool = req.body && req.body.tool;
    const limiter = isSideEffect(tool) ? sideEffectBridgeLimiter : readIntegrationBridgeLimiter;
    return limiter(req, res, next);
}

module.exports = {
    previewTokenKey,
    llmBridgeLimiter,
    sideEffectBridgeLimiter,
    readIntegrationBridgeLimiter,
    integrationBridgeLimiter,
    dbBridgeLimiter,
    tableViewerKey,
    tableReadBridgeLimiter,
    tableWriteBridgeLimiter,
};
