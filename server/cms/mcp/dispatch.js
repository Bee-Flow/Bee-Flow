/**
 * CMS over MCP — JSON-RPC handling and tool dispatch.
 *
 * WHY THIS EXISTS: the website of the product is edited in the admin CMS. This
 * is the same editing surface for an external coding agent (Claude Code), so it
 * can change the WHOLE site — pages, blocks, header, footer, translations —
 * upload local photos and videos, look at its own work in screenshots and, only
 * with an explicit scope, publish. See routes/mcpCms.js for the mount and
 * docs/docs/studio/cms-mcp.md for the operator view.
 *
 * NO SECOND WRITE PATH. Page and design edits run the in-product builder's own
 * apply functions (cmsBuilder/builderTools.js) against a draft loaded per call,
 * and everything else goes through the same stores and validators the REST
 * routes use. Nothing here writes a config row directly except the upload
 * tickets, which are not site content.
 *
 * STATELESS. MCP has no turn: every tools/call is its own HTTP request, so the
 * draft is re-read from the store each time and `siteId` rides on every call.
 *
 * Every collaborator is injected (see createCmsMcp) so the dispatch is tested
 * without a database, a browser or the access gate; routes/mcpCms.js wires the
 * real ones.
 */

'use strict';

const log = require('../../telemetry/log');
const { ANALYTICS_TOOLS, MCP_ONLY_TOOLS, PUBLISH_TOOLS, buildToolList: buildList } = require('./tools');
const { createAnalyticsHandlers } = require('./analytics');
const { createBlogHandlers } = require('./blog');
const { createRedirectHandlers } = require('./redirects');
const { createLinkHandlers } = require('./linkHandlers');
const { isPlainObject, createTakeBudget } = require('./handlerKit');
const { createSiteContext } = require('./siteContext');
const { createSiteHandlers, createLocaleHandlers } = require('./siteHandlers');
const { createAssetHandlers, createScreenshotHandler, SHOT_WINDOW_MS, SHOT_MAX_PER_WINDOW } = require('./mediaHandlers');
const { createPublishHandlers } = require('./publishHandlers');

const ANALYTICS_WINDOW_MS = 10 * 60 * 1000;
const ANALYTICS_MAX_PER_WINDOW = 60;

/**
 * Sent on initialize. MCP clients put it in the model's context, so it says the
 * few things a caller cannot read off the tool schemas.
 */
const INSTRUCTIONS = [
    'Bee Flow website CMS. These tools edit the product website of this Bee Flow instance in the admin CMS.',
    '',
    'Model: a SITE is a draft you edit (cms_list_sites). Only the live site is served to visitors, and only its PUBLISHED snapshot: edits stay private until cms_publish. Every tool takes an optional siteId and defaults to the live site.',
    '',
    'Start: cms_list_sites, then cms_list_site (pages, design summary) and cms_get_site_settings (header, footer, cookie banner, announcement). Edit pages with the page and block tools, site chrome with cms_update_site_settings / cms_update_header_nav, colours and fonts with cms_update_design, translations with cms_set_locale_override.',
    '',
    'Images and video: never put file contents into a tool. cms_request_upload returns a one-time URL and a curl command; run it in a shell and use the asset url from its answer in a block (cms_list_assets shows what exists).',
    '',
    'Check your work: cms_screenshot (draft or published, desktop/tablet/mobile) and actually look at the image. Tool results carry `validation` warnings after edits and `_fixHint` when a call was rejected; both are worth reading.',
    '',
    'Website analytics (cms_analytics_*, super admin only, read-only): aggregated visitor, pageview, source, page and web-vitals numbers, never individual visitors. Start with cms_analytics_status; a plain sentence means analytics is not set up.',
    '',
    'Publishing (cms_publish, cms_set_live_site) needs the cms.publish scope on the token and is audited. Only publish when asked to.',
    '',
    'Blog: cms_list_posts / cms_get_post / cms_create_post / cms_update_post (Markdown body; bodyEdits for small changes) / cms_delete_post / cms_set_post_translation / cms_update_blog_settings. Posts live at /blog/<slug>; cms_screenshot {postSlug} shows one. They go live with cms_publish like everything else.',
    '',
    'Redirects: cms_list_redirects / cms_set_redirect / cms_delete_redirect (301/302 from an old path to a new one; a renamed page already gets its own 301). Draft until cms_publish.',
    '',
    'Links: cms_check_links lists broken internal links (missing page, address that answers nothing); external:true also asks the external URLs. cms_publish returns the internal ones in `validation`.',
].join('\n');

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/**
 * @typedef {object} CmsMcpDeps
 * @property {object} cmsStore                 stores/cmsStore
 * @property {{ collectLocaleOverrides: Function, deepMerge: Function, sanitizeAnalytics: Function }} cmsParts  stores/cms/* helpers
 * @property {{ TOOL_SCHEMAS: object[], MUTATING_TOOLS: Set<string>, applyToolCall: Function }} builder
 * @property {(draftWrap: object) => { errors: object[], warnings: object[] }} validateDraft
 * @property {{ SITE_DEFAULTS: object }} defaults
 * @property {{ scopeAllowsTool: Function, filterToolsByScope: Function }} access
 * @property {{ getLiveSiteId: Function, setLiveSiteId: Function, ensurePublishedSnapshot: Function, SITE_ID_RE: RegExp }} live
 * @property {(siteId: string, ctx: object) => Promise<void>} [afterPublish]
 * @property {ReturnType<import('./uploadTickets').createUploadTickets>} tickets
 * @property {{ render: Function }} screenshots
 * @property {{ isAvailable: Function, listKeys: Function }} storage
 * @property {Function} audit                  userStore.logAccessAudit
 * @property {(user: object) => Promise<boolean>} isAdmin
 * @property {(user: object) => boolean} [isSuperAdmin]  the operator test of requireSuperAdmin; absent = nobody (analytics tools stay hidden)
 * @property {{ analytics: object, umami: object }} [analytics]  core/cms/analyticsQueries instance + core/umamiClient
 * @property {{ classifyRpc: Function, parseToolCall: Function, PROTOCOL_VERSION: string, INVALID_REQUEST: string }} rpc
 * @property {() => number} [now]
 */

