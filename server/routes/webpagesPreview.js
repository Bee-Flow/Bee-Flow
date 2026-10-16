/**
 * Webpage Preview Routes — cross-origin endpoints callable from the
 * sandboxed preview iframe (no `allow-same-origin`, opaque origin, no cookies).
 *
 * All routes are guarded by `requirePreviewToken` (HMAC bearer token bound to
 * a specific `(userId, webpageId)` pair). Mounted in server/index.js without
 * the beta-feature gate because the gate is session-based and the iframe has
 * no session — the token is the trust anchor here, and it can only have been
 * issued by a session-authenticated request through the regular routes.
 *
 * Endpoints:
 *   POST /:id/db/query                      read-only SELECT
 *   POST /:id/db/exec                       INSERT/UPDATE/DELETE/CREATE/etc.
 *   POST /:id/db/batch                      array of statements in a transaction
 *   GET  /:id/db/schema                     list tables + columns
 *
 *   POST /:id/ai/chat                       single-shot LLM call (text or JSON schema)
 *   POST /:id/ai/stream                     streaming LLM call (SSE)
 *   POST /:id/ai/ask                        agentic tool loop (SSE) — auto-uses granted bridges
 *
 *   GET  /:id/automations                   list granted automations
 *   POST /:id/automations/:autoId/run       trigger an automation as the author
 *   GET  /:id/automations/runs/:runId       run status (polling)
 *   GET  /:id/automations/runs/:runId/steps per-step outputs
 *   POST /:id/automations/runs/:runId/cancel
 *
 *   GET  /:id/integrations                  list granted integration tools
 *   POST /:id/integrations/run              call an integration tool as the author
 *
 *   POST /:id/tables/:tid/query             read a bound datatable  AS THE VIEWER
 *   POST /:id/tables/:tid/insert            add a row               AS THE VIEWER
 *   POST /:id/tables/:tid/update            edit a row              AS THE VIEWER
 *
 * The /tables/* routes are the ONE exception to the acts-as-author rule below:
 * a datatable grades every person separately, so they run as the logged-in
 * VIEWER (`previewClaims.viewerUserId`) — see routes/webpagesPreviewTables.js.
 *
 * All other bridge calls (ai / automations / integrations) act as the WEBPAGE AUTHOR
 * — see server/core/webpageBridgeAuth.js. The viewer's identity is captured
 * in `_viewerUserId` on automation trigger payloads but never used to scope
 * the call itself — and it is `previewClaims.viewerUserId`, never
 * `previewClaims.userId` (that is the AUTHOR; using it would make every run
 * report claim the author pressed the button).
 *
 * ── No request schema here, deliberately ───────────────────────────
 * Every body is built by the page's own bridge script from whatever the
 * page's code passes (`beeflowAI.chat(prompt, opts)`, `beeflowDB.exec(sql,
 * params)`, `fetch('/app/…')`). The AI bags are the same ones the public
 * share bridge takes, which leaves them open for the reason its header gives
 * (a refusal only one bridge makes breaks a page once it is shared); the SQL
 * is checked by webpageDbStore; `/app/*` hands the page's own query and body
 * to the page's own handler. What this file owns is the token, the rate
 * limits and the clamps on tokens and rounds. The one bridge with a schema,
 * the tables bridge, is in webpagesPreviewTables.js.
 */

const express = require('express');
const router = express.Router();
const { llmBridgeLimiter, sideEffectBridgeLimiter, integrationBridgeLimiter, dbBridgeLimiter } = require('./webpagesPreviewRateLimits');

const webpageDbStore = require('../stores/webpageDbStore');
const webpageStore = require('../stores/webpageStore');
const automationStore = require('../stores/automationStore');
const { requirePreviewToken } = require('../auth/webpagePreviewToken');
const { loadAuthorContext } = require('../core/webpages/webpageBridgeAuth');
const { executeTool } = require('../core/tools/toolDispatcher');
const { findOwnerOfTool, loadTools } = require('../automation/toolRegistry');
const { resolveRuntime } = require('../integrations/webpageFramework');
const { executeApiHandler } = require('../integrations/webpageApiRuntime');
const Ai = require('./webpagesPreviewAi');
const Ask = require('./webpagesPreviewAsk');

// W3 — window.beeflowTables: `/:id/tables/:tid/query|insert|update`. A file
// of its own because those routes run as THE LOGGED-IN VISITOR and not
// acts-as-author like everything below; see the header of webpagesPreviewTables.js.
router.use(require('./webpagesPreviewTables'));

// ── Database ─────────────────────────────────────────────────────────

