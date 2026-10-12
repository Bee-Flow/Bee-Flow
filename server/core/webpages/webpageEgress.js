/**
 * The Privacy Shield, for a webpage's light-tier api/ handler.
 *
 * WHY THIS EXISTS. integrations/webpageApiRuntime.js runs author-written
 * JavaScript in the SAME isolated-vm sandbox the automation `code` step uses
 * (automation/codeSandbox.js) — but it handed that sandbox
 * `fetchHttp: codeSandbox.defaultFetchHttp` and an executeTool that called the
 * dispatcher directly. So the two callers of one sandbox had opposite
 * postures: a code step's tool calls and fetches go through the shield and
 * land in the outbound ledger, and a webpage handler's did neither — at 2-4x
 * the limits, acting as the page's AUTHOR rather than its visitor, and with a
 * `db` bridge no automation gets.
 *
 * That is not a small gap in a product sold on "personal data does not leave
 * Bee Flow" (CLAUDE.md, BFSF-441). A handler could read the page's SQLite and
 * POST it anywhere, with no scan and no row saying it happened.
 *
 * WHAT THIS IS NOT. It does not cover the rest of the webpages surface. The
 * AI bridge (routes/webpagesPreview.js) sends page content to a model and is
 * still unguarded — it logs spend, not egress. That gap is recorded as a row
 * in core/automationRunner/egressCoverage.test.js rather than left to be
 * rediscovered, which is the lesson that file's own header records.
 *
 * WHY IT IS NOT execOutbound's factory. The guarded bridges in
 * core/automationRunner/execOutbound.js are welded to a run: a `step`, a run
 * id, a run vault for tokenize/untokenize, a dry-run `mode`. A webpage request
 * has none of those. Extracting that factory would mean editing the egress
 * path of every automation in the product to serve a caller that shares none of
 * its context — so the SEQUENCE is reproduced here and the DECISIONS are not:
 * policy, scanning, masking and the ledger all come from the one
 * core/automationRunner/safety.js. A drift test pins that.
 *
 * TWO DELIBERATE DIFFERENCES FROM A AUTOMATION, both the safe direction:
 *
 *   1. The shield stays ON even when an org has switched off "Apply to
 *      automations". A webpage handler is not an automation, and that switch's label
 *      is exactly what it says. Inheriting it would silently widen an opt-out
 *      the admin never gave.
 *   2. Values are never restored from a run vault. `restoreForRunState` puts
 *      real values back for downstream STEPS inside one run; there is no run
 *      and no next step here — whatever the handler returns goes to a browser.
 *      So a tokenize/redact policy's masking survives all the way out.
 */

const safety = require('../automationRunner/safety');
const { isPrivateHostname } = require('../../utils/ssrfGuard');
const { HTTP_RESPONSE_CAP } = require('../../automation/httpResponseLimits');
// Each outbound call runs in its own capture context (core/http/captureCall.js).
const { captureCall: captured } = require('../http/captureCall');

/** Ledger + guardrail rows say where this came from. */
const WEBPAGE_SOURCE = 'webpage_api';

// A webpage request is always a real run: there is no dry-run mode for a
// visitor's HTTP call, so the guards run in their live posture.
const LIVE = 'live';

function hostOf(url) {
    try { return new URL(String(url)).hostname; } catch { return ''; }
}

/**
 * Build the policy + audit identity once per request.
 *
 * `ctx` is the author context webpageBridgeAuth.loadAuthorContext returns,
 * plus the webpage id. The shape mirrors what safety.js reads off a run
 * context, so the same helpers work unchanged.
 */
async function resolveWebpagePolicy({ webpageId, authorUserId, authorOrgId, pageTitle = null }) {
    const ctx = {
        orgId: authorOrgId || null,
        userId: authorUserId || null,
        // Grouped per page in the ledger the way an automation's rows group per
        // automation, so "what did this page send" is one query.
        automationId: webpageId || null,
        automationTitle: pageTitle,
        runId: null,
    };
    const policy = await safety.resolveAutomationPolicy(ctx, { honourAutomationOptOut: false });
    const auditBase = safety.buildAuditBase(ctx, { id: `webpage:${webpageId}` }, { source: WEBPAGE_SOURCE });
    return { ctx, policy, auditBase };
}

/**
 * Guard one outbound payload, the same order execOutbound.guardOutbound uses:
 * scan the input, then decide what may actually leave.
 *
 * Throws the shield's own GuardrailBlockError when a `block` policy refuses —
 * callers turn that into the sandbox's `{ error }` shape, which is what a
 * refused URL or a disallowed tool already looks like to handler code.
 */
async function guardWebpageOutbound({ ctx, policy, auditBase }, { toolName, payload, destination, integMeta = null }) {
    let guarded;
    try {
        guarded = await safety.guardToolInput(payload, policy, auditBase, LIVE, ctx);
    } catch (err) {
        if (err && err.guardrailBlocked) {
            await safety.logEgress({
                toolName, toolArgs: {}, blocked: true, error: err,
                policy, auditBase, mode: LIVE, integMeta, durationMs: 0,
            });
        }
        throw err;
    }
    return safety.prepareForEgress(guarded.value, policy, ctx, { destination });
}