// ── JSON-RPC ────────────────────────────────────────────────────────

/**
 * One JSON-RPC message in, one answer (or null) out. Module-level: it only
 * needs the rpc helpers and the instance's listTools / callTool.
 * @param {{ rpc: object, listTools: Function, callTool: Function }} instance
 * @param {unknown} message  one JSON-RPC message
 * @param {{ user: object, userId: string, orgId: string|null, token: { name: string, scopes: object }, baseUrl?: string }} ctx
 */
async function answerRpc({ rpc, listTools, callTool }, message, ctx) {
    const call = rpc.classifyRpc(message);
    if (call.kind === 'invalid') return rpcError(call.id, -32600, rpc.INVALID_REQUEST);
    if (call.kind !== 'request') return null; // notifications and client responses get no answer
    const { id, method, params } = call;

    switch (method) {
        case 'initialize':
            return rpcResult(id, {
                protocolVersion: rpc.PROTOCOL_VERSION,
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: 'bee-flow-cms', version: '1.0.0' },
                instructions: INSTRUCTIONS,
            });
        case 'ping':
            return rpcResult(id, {});
        case 'tools/list':
            return rpcResult(id, { tools: await listTools(ctx) });
        case 'tools/call': {
            const toolCall = rpc.parseToolCall(params);
            if (toolCall.error) return rpcError(id, -32602, toolCall.error);
            const out = await callTool(toolCall.name, toolCall.args, ctx);
            const content = [{ type: 'text', text: out.text ?? JSON.stringify(out.result ?? null) }];
            if (out.image) content.push({ type: 'image', data: out.image.data, mimeType: out.image.mimeType });
            return rpcResult(id, { content, isError: out.isError === true });
        }
        default:
            return rpcError(id, -32601, `Method not found: ${method}`);
    }
}

