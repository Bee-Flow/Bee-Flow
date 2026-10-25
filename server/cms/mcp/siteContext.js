// @typecheck noImplicitAny
'use strict';
/**
 * Per-call site plumbing for the CMS-over-MCP tools (./dispatch.js): which
 * site a call acts on, the builder draft loaded for it, validation of that
 * draft, and running one in-product builder tool against it.
 */

const { err } = require('./handlerKit');

/**
 * Narrow a site-wide validation to what an edit result needs: everything for
 * the pages this call touched, and ONE summary line for the empty pages it did
 * not touch (a new site lists a dozen of them on every call otherwise).
 * @param {{ errors: any[], warnings: any[] }} v
 * @param {Set<string>} touched
 */
function scopeValidation(v, touched) {
    const isOtherEmpty = (/** @type {any} */ w) => w.code === 'empty_page'
        && !touched.has(String(w.path || '').replace(/^pages\./, ''));
    const others = v.warnings.filter(isOtherEmpty);
    if (others.length < 2) return v;
    return {
        errors: v.errors,
        warnings: [
            ...v.warnings.filter((w) => !isOtherEmpty(w)),
            {
                code: 'other_empty_pages',
                path: 'pages',
                message: `${others.length} other pages have no blocks yet.`,
                hint: 'cms_list_site shows the full site-wide validation.',
            },
        ],
    };
}

/**
 * @typedef {import('./handlerKit').ToolArgs} ToolArgs
 * @typedef {import('./handlerKit').McpCtx} McpCtx
 */

/** @param {{ cmsStore: any, live: any, builder: any, validateDraft: Function }} deps */
function createSiteContext({ cmsStore, live, builder, validateDraft }) {
    /**
     * The siteId to act on and its project, or an error result.
     * @param {ToolArgs} args
     */
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

    /**
     * The draftWrap the builder tools mutate; the same shape routes/ai/cmsBuilder.js builds.
     * @param {string} siteId
     * @param {{ userId: string, orgId?: string | null }} ctx
     */
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
            pages: new Map((payload.pages || []).map((/** @type {Record<string, any>} */ p) => [p.id, p])),
            defaultLocale: payload.defaultLocale || 'en',
            locales: [...locales].sort(),
            createdPageIds: /** @type {string[]} */ ([]),
            touchedPageIds: new Set(),
        };
    }

    /** @param {any} draftWrap @param {Set<string>} [touched] scope the empty-page warnings to this edit */
    const validationOf = (draftWrap, touched) => {
        const raw = validateDraft(draftWrap);
        const v = touched ? scopeValidation(raw, touched) : raw;
        return (v.errors.length || v.warnings.length) ? { errors: v.errors, warnings: v.warnings } : null;
    };

    /**
     * @param {string} name
     * @param {ToolArgs} args
     * @param {{ userId: string, orgId?: string | null }} ctx
     */
    async function runBuilderTool(name, args, ctx) {
        const rest = { ...args };
        delete rest.siteId; // our envelope, not a builder argument
        const site = await resolveSite(args);
        if (site.error) return err(site.error);
        const draftWrap = await loadDraft(site.siteId, ctx);
        const result = await builder.applyToolCall(draftWrap, name, rest);
        const ok = !(result && typeof result === 'object' && result.error);
        if (!ok || !builder.MUTATING_TOOLS.has(name)) return { result: ok ? { ...result, siteId: site.siteId } : result };
        const validation = validationOf(draftWrap, draftWrap.touchedPageIds);
        return { result: { ...result, siteId: site.siteId, ...(validation ? { validation } : {}) } };
    }

    return { resolveSite, loadDraft, validationOf, runBuilderTool };
}

module.exports = { createSiteContext, scopeValidation };
