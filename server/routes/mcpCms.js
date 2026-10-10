/**
 * The product website (CMS) as an MCP server — edit the whole site from an
 * external coding agent.
 *
 * `routes/mcpStudio.js` and `routes/mcpAutomations.js` expose the App Studio and
 * automation builders; this is the third of that family, for the admin CMS: the
 * pages, blocks, header, footer, translations and design of the product website,
 * photos and videos uploaded from the agent's own disk, screenshots of the
 * result, and — only with an explicit scope — publishing. Tools and the why:
 * cms/mcp/dispatch.js; the operator's view: docs/docs/studio/cms-mcp.md.
 *
 * ── Gate ────────────────────────────────────────────────────────────────────
 * Off unless CMS_MCP_ENABLED=1: index.js only requires and mounts this file when
 * cms/mcp isEnabled(), so on a default install the path does not exist. Behind
 * the flag, all of these must pass:
 *
 *   1. CMS_MCP_ENABLED=1                              (operator)
 *   2. the shared MCP access gate with the `cms` scope (auth/mcpAccess: token,
 *      account state, org policy, IP allow-lists, rate limit)
 *   3. the same admin test the CMS REST routes use    (cmsShared.canAdminCms)
 *   4. per tool: the token's scopes — publish and set-live need `cms.publish`
 *
 * ── Wiring it up ────────────────────────────────────────────────────────────
 *   claude mcp add --transport http beeflow-cms \
 *     https://<your-host>/mcp/cms --header "Authorization: Bearer bfmcp_…"
 *
 * ── Upload ──────────────────────────────────────────────────────────────────
 * `PUT /mcp/cms/upload/<ticketId>` is the one route here without a bearer: the
 * one-time ticket from cms_request_upload IS the credential (uploadTickets.js).
 * Its secret half travels in the `X-Upload-Ticket` header, not in the URL, so it
 * stays out of access logs and traces.
 * It is registered before any body parser and streams the raw request to disk.
 */

const express = require('express');
const { PROTOCOL_VERSION, classifyRpc, parseToolCall, INVALID_REQUEST } = require('./mcpServer');
const { gateRequest: authenticateMcpRequest, rpcDenied, evaluateAccessForOrgs } = require('../auth/mcpAccess/gate');
const { batchTooLarge, rpcBatchTooLarge } = require('../auth/mcpAccess/batch');
const { isActiveAccount } = require('../auth/accountStatusGate');
const log = require('../telemetry/log');

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/**
 * The admin test the CMS REST routes use (cmsShared.canAdminCms). One function
 * for the tools, the upload receiver and routes/mcpTokens.js (which refuses a
 * `cms` scope for a user who fails it).
 */
const isCmsAdmin = (user) => require('./cmsShared').canAdminCms({ isAdmin: user?.role === 'admin', user });

/** The real collaborators, built on first use so requiring this file stays cheap. */
function buildRuntime() {
    const cmsMcp = require('../cms/mcp');
    const cmsStore = require('../stores/cmsStore');
    const storageStore = require('../stores/storageStore');
    const userStore = require('../stores/userStore');
    const cmsParts = {
        ...require('../stores/cms/shared'),
        ...require('../stores/cms/localeOverrides'),
    };
    const cmsShared = require('./cmsShared');
    const cmsMedia = require('./cmsMedia');
    const { sanitizeSvg } = require('../utils/svgSanitizer');
    const builder = require('../cmsBuilder/builderTools');
    const { validateSiteDraft } = require('../cmsBuilder/validate');
    const { SITE_DEFAULTS } = require('../i18n/defaults/cmsDefaults');
    const mcpAccess = require('../auth/mcpAccess');

    const isAdmin = isCmsAdmin;
    const tickets = cmsMcp.createUploadTickets();
    const screenshots = cmsMcp.createScreenshotRenderer();

    const mcp = cmsMcp.createCmsMcp({
        cmsStore,
        cmsParts: { collectLocaleOverrides: cmsParts.collectLocaleOverrides, deepMerge: cmsParts.deepMerge, sanitizeAnalytics: cmsParts.sanitizeAnalytics },
        builder,
        validateDraft: validateSiteDraft,
        defaults: { SITE_DEFAULTS },
        access: { scopeAllowsTool: mcpAccess.scopeAllowsTool, filterToolsByScope: mcpAccess.filterToolsByScope },
        live: {
            getLiveSiteId: cmsShared.getLiveSiteId,
            setLiveSiteId: cmsShared.setLiveSiteId,
            ensurePublishedSnapshot: cmsShared.ensurePublishedSnapshot,
            SITE_ID_RE: cmsShared.SITE_ID_RE,
        },
        // Same best-effort analytics provisioning the REST publish does.
        afterPublish: async (siteId, ctx) => {
            const project = await cmsStore.getProject(siteId).catch(() => null);
            await require('./cmsAnalytics').provisionAnalyticsForSite(siteId, {
                name: project?.name || 'CMS site',
                domain: ctx.host || undefined,
            });
        },
        tickets,
        screenshots,
        storage: { isAvailable: () => storageStore.isAvailable(), listKeys: (prefix) => storageStore.listKeys(prefix) },
        audit: (...a) => userStore.logAccessAudit(...a),
        isAdmin,
        rpc: { classifyRpc, parseToolCall, PROTOCOL_VERSION, INVALID_REQUEST },
    });

    const receiver = cmsMcp.createUploadReceiver({
        tickets,
        storage: storageStore,
        streamIntoStorage: cmsMedia.streamIntoStorage,
        sanitizeSvg,
        isValidVtt: cmsMedia.isValidVtt,
        looksLikeClip: cmsMedia.looksLikeClip,
        checkAccess: cmsMcp.createAccessCheck({
            getTokenById: mcpAccess.getTokenById,
            getUser: (id) => userStore.getUser(id),
            resolveOrgs: (user) => require('../auth/mcpAccess/orgResolve').resolveMcpOrgs(user),
            getOrgPolicy: mcpAccess.getOrgMcpPolicy,
            evaluateAccessForOrgs,
            isActiveAccount,
            scopeAllowsTool: mcpAccess.scopeAllowsTool,
            isAdmin,
        }),
    });

    return { mcp, receiver };
}