/** @param {CmsMcpDeps} deps */
function createCmsMcp(deps) {
    const { cmsStore, builder, live, access, rpc } = deps;
    const now = deps.now || Date.now;
    const mcpOnly = new Map(MCP_ONLY_TOOLS.map((t) => [t.name, t]));
    const shotBudget = new Map(); // userId → { count, resetAt }
    const analyticsBudget = new Map();
    const isSuperAdmin = deps.isSuperAdmin || (() => false);

    // ── tool table ──────────────────────────────────────────────────────
    const toolList = buildList(builder);
    const builderNames = new Set(builder.TOOL_SCHEMAS.map((t) => t.function?.name).filter(Boolean));

    /** { readOnly, publish } for a tool name, or null when it does not exist. */
    function classify(name) {
        const own = mcpOnly.get(name);
        if (own) return { readOnly: own.readOnly === true, publish: PUBLISH_TOOLS.has(name) };
        if (builderNames.has(name)) return { readOnly: !builder.MUTATING_TOOLS.has(name), publish: false };
        return null;
    }

    function buildToolList() { return toolList; }

    /** The list a token may see: scoped, and empty for a user who is not a CMS admin. */
    async function listTools(ctx) {
        if (!(await deps.isAdmin(ctx.user))) return [];
        const scoped = access.filterToolsByScope(ctx.token.scopes, 'cms', toolList, {
            isReadOnly: (t) => t.annotations?.readOnlyHint === true,
            isPublish: (t) => PUBLISH_TOOLS.has(t.name),
        });
        // Analytics is an operator surface: a CMS admin who is not a super admin never sees it.
        return isSuperAdmin(ctx.user) ? scoped : scoped.filter((t) => !ANALYTICS_TOOLS.has(t.name));
    }

    // ── site plumbing and the tool handlers (one module per group) ───────
    const takeBudget = createTakeBudget(now);
    const { resolveSite, loadDraft, validationOf, runBuilderTool } = createSiteContext({
        cmsStore, live, builder, validateDraft: deps.validateDraft,
    });
    const kit = { deps, cmsStore, live, resolveSite, loadDraft, validationOf };
    const { listSites, duplicateSite, listTemplates, deletePage, getSiteSettings, updateSiteSettings } = createSiteHandlers(kit);
    const { getLocaleOverrides, setLocaleOverride } = createLocaleHandlers(kit);
    const { listAssets, requestUpload, uploadStatus } = createAssetHandlers(kit);
    const { screenshot } = createScreenshotHandler({ ...kit, takeBudget, shotBudget });
    const { publish, setLiveSite } = createPublishHandlers(kit);

    // Website analytics: wired only when the host provides the Umami side.
    const analyticsHandlers = deps.analytics
        ? createAnalyticsHandlers({ analytics: deps.analytics.analytics, umami: deps.analytics.umami, siteIdRe: live.SITE_ID_RE, now }).handlers
        : {};

    // Blog posts: same resolveSite, same audit sink.
    const blogHandlers = createBlogHandlers({ cmsStore, resolveSite, audit: deps.audit, now }).handlers;

    const redirectHandlers = createRedirectHandlers({ cmsStore, resolveSite, audit: deps.audit }).handlers;

    const linkHandlers = createLinkHandlers({ deps, cmsStore, resolveSite }).handlers;

    const HANDLERS = {
        ...linkHandlers,
        ...analyticsHandlers,
        ...blogHandlers,
        ...redirectHandlers,
        cms_list_sites: listSites,
        cms_get_site_settings: getSiteSettings,
        cms_update_site_settings: updateSiteSettings,
        cms_get_locale_overrides: getLocaleOverrides,
        cms_set_locale_override: setLocaleOverride,
        cms_delete_page: deletePage,
        cms_duplicate_site: duplicateSite,
        cms_list_templates: listTemplates,
        cms_list_assets: listAssets,
        cms_request_upload: requestUpload,
        cms_upload_status: uploadStatus,
        cms_screenshot: screenshot,
        cms_publish: publish,
        cms_set_live_site: setLiveSite,
    };

    // ── dispatch ────────────────────────────────────────────────────────

    /**
     * Run one tool call. Never throws: a failure is a described error the agent
     * can act on, not a transport fault. The scope is checked HERE as well as
     * in tools/list: a client can call a tool it was never shown.
     * @returns {Promise<{ result: object, text?: string, image?: { data: string, mimeType: string }, isError?: boolean }>}
     */
    async function callTool(name, rawArgs, ctx) {
        const kind = classify(name);
        if (!kind) return { result: { error: `Unknown tool: ${String(name).slice(0, 80)}.` }, isError: true };
        if (!access.scopeAllowsTool(ctx.token.scopes, 'cms', name, kind)) {
            const why = kind.publish
                ? `Tool "${name}" needs the cms.publish scope, which this token does not have. Ask the token's owner to mint one with publishing enabled.`
                : `Tool "${name}" is not available to this token.`;
            return { result: { error: why }, isError: true };
        }
        if (!(await deps.isAdmin(ctx.user))) {
            return { result: { error: 'The CMS can only be edited by an administrator, and this token\'s user is not one.' }, isError: true };
        }
        if (ANALYTICS_TOOLS.has(name)) {
            if (!isSuperAdmin(ctx.user)) {
                return { result: { error: 'Website analytics is an operator surface: only a super administrator can read it, and this token\'s user is not one.' }, isError: true };
            }
            if (!HANDLERS[name]) return { result: { error: 'Website analytics is not available on this server.' }, isError: true };
            if (!takeBudget(analyticsBudget, ctx.userId, ANALYTICS_MAX_PER_WINDOW, ANALYTICS_WINDOW_MS)) {
                const text = `Analytics budget spent (${ANALYTICS_MAX_PER_WINDOW} per ${ANALYTICS_WINDOW_MS / 60000} minutes). Ask again when it refills.`;
                return { result: { note: 'Analytics budget spent' }, text };
            }
        }
        const args = isPlainObject(rawArgs) ? rawArgs : {};
        try {
            const handler = HANDLERS[name];
            const out = handler ? await handler(args, ctx) : await runBuilderTool(name, args, ctx);
            const failed = !!(out.result && typeof out.result === 'object' && out.result.error);
            return { ...out, isError: out.isError ?? failed };
        } catch (e) {
            log.error(`[CmsMcp] tool ${name} failed: ${e.message}`);
            return { result: { error: `Tool ${name} failed: ${e.message}` }, isError: true };
        }
    }

    const handleRpc = (message, ctx) => answerRpc({ rpc, listTools, callTool }, message, ctx);

    return { handleRpc, callTool, listTools, buildToolList, classify, INSTRUCTIONS, _shotBudget: shotBudget, _analyticsBudget: analyticsBudget };
}

module.exports = { createCmsMcp, INSTRUCTIONS, SHOT_MAX_PER_WINDOW, SHOT_WINDOW_MS, ANALYTICS_MAX_PER_WINDOW, ANALYTICS_WINDOW_MS };
