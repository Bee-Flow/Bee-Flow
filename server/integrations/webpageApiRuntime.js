/**
 * Webpage light-tier API runtime.
 *
 * Runs a project's `api/<route>.js` handler files server-side in an isolated-vm
 * sandbox (server/automation/codeSandbox.js) — the "light tier" backend. This
 * gives react-mui / vanilla pages a real request→response backend without a
 * per-project container: handlers get the per-page SQLite, the author's granted
 * integrations (acts-as-author), and an HTTPS fetch, all behind hard limits.
 *
 * Handler contract — an `api/<route>.js` file defines:
 *     async function main(req, ctx) {
 *       // req  = { method, path, query, body }
 *       // ctx.db.query(sql, params) / ctx.db.exec(...) / ctx.db.batch(...)
 *       // ctx.integrations.<granted_tool>(args)   (acts-as-author)
 *       // ctx.http(url, opts)                       (https only)
 *       // ctx.log(...)
 *       return { status: 200, body: { ... } };       // or just return a value
 *     }
 *
 * The full tier (settings.runtime === 'full') runs these in the project's Node
 * container instead — this module is only used for the light tier.
 */

const codeSandbox = require('../automation/codeSandbox');
const webpageStore = require('../stores/webpageStore');
const webpageDbStore = require('../stores/webpageDbStore');
const { loadAuthorContext } = require('../core/webpages/webpageBridgeAuth');
const { executeTool } = require('../core/tools/toolDispatcher');
const webpageEgress = require('../core/webpages/webpageEgress');

const LIMITS = { memoryMb: 128, cpuMs: 4000, wallMs: 12000, httpBudget: 10 };

/** Normalise a request route into a safe `api/<route>.js` extra-file path. */
function handlerPathForRoute(route) {
    const clean = String(route || '')
        .replace(/\.js$/i, '')
        .replace(/^\/+|\/+$/g, '')
        .split('/')
        .filter(seg => seg && seg !== '.' && seg !== '..')
        .map(seg => seg.replace(/[^A-Za-z0-9_\-]/g, ''))
        .filter(Boolean)
        .join('/');
    if (!clean) return null;
    return `api/${clean}.js`;
}

/**
 * Execute a light-tier api handler. Returns { status, body, headers? }.
 * `req` is the sanitised request envelope { method, path, query, body }.
 */
async function executeApiHandler({ webpageId, route, req }) {
    if (!codeSandbox.isAvailable()) {
        // isolated-vm's native binding is ABI-pinned to the deployment Node
        // version (see server/CLAUDE.md) — a mismatched Node build makes it
        // unloadable, not the handler's fault. `code` lets the editor show an
        // actionable "runtime unavailable" state instead of a generic error.
        return {
            status: 503,
            body: { error: 'Backend runtime unavailable (isolated-vm not installed or ABI-mismatched for this Node version).', code: 'runtime_unavailable', tier: 'light' },
        };
    }

    const path = handlerPathForRoute(route);
    if (!path) return { status: 404, body: { error: 'No api route specified.' } };

    // Acts-as-author: load the page owner's context so the handler reaches the
    // author's DB + granted integrations (never the viewer's).
    const ctx = await loadAuthorContext(webpageId);
    if (!ctx) return { status: 404, body: { error: 'Webpage not found.' } };

    const file = await webpageStore.readExtraFile({ webpageId, userId: ctx.authorUserId, path });
    if (!file || !file.meta?.isText) {
        return { status: 404, body: { error: `No handler at ${path}. Create it with an exported main(req, ctx).` } };
    }

    // Only the author's GRANTED integrations are callable (same allowlist the AI
    // bridge uses), with pinned fixedArgs merged in server-side.
    const grantByTool = new Map();
    for (const g of (ctx.bridgeGrants?.integrations || [])) grantByTool.set(g.tool, g);

    // The Privacy Shield, which this runtime used to skip entirely — it handed
    // the isolate `codeSandbox.defaultFetchHttp` raw and called the dispatcher
    // direct, so a handler could read the page's SQLite and POST it anywhere
    // with no scan and no ledger row. Same sandbox as the automation code step,
    // opposite posture. See core/webpages/webpageEgress.js.
    const session = await webpageEgress.resolveWebpagePolicy({
        webpageId,
        authorUserId: ctx.authorUserId,
        authorOrgId: ctx.authorOrgId,
        pageTitle: ctx.webpage?.title || null,
    });

    const bridges = {
        allowedTools: new Set(grantByTool.keys()),
        // The grant check and the fixedArgs merge stay here; the guard wraps
        // the dispatch rather than replacing it.
        executeTool: webpageEgress.makeToolBridge(session, {
            grantByTool,
            dispatch: (toolName, guardedArgs) => executeTool(toolName, guardedArgs, {
                userId: ctx.authorUserId,
                session: ctx.authorSession,
                orgId: ctx.authorOrgId,
                autoSend: true,
                // makeToolBridge writes this call's ledger row (with the probe
                // it runs the dispatch in), so the dispatcher must not.
                egress: false,
            }),
        }),
        db: async (op, a) => {
            if (op === 'query') return webpageDbStore.query(ctx.authorUserId, webpageId, a.sql, a.params || []);
            if (op === 'exec') return webpageDbStore.exec(ctx.authorUserId, webpageId, a.sql, a.params || []);
            if (op === 'batch') return webpageDbStore.batch(ctx.authorUserId, webpageId, a.statements || []);
            return { error: `unknown db op "${op}"` };
        },
        // defaultFetchHttp is already HTTPS-only, SSRF-screened and capped;
        // what the wrapper adds is the PII scan on url/body/headers, the
        // response scan, and the outbound-ledger row.
        fetchHttp: webpageEgress.makeHttpBridge(session, { rawFetch: codeSandbox.defaultFetchHttp }),
        secrets: {},
    };

    let runResult;
    try {
        runResult = await codeSandbox.runCode({
            code: file.text, inputs: req, limits: LIMITS, bridges,
            // Fairness unit for the sandbox's concurrency cap: the page author's org.
            concurrencyKey: ctx.authorOrgId || ctx.authorUserId || null,
        });
    } catch (err) {
        return { status: 500, body: { error: err.message || 'Handler execution failed.' } };
    }

    // The RETURN VALUE is the widest way out and the one no bridge sees: a
    // handler that queried the page's own SQLite and returned the rows has
    // moved personal data to a browser without a single tool call or fetch.
    // Scanned like the code step scans its own result. A `block` policy comes
    // back as the sandbox's `{ error }` shape, so it surfaces as a 502 rather
    // than shipping the body it refused.
    let r;
    try {
        r = await webpageEgress.guardWebpageResult(session, runResult.result);
    } catch (err) {
        if (err && err.guardrailBlocked) {
            return { status: 502, body: { error: err.message, code: 'blocked_by_privacy_shield' } };
        }
        throw err;
    }

    // Normalise the handler's return value into an HTTP-shaped response.
    if (r && typeof r === 'object' && !Array.isArray(r) && ('body' in r || 'status' in r)) {
        return {
            status: Number.isInteger(r.status) ? r.status : 200,
            body: r.body !== undefined ? r.body : null,
            headers: (r.headers && typeof r.headers === 'object') ? r.headers : undefined,
        };
    }
    return { status: 200, body: r ?? null };
}

module.exports = { executeApiHandler, handlerPathForRoute };
