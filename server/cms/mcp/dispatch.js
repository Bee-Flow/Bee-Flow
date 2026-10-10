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
const { MCP_ONLY_TOOLS, PUBLISH_TOOLS, buildToolList: buildList } = require('./tools');
const { maxBytesFor } = require('../../core/cms/uploadPolicy');
const { EXT_BY_TYPE, assetUrlFor } = require('./uploadReceiver');

const SHOT_WINDOW_MS = 10 * 60 * 1000;
const SHOT_MAX_PER_WINDOW = 24;
const UPLOAD_PATH = '/mcp/cms/upload';
const SETTING_SECTIONS = ['header', 'footer', 'cookieBanner', 'announcement'];
const SETTINGS_PATCH_MAX_CHARS = 100_000;
const OVERRIDE_MAX_CHARS = 200_000;
const ASSET_LIST_EXT_RE = /\.(png|jpe?g|gif|webp|avif|svg|ico|mp4|webm|vtt)$/i;

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
    'Publishing (cms_publish, cms_set_live_site) needs the cms.publish scope on the token and is audited. Only publish when asked to.',
].join('\n');

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const err = (error, extra = {}) => ({ result: { error, ...extra } });

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
 * @property {{ classifyRpc: Function, parseToolCall: Function, PROTOCOL_VERSION: string, INVALID_REQUEST: string }} rpc
 * @property {() => number} [now]
 */

