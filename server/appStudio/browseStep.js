/**
 * ai_browse — the gated executor behind the streaming browse step.
 *
 * Reuses integrations/browserFetchTools.executeBrowseWebTool WHOLESALE (queue
 * slots, session events, result shaping) — this module only adds the App
 * Studio gate chain, the domain-allowlist plumbing and the audit trail, then
 * bridges the browse driver's SSE events onto the step-stream wire.
 *
 * Gate chain (ALL before a browser slot is taken):
 *   1. definition.aiBrowsing.enabled === true   — per-app, HUMAN-set opt-in
 *   2. the OWNER's browser-fetch integration is on — the org kill switch
 *      (browser-fetch is AUTO_ON but org-admin-revocable)
 *   3. a browser backend is actually reachable
 *
 * Identity: acts-as-owner (every App Studio AI step does), viewer ATTRIBUTED
 * in the usage + activity rows. The effective allowlist is the app-level list
 * NARROWED by the step's own allowedDomains (intersection) — a step can only
 * ever restrict, never widen.
 */

'use strict';

const usageStore = require('../stores/usageStore');
const integrationActivityStore = require('../stores/integrationActivityStore');

/** app-level ∩ step-level (suffix-aware). Empty app list = no confinement. */
function effectiveAllowlist(appDomains, stepDomains) {
    const norm = (list) => (Array.isArray(list) ? list : [])
        .map((d) => String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, ''))
        .filter(Boolean);
    const app = norm(appDomains);
    const step = norm(stepDomains);
    if (!app.length && !step.length) return null;      // unconfined (org-open)
    if (!app.length) return step;
    if (!step.length) return app;
    // Keep a step host only if the app allows it (exact or as a subdomain).
    const kept = step.filter((s) => app.some((a) => s === a || s.endsWith(`.${a}`)));
    return kept; // may be [] → the step confined itself out of the app's scope
}

/**
 * @param {object} app   the studio app row (userId = owner)
 * @param {object} def   the definition being run (carries aiBrowsing)
 * @param {object} step  the ai_browse step
 * @param {object} ctx   executor context + { browse: { send, isCancelled } } + resolve helpers
 * @param {object} helpers  { resolveBinding, buildServerScope }
 * @returns {Promise<{ok:boolean, result?:object, error?:string, code?:string}>}
 */