/**
 * The guarded `ctx.integrations.<tool>()` bridge.
 *
 * `dispatch(toolName, args)` is the caller's own acts-as-author dispatcher —
 * this wraps it rather than replacing it, so the grant check and fixedArgs
 * merge stay where they are.
 */
function makeToolBridge(session, { grantByTool, dispatch }) {
    return async (toolName, args) => {
        const grant = grantByTool.get(toolName);
        if (!grant) return { error: `Tool "${toolName}" is not granted to this page.` };

        const { resolveIntegration } = require('../integrations/integrationToolMap');
        const integMeta = resolveIntegration(toolName, args || {}, {});
        let payload;
        try {
            payload = await guardWebpageOutbound(session, {
                toolName,
                payload: { ...(args || {}), ...(grant.fixedArgs || {}) },
                destination: integMeta && integMeta.isLocal ? 'internal' : 'external',
                integMeta,
            });
        } catch (err) {
            if (err && err.guardrailBlocked) return { error: err.message };
            throw err;
        }

        const t0 = Date.now();
        const call = await captured(() => dispatch(toolName, payload));
        try {
            if (!call.ok) throw call.error;
            const value = call.value;
            await safety.logEgress({
                toolName, toolArgs: payload, result: value, probe: call.probe,
                policy: session.policy, auditBase: session.auditBase, mode: LIVE,
                integMeta, durationMs: Date.now() - t0,
            });
            // The RESULT is what the handler sees and may put in its response,
            // so it is scanned on the way back too — the same contract
            // execIntegrationAction keeps. Not restored from a vault: there is
            // no next step here, only a browser.
            const out = await safety.guardToolOutput(value, session.policy, session.auditBase, LIVE, session.ctx);
            return out.result;
        } catch (err) {
            await safety.logEgress({
                toolName, toolArgs: payload, error: err, probe: call.probe,
                policy: session.policy, auditBase: session.auditBase, mode: LIVE,
                integMeta, durationMs: Date.now() - t0,
            });
            throw err;
        }
    };
}

/**
 * The guarded `ctx.http()` bridge.
 *
 * `rawFetch` is codeSandbox.defaultFetchHttp — HTTPS-only, SSRF-screened and
 * response-capped already. What this adds is the shield and the ledger: the
 * URL, the body and the REQUEST HEADERS are all egress (the header hole is one
 * the code step had to close separately), and the response comes back through
 * the output scan.
 */
function makeHttpBridge(session, { rawFetch }) {
    return async (url, options) => {
        const host = hostOf(url);
        const integMeta = {
            integration: 'webpage_http', label: host || 'http',
            server: host ? `https://${host}` : null, direction: 'both',
            dataCategories: 'auto_detected', isLocal: isPrivateHostname(host),
        };
        // Headers arrive JSON-parsed from the isolate, so a plain object is the
        // only guardable shape; anything else is left alone rather than being
        // flattened into one.
        const rawHeaders = options && options.headers;
        const headers = (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders))
            ? rawHeaders : undefined;

        let payload;
        try {
            payload = await guardWebpageOutbound(session, {
                toolName: 'webpage_fetch_http',
                payload: { url: String(url), body: options && options.body, headers },
                destination: isPrivateHostname(host) ? 'internal' : 'external',
                integMeta,
            });
        } catch (err) {
            if (err && err.guardrailBlocked) return { error: err.message };
            throw err;
        }

        // What travels is built FROM THE GUARDED RESULT, never from the
        // handler's object — that is the whole point of the guard.
        const sendOptions = { ...(options || {}) };
        if (payload.body !== undefined) sendOptions.body = payload.body;
        if (headers) sendOptions.headers = payload.headers || {};

        const t0 = Date.now();
        const call = await captured(() => rawFetch(payload.url, sendOptions));
        let res;
        try {
            if (!call.ok) throw call.error;
            res = call.value;
            await safety.logEgress({
                toolName: 'webpage_fetch_http', toolArgs: { url: payload.url },
                result: { ok: true }, probe: call.probe, policy: session.policy, auditBase: session.auditBase,
                mode: LIVE, integMeta, durationMs: Date.now() - t0,
            });
        } catch (err) {
            await safety.logEgress({
                toolName: 'webpage_fetch_http', toolArgs: { url: payload.url }, error: err, probe: call.probe,
                policy: session.policy, auditBase: session.auditBase, mode: LIVE,
                integMeta, durationMs: Date.now() - t0,
            });
            throw err;
        }

        try {
            const guarded = await safety.guardToolOutput(res, session.policy, session.auditBase, LIVE, session.ctx);
            return guarded.result;
        } catch (err) {
            if (err && err.guardrailBlocked) return { error: err.message };
            throw err;
        }
    };
}

/**
 * Guard whatever the handler RETURNS.
 *
 * The return value becomes the HTTP response body, so it is the last and
 * widest way out: a handler that queried the page's own SQLite and returned
 * the rows has moved personal data to a browser without any tool call or
 * fetch. Same treatment the code step gives its own return value.
 */
async function guardWebpageResult(session, value) {
    const guarded = await safety.guardToolOutput(value, session.policy, session.auditBase, LIVE, session.ctx);
    return guarded.result;
}

module.exports = {
    WEBPAGE_SOURCE,
    resolveWebpagePolicy,
    makeToolBridge,
    makeHttpBridge,
    guardWebpageResult,
    HTTP_RESPONSE_CAP,
};