/**
 * @param {{ runtime?: () => { mcp: object, receiver: object }, gate?: { gateRequest: Function, rpcDenied: Function },
 *           publicBaseUrl?: (req: object) => string }} [injected] test seams
 */
function makeRouter(injected = {}) {
    const router = express.Router();
    let runtime = null;
    const getRuntime = () => {
        if (!runtime) runtime = (injected.runtime || buildRuntime)();
        return runtime;
    };
    // Test seams for the gate; production uses the shared access gate.
    const verifyCmsAccess = (req) => (injected.gate ? injected.gate.gateRequest(req, 'cms') : authenticateMcpRequest(req, 'cms'));
    const deny = (res, access) => (injected.gate ? injected.gate.rpcDenied : rpcDenied)(res, access.status, null, access.retryAfter);
    const baseUrlOf = (req) => (injected.publicBaseUrl
        ? injected.publicBaseUrl(req)
        : require('../automation/publicUrl').resolvePublicBaseUrl(req));

    // The upload route authenticates by TICKET, not by bearer: the one-time
    // ticket (id in the path, secret in X-Upload-Ticket) is the credential. verifyUploadTicket checks it, binds
    // the content type and size, re-applies the org policy and burns it, then
    // streams the body (cms/mcp/uploadReceiver.js).
    const verifyUploadTicket = (req, contentLength) => getRuntime().receiver.handle({
        // A missing or repeated header yields a malformed ticket, refused like any other.
        ticket: `${req.params.ticketId}.${typeof req.headers['x-upload-ticket'] === 'string' ? req.headers['x-upload-ticket'] : ''}`,
        contentType: req.headers['content-type'],
        contentLength,
        ip: req.ip,
        stream: req,
    });

    // Registered before any body parser of this router: the body is a raw file.
    router.put('/upload/:ticketId', async (req, res) => {
        const declared = req.headers['content-length']; // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- anchored digit class, linear
        const contentLength = declared !== undefined && /^\d+$/.test(declared) ? Number(declared) : null;
        const out = await verifyUploadTicket(req, contentLength);
        if (out.closeConnection) {
            // The body was not (all) read. Answer, then drop the connection so
            // the rest of a large file is not pushed at us for nothing.
            res.set('Connection', 'close');
            res.on('finish', () => { if (!req.complete) req.destroy(); });
        }
        if (out.status === 200) {
            const base = baseUrlOf(req);
            return res.status(200).json({ ...out.body, ...(base ? { absoluteUrl: `${base}${out.body.url}` } : {}) });
        }
        return res.status(out.status).json(out.body);
    });

    // Streamable HTTP: one POST carrying a JSON-RPC message or a batch. 8 MB
    // like /mcp/studio: a page worth of blocks in one tool call.
    router.post('/', express.json({ limit: '8mb' }), async (req, res) => {
        const access = await verifyCmsAccess(req);
        if (!access.ok) return deny(res, access);
        const ctx = {
            user: access.user,
            userId: access.user.id,
            orgId: access.orgId || null,
            token: access.token,
            baseUrl: baseUrlOf(req),
            host: req.get('host'),
        };

        if (batchTooLarge(req.body)) return rpcBatchTooLarge(res);
        const body = req.body;
        const messages = Array.isArray(body) ? body : [body];
        const responses = [];
        for (const message of messages) {
            try {
                const out = await getRuntime().mcp.handleRpc(message, ctx);
                if (out) responses.push(out);
            } catch (err) {
                log.error('[cms-mcp] handler error:', err.message);
                // Only a request is answered — not even an error goes back to a notification.
                if (classifyRpc(message).kind === 'request') responses.push(rpcError(message.id, -32603, 'Internal error'));
            }
        }
        if (!responses.length) return res.status(202).end();
        return res.json(Array.isArray(body) ? responses : responses[0]);
    });

    // Same honest answer as /mcp: no SSE stream is opened, so say so.
    router.get('/', async (req, res) => {
        const access = await verifyCmsAccess(req);
        if (!access.ok) return deny(res, access);
        return res.status(405).json(rpcError(null, -32000, 'This MCP endpoint is POST-only; it does not open an SSE stream.'));
    });

    return router;
}

module.exports = makeRouter();
module.exports.makeRouter = makeRouter;
module.exports.isCmsAdmin = isCmsAdmin;