async function executeBrowseStep(app, def, step, ctx, helpers) {
    const { resolveBinding, buildServerScope } = helpers;
    const send = ctx.browse?.send || (() => {});
    const isCancelled = ctx.browse?.isCancelled || (() => false);

    // 1) Per-app opt-in — HUMAN-set; the builder cannot switch it on.
    if (def?.aiBrowsing?.enabled !== true) {
        return { ok: false, code: 'browse_not_enabled', error: 'AI browsing is not enabled for this app — the owner can turn it on in App settings.' };
    }

    // 2) Owner kill switch — the org integration toggle, resolved for the OWNER.
    //
    // isIntegrationPermittedForUser, NOT getUserPermittedApps: the latter only
    // returns apps that are in TOOL_REGISTRY, and browse_web is registered
    // inline rather than as a TOOLS-array module. So `permitted.has('browser-fetch')`
    // was false for every user on every deployment, and this step could never
    // run — the org toggle it claims to read was never actually consulted.
    try {
        const { isIntegrationPermittedForUser } = require('../core/integrations/integrationTools');
        const has = await isIntegrationPermittedForUser({ userId: app.userId, appId: 'browser-fetch' });
        if (!has) {
            return { ok: false, code: 'browse_disabled', error: 'Web browsing is turned off for this workspace.' };
        }
    } catch (e) {
        return { ok: false, code: 'browse_gate_error', error: 'Could not verify browsing access.' };
    }

    // 3) Backend probe — never spins the container up, just checks it can be.
    try {
        const pwtRunner = require('../services/pwtRunner');
        const hasBackend = !!process.env.BROWSER_WS_ENDPOINT || await pwtRunner.dockerAvailable();
        if (!hasBackend) {
            return { ok: false, code: 'browse_no_backend', error: 'The browsing engine is not available on this server.' };
        }
    } catch (_) {
        return { ok: false, code: 'browse_no_backend', error: 'The browsing engine is not available on this server.' };
    }

    const scope = buildServerScope(ctx);
    const resolve = (b) => (b === undefined || b === null ? null : resolveBinding(b, ctx, scope));
    const task = String(resolve(step.task) ?? '').trim();
    const url = String(resolve(step.url) ?? '').trim() || null;
    if (!task && !url) return { ok: false, code: 'browse_no_task', error: 'The browse task is empty.' };

    const allowedHosts = effectiveAllowlist(def.aiBrowsing.allowedDomains, step.allowedDomains);
    if (Array.isArray(allowedHosts) && allowedHosts.length === 0) {
        return { ok: false, code: 'browse_domains_empty', error: 'This step\'s allowed domains fall outside the app\'s allowed domains — nothing is reachable.' };
    }

    const t0 = Date.now();
    const { executeBrowseWebTool } = require('../integrations/browserFetchTools');
    const { outsideProbe, withPeers } = require('../core/http/egressCapture');
    // The driver emits browser_session_* / browser_frame / browser_action via
    // this `send`; the route's bridge maps those names onto the step-stream
    // wire. We hand it the SAME shape the chat path uses.
    //
    // Outside any capture context: this process only talks to the private
    // browser container, whose socket says nothing about where the pages were.
    const answer = await outsideProbe(() => executeBrowseWebTool('browse_web', { task, url }, {
        send,
        userId: app.userId,
        orgId: app.organizationId || null,
        allowedHosts,
        isCancelled,
        maxSteps: Number.isInteger(step.maxSteps) ? step.maxSteps : null,
    }));

    // executeBrowseWebTool returns a markdown STRING (its own answer/queue/error
    // shaping). Extract the visited-URL list for the audit row without re-deriving.
    const text = typeof answer === 'string' ? answer : '';
    const visitedUrls = [...text.matchAll(/^- (https?:\/\/\S+)$/gm)].map((m) => m[1]).slice(0, 20);
    // Where the browser went, by host: the addresses live in the browser
    // container, so each peer says 'browser' and carries no IP of its own.
    const probe = withPeers(null, [url, ...visitedUrls].filter(Boolean).map((u) => {
        try { return { host: new URL(u).hostname, ip: null, basis: 'browser', method: 'GET', sentBody: false }; } catch { return null; }
    }).filter(Boolean));

    // Audit: owner-attributed usage row + an integration-activity row carrying
    // WHO watched, which app and where the agent went.
    try {
        usageStore.logUsage({
            userId: app.userId,
            organizationId: app.organizationId || null,
            agentType: 'studio_app',
            source: 'studio_app_browse',
            model: null,
            promptTokens: 0, completionTokens: 0, totalTokens: 0,
            durationMs: Date.now() - t0,
        }).catch(() => {});
    } catch { /* billing must never break a step */ }
    try {
        integrationActivityStore.logIntegrationActivity({
            organization_id: app.organizationId || null,
            user_id: app.userId,
            acting_user_id: ctx.viewerId || null,
            tool_name: 'browse_web',
            integration_type: 'browser-fetch',
            data_direction: 'sent',
            source: 'studio_app_browse',
            probe,
            is_local_hint: false,
            status: 'success',
            duration_ms: Date.now() - t0,
            data_summary: JSON.stringify({ appId: app.id, actionId: ctx.actionId || null, taskHead: task.slice(0, 200), visitedUrls }),
        }).catch(() => {});
    } catch { /* audit is best-effort */ }

    return {
        ok: true,
        result: {
            answer: text.slice(0, 16000),
            truncated: text.length > 16000,
            visitedUrls,
        },
    };
}

module.exports = { executeBrowseStep, effectiveAllowlist };