/** @param {CmsMcpDeps} deps */
function createCmsMcp(deps) {
    const { cmsStore, builder, live, access, rpc } = deps;
    const now = deps.now || Date.now;
    const mcpOnly = new Map(MCP_ONLY_TOOLS.map((t) => [t.name, t]));
    const shotBudget = new Map(); // userId → { count, resetAt }

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
        return access.filterToolsByScope(ctx.token.scopes, 'cms', toolList, {
            isReadOnly: (t) => t.annotations?.readOnlyHint === true,
            isPublish: (t) => PUBLISH_TOOLS.has(t.name),
        });
    }

    // ── helpers ─────────────────────────────────────────────────────────

    /** The siteId to act on and its project, or an error result. */
    async function resolveSite(args) {
        let siteId = args.siteId;
        if (siteId === undefined || siteId === null || siteId === '') {
            siteId = await live.getLiveSiteId();
            if (!siteId) return { error: 'No site is live, so there is no default. Pass siteId (cms_list_sites lists the sites).' };
        }
        if (typeof siteId !== 'string' || !live.SITE_ID_RE.test(siteId)) {
            return { error: `"${String(siteId).slice(0, 60)}" is not a site id (pj_…). cms_list_sites lists them.` };
        }
        const project = await cmsStore.getProject(siteId);
        if (!project) return { error: `Site "${siteId}" was not found. cms_list_sites lists the sites.` };
        return { siteId, project };
    }

    /** The draftWrap the builder tools mutate; the same shape routes/ai/cmsBuilder.js builds. */
    async function loadDraft(siteId, ctx) {
        const payload = await cmsStore.getAdminPayload(siteId);
        const locales = new Set(Object.keys(payload.localeOverrides?.siteByLocale || {}));
        for (const perPage of Object.values(payload.localeOverrides?.pagesByLocale || {})) {
            for (const loc of Object.keys(perPage || {})) locales.add(loc);
        }
        return {
            siteId,
            userId: ctx.userId,
            orgId: ctx.orgId || null,
            // Distinct prefix: a session driven from an editor is recognisable in logs.
            builderSessionId: `mcp_${siteId}`,
            site: payload.site,
            pages: new Map((payload.pages || []).map((p) => [p.id, p])),
            defaultLocale: payload.defaultLocale || 'en',
            locales: [...locales].sort(),
            createdPageIds: [],
            touchedPageIds: new Set(),
        };
    }

    const validationOf = (draftWrap) => {
        const v = deps.validateDraft(draftWrap);
        return (v.errors.length || v.warnings.length) ? { errors: v.errors, warnings: v.warnings } : null;
    };

    // ── builder tools (page/block/design edits) ─────────────────────────

    async function runBuilderTool(name, args, ctx) {
        const rest = { ...args };
        delete rest.siteId; // our envelope, not a builder argument
        const site = await resolveSite(args);
        if (site.error) return err(site.error);
        const draftWrap = await loadDraft(site.siteId, ctx);
        const result = await builder.applyToolCall(draftWrap, name, rest);
        const ok = !(result && typeof result === 'object' && result.error);
        if (!ok || !builder.MUTATING_TOOLS.has(name)) return { result: ok ? { ...result, siteId: site.siteId } : result };
        const validation = validationOf(draftWrap);
        return { result: { ...result, siteId: site.siteId, ...(validation ? { validation } : {}) } };
    }

    // ── MCP-only tools ──────────────────────────────────────────────────

    async function listSites() {
        const [sites, liveSiteId] = await Promise.all([cmsStore.listProjects(), live.getLiveSiteId()]);
        return { result: { liveSiteId, sites: sites.map((s) => ({ ...s, live: s.id === liveSiteId })) } };
    }

    async function getSiteSettings(args) {
        const site = await resolveSite(args);
        if (site.error) return err(site.error);
        const wanted = Array.isArray(args.sections) && args.sections.length
            ? args.sections.filter((s) => [...SETTING_SECTIONS, 'analytics'].includes(s))
            : [...SETTING_SECTIONS, 'analytics'];
        const out = { siteId: site.siteId, name: site.project.name, defaultLocale: await cmsStore.getDefaultLocale() };
        for (const key of wanted) out[key] = site.project[key] ?? null;
        return { result: out };
    }

    async function updateSiteSettings(args, ctx) {
        const known = new Set(['siteId', 'name', 'analytics', ...SETTING_SECTIONS]);
        const unknown = Object.keys(args).filter((k) => !known.has(k));
        if (unknown.length) {
            return err(`Unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`, {
                _fixHint: `Send any of: name, ${SETTING_SECTIONS.join(', ')}, analytics. The header menu is cms_update_header_nav; page SEO is cms_update_page_seo; colours and fonts are cms_update_design.`,
            });
        }
        const sent = ['name', 'analytics', ...SETTING_SECTIONS].filter((k) => args[k] !== undefined);
        if (!sent.length) return err('Nothing to change.', { _fixHint: `Pass at least one of: name, ${SETTING_SECTIONS.join(', ')}, analytics.` });

        const found = await resolveSite(args);
        if (found.error) return err(found.error);
        const next = JSON.parse(JSON.stringify(found.project));

        if (args.name !== undefined) {
            if (typeof args.name !== 'string' || !args.name.trim() || args.name.length > 200) {
                return err('name must be text of 1-200 characters.');
            }
            next.name = args.name.trim();
        }
        for (const section of SETTING_SECTIONS) {
            if (args[section] === undefined) continue;
            const patch = args[section];
            if (!isPlainObject(patch)) return err(`${section} must be an object (a patch to merge).`);
            if (JSON.stringify(patch).length > SETTINGS_PATCH_MAX_CHARS) return err(`The ${section} patch is too large.`);
            if (section === 'header' && 'nav' in patch) {
                return err('The header menu is not set here.', { _fixHint: 'Use cms_update_header_nav for header.nav; it validates the menu structure.' });
            }
            const valid = Object.keys(deps.defaults.SITE_DEFAULTS[section] || {});
            const bad = Object.keys(patch).filter((k) => !valid.includes(k));
            if (bad.length) return err(`${section} has no setting called ${bad.join(', ')}.`, { _fixHint: `Valid ${section} keys: ${valid.join(', ')}.` });
            if ('enabled' in patch && typeof patch.enabled !== 'boolean') return err(`${section}.enabled must be true or false.`);
            next[section] = deps.cmsParts.deepMerge(next[section] || deps.defaults.SITE_DEFAULTS[section], patch);
        }
        if (args.analytics !== undefined) {
            if (!isPlainObject(args.analytics)) return err('analytics must be an object like {gaMeasurementId:"G-XXXXXXXXXX"}.');
            const asked = String(args.analytics.gaMeasurementId ?? '').trim();
            const cleaned = deps.cmsParts.sanitizeAnalytics({ gaMeasurementId: asked });
            if (asked && !cleaned.gaMeasurementId) return err(`"${asked.slice(0, 40)}" is not a Google Analytics 4 id.`, { _fixHint: 'It looks like G-ABC123XYZ (the letter G, a dash, 4-20 letters or digits). Send "" to clear it.' });
            next.analytics = cleaned;
        }

        const saved = await cmsStore.setProject(found.siteId, next);
        const draftWrap = await loadDraft(found.siteId, ctx);
        const validation = validationOf(draftWrap);
        const changed = { siteId: found.siteId, updated: sent };
        if (sent.includes('name')) changed.name = saved.name;
        for (const section of [...SETTING_SECTIONS, 'analytics']) if (sent.includes(section)) changed[section] = saved[section];
        return { result: { ...changed, ...(validation ? { validation } : {}) } };
    }

    async function getLocaleOverrides(args) {
        const site = await resolveSite(args);
        if (site.error) return err(site.error);
        const wantedLocale = args.locale ? String(args.locale).toLowerCase() : null;
        const { siteByLocale, pagesByLocale } = await deps.cmsParts.collectLocaleOverrides(site.siteId, { fresh: true });
        const out = { siteId: site.siteId, defaultLocale: await cmsStore.getDefaultLocale(), site: {}, pages: {} };
        for (const [loc, ov] of Object.entries(siteByLocale || {})) {
            if (!wantedLocale || loc === wantedLocale) out.site[loc] = ov;
        }
        for (const [pageId, perLocale] of Object.entries(pagesByLocale || {})) {
            if (args.pageId && pageId !== args.pageId) continue;
            for (const [loc, ov] of Object.entries(perLocale || {})) {
                if (wantedLocale && loc !== wantedLocale) continue;
                out.pages[pageId] = { ...(out.pages[pageId] || {}), [loc]: ov };
            }
        }
        return { result: out };
    }

    async function setLocaleOverride(args) {
        const locale = String(args.locale || '').toLowerCase();
        if (!cmsStore.isValidLocale(locale)) return err(`"${String(args.locale).slice(0, 20)}" is not a language code such as "en", "nl" or "pt-br".`);
        const site = await resolveSite(args);
        if (site.error) return err(site.error);
        const pageId = typeof args.pageId === 'string' && args.pageId ? args.pageId : null;
        if (pageId && !site.project.pages.some((p) => p.id === pageId)) {
            return err(`Page "${pageId}" is not in this site.`, { _fixHint: `Known page ids: ${site.project.pages.map((p) => `${p.id} (${p.slug})`).join(', ') || 'none'}.` });
        }
        if (args.remove === true) {
            if (pageId) await cmsStore.deletePageLocaleOverride(site.siteId, pageId, locale);
            else await cmsStore.deleteSiteLocaleOverride(site.siteId, locale);
            return { result: { siteId: site.siteId, locale, pageId, removed: true } };
        }
        if (!isPlainObject(args.override)) return err('override must be an object.', { _fixHint: 'Site level: {header, footer, pageTitles}. Page level: {blocks:{<blockId>:{…}}, seo:{metaTitle,metaDescription}}. Read the current one with cms_get_locale_overrides.' });
        if (JSON.stringify(args.override).length > OVERRIDE_MAX_CHARS) return err('The override is too large.');
        if (pageId) await cmsStore.setPageLocaleOverride(site.siteId, pageId, locale, args.override);
        else await cmsStore.setSiteLocaleOverride(site.siteId, locale, args.override);
        return { result: { siteId: site.siteId, locale, pageId, saved: true } };
    }

    async function deletePage(args) {
        const site = await resolveSite(args);
        if (site.error) return err(site.error);
        const pageId = String(args.pageId || '');
        const entry = site.project.pages.find((p) => p.id === pageId);
        if (!entry) return err(`Page "${pageId.slice(0, 60)}" is not in this site.`, { _fixHint: `Known page ids: ${site.project.pages.map((p) => `${p.id} (${p.slug})`).join(', ') || 'none'}.` });
        await cmsStore.removePage(site.siteId, pageId);
        return { result: { siteId: site.siteId, deleted: { id: pageId, slug: entry.slug } } };
    }

    async function duplicateSite(args) {
        const site = await resolveSite(args);
        if (site.error) return err(site.error);
        const created = await cmsStore.duplicateProject(site.siteId);
        return { result: { ...created, copiedFrom: site.siteId, note: 'A new draft version. It is not live; pass its id as siteId to work on it.' } };
    }

    async function listTemplates() {
        const templates = await cmsStore.getTemplates();
        return {
            result: {
                templates: templates.map((t) => ({
                    id: t.id, name: t.name, description: t.description || '', createdAt: t.createdAt,
                    blockCount: Array.isArray(t.blocks) ? t.blocks.length : 0,
                })),
            },
        };
    }

    async function listAssets(args, ctx) {
        const limit = Math.min(200, Math.max(1, Number.isInteger(args.limit) ? args.limit : 100));
        const search = typeof args.search === 'string' ? args.search.toLowerCase() : '';
        try {
            const keys = await deps.storage.listKeys('cms/');
            const assets = keys
                .filter((k) => ASSET_LIST_EXT_RE.test(k) && (!search || k.toLowerCase().includes(search)))
                .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
                .slice(0, limit)
                .map((key) => ({ key, url: assetUrlFor(key), ...(ctx.baseUrl ? { absoluteUrl: `${ctx.baseUrl}${assetUrlFor(key)}` } : {}) }));
            return { result: { assets } };
        } catch (_) {
            return { result: { assets: [], unavailable: true, note: 'The asset library cannot be listed on this installation (no object storage).' } };
        }
    }

    async function requestUpload(args, ctx) {
        // A legacy token cannot be re-checked as finely when the PUT arrives (no id,
        // no scopes of its own), so it gets no upload URLs at all.
        if (ctx.token?.legacy === true) {
            return err('Uploads need a named MCP token. Create one in Settings → Security → MCP tokens (with the cms server at write level) and connect with it.');
        }
        const site = await resolveSite(args);
        if (site.error) return err(site.error);
        const contentType = String(args.contentType || '').split(';')[0].trim().toLowerCase();
        const cap = maxBytesFor(contentType);
        if (cap === null) {
            return err(`${contentType || 'That content type'} is not accepted.`, { _fixHint: `Allowed: ${Object.keys(EXT_BY_TYPE).join(', ')}.` });
        }
        if (!Number.isInteger(args.size) || args.size < 1) return err('size must be the file size in bytes (a positive whole number).');
        if (args.size > cap) {
            return err(`${contentType} files can be at most ${Math.round(cap / 1048576)} MB here; this one is ${(args.size / 1048576).toFixed(1)} MB.`, {
                _fixHint: contentType.startsWith('image/') ? 'Downscale or recompress the image before uploading.' : 'Shorten or recompress the file before uploading.',
            });
        }
        const filename = String(args.filename || '').trim();
        if (!filename || filename.length > 200) return err('filename must be the name of the file (1-200 characters).');
        if (!deps.storage.isAvailable()) return err('Asset storage is not available on this server, so nothing can be uploaded.');

        let issued;
        try {
            issued = await deps.tickets.issue({
                userId: ctx.userId, orgId: ctx.orgId, tokenId: ctx.token.id || null, legacy: false, siteId: site.siteId, contentType, maxSize: args.size, filename,
            });
        } catch (e) {
            if (e?.code === 'too_many_open_tickets') return err(e.message);
            throw e;
        }
        const { ticketId, secret, expiresAt } = issued;
        // The URL carries only the public ticket id; the secret travels in a header
        // so it never lands in a proxy access log or a trace URL.
        const path = `${UPLOAD_PATH}/${ticketId}`;
        const url = ctx.baseUrl ? `${ctx.baseUrl}${path}` : path;
        const shownName = filename.replace(/[^A-Za-z0-9._-]/g, '_');
        return {
            result: {
                ticketId,
                uploadUrl: url,
                expiresAt,
                contentType,
                maxBytes: args.size,
                uploadHeaders: { 'Content-Type': contentType, 'X-Upload-Ticket': secret },
                curl: `curl -fS -T '<path/to/${shownName}>' -H 'Content-Type: ${contentType}' -H 'X-Upload-Ticket: ${secret}' '${url}'`,
                next: 'Run the curl command in a shell with the real path of the file. It prints JSON with the asset `url`; put that url in the block. The URL works once; if it fails, call cms_request_upload again.',
                ...(ctx.baseUrl ? {} : { note: 'The public address of this server is not configured, so the URL above is relative: prefix it with the address you reach this MCP endpoint on.' }),
            },
        };
    }

    async function uploadStatus(args, ctx) {
        const status = await deps.tickets.status(String(args.ticketId || ''), ctx.userId);
        if (!status) return err('No upload with that ticketId for this user. Check the id from cms_request_upload.');
        return { result: status };
    }

    function takeScreenshotBudget(userId) {
        const t = now();
        const entry = shotBudget.get(userId);
        if (!entry || entry.resetAt <= t) {
            shotBudget.set(userId, { count: 1, resetAt: t + SHOT_WINDOW_MS });
            return true;
        }
        if (entry.count >= SHOT_MAX_PER_WINDOW) return false;
        entry.count += 1;
        return true;
    }

    async function screenshot(args, ctx) {
        if (!takeScreenshotBudget(ctx.userId)) {
            return { result: { note: 'Screenshot budget spent' }, text: `Screenshot budget spent (${SHOT_MAX_PER_WINDOW} per ${SHOT_WINDOW_MS / 60000} minutes); each one is a headless browser page. Keep editing and take the next one when the budget refills.` };
        }
        const site = await resolveSite(args);
        if (site.error) return err(site.error);
        const shot = await deps.screenshots.render({
            siteId: site.siteId,
            pageId: args.pageId,
            slug: args.slug,
            state: args.state,
            locale: args.locale,
            viewport: args.viewport,
            fullPage: args.fullPage === true,
            offsetY: Number.isInteger(args.offsetY) ? args.offsetY : 0,
        });
        if (!shot.ok) {
            const text = `Screenshot unavailable: ${shot.reason}`;
            return { result: { unavailable: true, reason: shot.reason }, text };
        }
        return {
            result: { siteId: site.siteId, rendering: shot.rendering, path: shot.path, pageHeight: shot.pageHeight },
            text: shot.text,
            image: { data: shot.image.data, mimeType: shot.image.mimeType },
        };
    }

    async function publish(args, ctx) {
        const site = await resolveSite(args);
        if (site.error) return err(site.error);
        const published = await cmsStore.publishSite(site.siteId);
        if (deps.afterPublish) await Promise.resolve(deps.afterPublish(site.siteId, ctx)).catch(() => {});
        await deps.audit('cms.publish.mcp', 'cms_site', site.siteId, ctx.userId, null, { tokenName: ctx.token.name }, ctx.orgId || null);
        const liveSiteId = await live.getLiveSiteId();
        const draftWrap = await loadDraft(site.siteId, ctx);
        const validation = validationOf(draftWrap);
        return {
            result: {
                published: true,
                siteId: site.siteId,
                publishedAt: published.publishedAt,
                live: liveSiteId === site.siteId,
                note: liveSiteId === site.siteId
                    ? 'This is the live site: visitors see it now (cached copies can lag a few minutes).'
                    : 'This site is not the live site, so visitors do not see it yet; cms_set_live_site makes it live.',
                ...(validation ? { validation } : {}),
            },
        };
    }

    async function setLiveSite(args, ctx) {
        const site = await resolveSite({ siteId: args.siteId });
        if (site.error) return err(site.error);
        const goLive = args.live !== false;
        if (goLive) {
            await live.setLiveSiteId(site.siteId);
            await live.ensurePublishedSnapshot(site.siteId);
        } else {
            const current = await live.getLiveSiteId();
            if (current === site.siteId) await live.setLiveSiteId(null);
        }
        await deps.audit('cms.live.mcp', 'cms_site', site.siteId, ctx.userId, null, { tokenName: ctx.token.name, live: goLive }, ctx.orgId || null);
        const liveSiteId = await live.getLiveSiteId();
        return { result: { siteId: site.siteId, live: liveSiteId === site.siteId, liveSiteId } };
    }

    const HANDLERS = {
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

    // ── JSON-RPC ────────────────────────────────────────────────────────

    /**
     * @param {unknown} message  one JSON-RPC message
     * @param {{ user: object, userId: string, orgId: string|null, token: { name: string, scopes: object }, baseUrl?: string }} ctx
     */
    async function handleRpc(message, ctx) {
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

    return { handleRpc, callTool, listTools, buildToolList, classify, INSTRUCTIONS, _shotBudget: shotBudget };
}

module.exports = { createCmsMcp, INSTRUCTIONS, SHOT_MAX_PER_WINDOW, SHOT_WINDOW_MS };