router.post('/:id/db/query', requirePreviewToken, dbBridgeLimiter, async (req, res) => {
    const { userId, webpageId } = req.previewClaims;
    const { sql, params } = req.body || {};
    try {
        const result = await webpageDbStore.query(userId, webpageId, sql, params);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.post('/:id/db/exec', requirePreviewToken, dbBridgeLimiter, async (req, res) => {
    const { userId, webpageId } = req.previewClaims;
    const { sql, params } = req.body || {};
    try {
        const result = await webpageDbStore.exec(userId, webpageId, sql, params);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.post('/:id/db/batch', requirePreviewToken, dbBridgeLimiter, async (req, res) => {
    const { userId, webpageId } = req.previewClaims;
    const { statements } = req.body || {};
    try {
        const results = await webpageDbStore.batch(userId, webpageId, statements);
        res.json({ results });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.get('/:id/db/schema', requirePreviewToken, dbBridgeLimiter, async (req, res) => {
    const { userId, webpageId } = req.previewClaims;
    try {
        const schema = await webpageDbStore.schema(userId, webpageId);
        res.json(schema);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Light-tier backend: api/<route>.js handlers ──────────────────────
//
// The page calls /api/webpages-preview/:id/app/<route>; we run the matching
// api/<route>.js handler in an isolated-vm sandbox (acts-as-author). Only the
// light runtime tier uses this — the full tier proxies /app/* to the project's
// Node container instead (see the runtime manager).
router.all('/:id/app/*rest', requirePreviewToken, dbBridgeLimiter, async (req, res) => {
    const { webpageId } = req.previewClaims;
    const rest = req.params.rest;
    const route = Array.isArray(rest) ? rest.join('/') : (rest || '');

    // Gate to the light tier — the full tier serves its own backend.
    const wp = await webpageStore.getWebpageRaw(webpageId);
    if (resolveRuntime(wp) === 'full') {
        return res.status(409).json({ error: 'This project uses the full runtime tier; its backend runs in the project container.' });
    }

    const out = await executeApiHandler({
        webpageId,
        route,
        req: {
            method: req.method,
            path: route,
            query: req.query || {},
            body: (req.body && typeof req.body === 'object') ? req.body : {},
        },
    });
    if (out.headers) {
        for (const [k, v] of Object.entries(out.headers)) {
            try { res.setHeader(k, v); } catch (_) { /* ignore bad header */ }
        }
    }
    res.status(out.status || 200).json(out.body);
});

// ── AI bridge (./webpagesPreviewAi.js, ./webpagesPreviewAsk.js) ──────

router.post('/:id/ai/chat', requirePreviewToken, llmBridgeLimiter, Ai.chat);
router.post('/:id/ai/stream', requirePreviewToken, llmBridgeLimiter, Ai.stream);
router.post('/:id/ai/ask', requirePreviewToken, llmBridgeLimiter, Ask.ask);

// ── Automations bridge ───────────────────────────────────────────────

router.get('/:id/automations', requirePreviewToken, async (req, res) => {
    const { webpageId } = req.previewClaims;
    const ctx = await loadAuthorContext(webpageId);
    if (!ctx) return res.status(404).json({ error: 'Webpage not found' });
    const grants = ctx.bridgeGrants.automations || [];
    // Enrich each grant with the live automation metadata. Filters out
    // grants whose automation has since been deleted or transferred.
    const list = [];
    for (const g of grants) {
        const a = await automationStore.getAutomation(g.automationId).catch(() => null);
        if (!a) continue;
        if (a.userId !== ctx.authorUserId) continue;
        list.push({
            automationId: a.id,
            title: a.title,
            description: a.description || '',
            label: g.label || a.title,
            isActive: !!a.isActive,
        });
    }
    res.json({ automations: list });
});

router.post('/:id/automations/:autoId/run', requirePreviewToken, sideEffectBridgeLimiter, async (req, res) => {
    // See /ai/ask (webpagesPreviewAsk.js): the visitor is `viewerUserId`, the author is `userId`.
    const { viewerUserId, webpageId } = req.previewClaims;
    const autoId = req.params.autoId;
    const ctx = await loadAuthorContext(webpageId);
    if (!ctx) return res.status(404).json({ error: 'Webpage not found' });

    const grant = (ctx.bridgeGrants.automations || []).find(g => g.automationId === autoId);
    if (!grant) return res.status(403).json({ error: 'Automation not granted to this webpage' });

    const automation = await automationStore.getAutomation(autoId);
    if (!automation) return res.status(404).json({ error: 'Automation not found' });
    if (automation.userId !== ctx.authorUserId) return res.status(403).json({ error: 'Automation does not belong to the page author' });

    const runner = require('../core/automationRunner');
    const triggerPayload = {
        inputs: (req.body && typeof req.body.inputs === 'object') ? req.body.inputs : {},
        _viewerUserId: viewerUserId || null,
        _webpageId: webpageId,
    };
    // Best-effort 60s sync wait so the page gets a result without polling.
    // Long runs still complete server-side; the page can poll the run by ID.
    const wait = req.body?.wait !== false;
    if (wait) {
        const run = await runner.executeAutomation(automation, {
            triggerKind: 'webpage',
            triggerPayload,
            mode: 'live',
        });
        const steps = await automationStore.getRunSteps(run.id).catch(() => []);
        return res.json({ runId: run.id, status: run.status, output: run.output ?? null, error: run.error || null, steps });
    }
    // Async path: fire and respond with the run ID for polling.
    const run = await runner.executeAutomation(automation, {
        triggerKind: 'webpage',
        triggerPayload,
        mode: 'live',
    }).catch(err => ({ id: null, status: 'error', error: err.message }));
    res.json({ runId: run.id || null, status: run.status || 'pending', error: run.error || null });
});

router.get('/:id/automations/runs/:runId', requirePreviewToken, async (req, res) => {
    const { webpageId } = req.previewClaims;
    const ctx = await loadAuthorContext(webpageId);
    if (!ctx) return res.status(404).json({ error: 'Webpage not found' });
    const run = await automationStore.getRun(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.userId !== ctx.authorUserId) return res.status(403).json({ error: 'Forbidden' });
    res.json({ runId: run.id, status: run.status, error: run.error || null, output: run.output ?? null });
});

router.get('/:id/automations/runs/:runId/steps', requirePreviewToken, async (req, res) => {
    const { webpageId } = req.previewClaims;
    const ctx = await loadAuthorContext(webpageId);
    if (!ctx) return res.status(404).json({ error: 'Webpage not found' });
    const run = await automationStore.getRun(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.userId !== ctx.authorUserId) return res.status(403).json({ error: 'Forbidden' });
    const steps = await automationStore.getRunSteps(req.params.runId);
    res.json({ steps });
});

router.post('/:id/automations/runs/:runId/cancel', requirePreviewToken, async (req, res) => {
    const { webpageId } = req.previewClaims;
    const ctx = await loadAuthorContext(webpageId);
    if (!ctx) return res.status(404).json({ error: 'Webpage not found' });
    const run = await automationStore.getRun(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.userId !== ctx.authorUserId) return res.status(403).json({ error: 'Forbidden' });
    const runner = require('../core/automationRunner');
    await runner.requestCancel(req.params.runId);
    res.json({ ok: true });
});

// ── Integrations bridge ──────────────────────────────────────────────

router.get('/:id/integrations', requirePreviewToken, async (req, res) => {
    const { webpageId } = req.previewClaims;
    const ctx = await loadAuthorContext(webpageId);
    if (!ctx) return res.status(404).json({ error: 'Webpage not found' });
    const grants = ctx.bridgeGrants.integrations || [];
    const enriched = grants.map(g => {
        const owner = findOwnerOfTool(g.tool);
        const tools = owner ? loadTools(owner) : [];
        const def = tools.find(t => t?.function?.name === g.tool);
        return {
            tool: g.tool,
            label: g.label || (def?.function?.name || g.tool).replace(/_/g, ' '),
            description: def?.function?.description || '',
            schema: def?.function?.parameters || null,
            integrationId: owner?.app || null,
            hasFixedArgs: !!(g.fixedArgs && Object.keys(g.fixedArgs).length > 0),
        };
    });
    res.json({ integrations: enriched });
});

// Tier is picked per tool: read-only tools get the 60/min read bucket, anything
// that writes keeps the strict 10/min side-effect bucket (see the selector in
// webpagesPreviewRateLimits.js — fail-closed for unknown tools).
router.post('/:id/integrations/run', requirePreviewToken, integrationBridgeLimiter, async (req, res) => {
    const { webpageId } = req.previewClaims;
    const { tool, args } = req.body || {};
    if (typeof tool !== 'string' || !tool.trim()) return res.status(400).json({ error: 'tool is required' });
    const ctx = await loadAuthorContext(webpageId);
    if (!ctx) return res.status(404).json({ error: 'Webpage not found' });

    const grant = (ctx.bridgeGrants.integrations || []).find(e => e.tool === tool);
    if (!grant) return res.status(403).json({ error: `Tool "${tool}" not granted to this webpage` });

    // Merge viewer-supplied args with author-pinned fixedArgs. fixedArgs
    // ALWAYS wins — that's the whole point of pinning (author retains
    // control over sensitive fields like channel, recipient, sheet ID).
    const mergedArgs = { ...(args || {}), ...(grant.fixedArgs || {}) };

    const result = await executeTool(tool, mergedArgs, {
        userId: ctx.authorUserId,
        session: ctx.authorSession,
        orgId: ctx.authorOrgId,
        autoSend: true,
        // The page's integration bridge, acting as its author: the
        // chokepoint writes the egress row, grouped per page.
        egress: {
            source: 'webpage_bridge',
            ids: {
                organization_id: ctx.authorOrgId || null,
                user_id: ctx.authorUserId || null,
                automation_id: webpageId || null,
            },
        },
    });
    res.json({ result });
});

module.exports = router;
