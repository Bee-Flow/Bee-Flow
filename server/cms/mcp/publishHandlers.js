// @typecheck noImplicitAny
'use strict';
/**
 * The publishing CMS-over-MCP tools (./dispatch.js maps tool names to them;
 * both need the cms.publish scope, checked there): publish a site, and make
 * a site the live one or take it off.
 */

const { err } = require('./handlerKit');
const log = require('../../telemetry/log');
const { runLinkCheck, asValidationWarnings } = require('../../core/cms/linkReport');

/**
 * @typedef {import('./handlerKit').ToolArgs} ToolArgs
 * @typedef {import('./handlerKit').McpCtx} McpCtx
 * @typedef {import('./handlerKit').HandlerKit} HandlerKit
 */

/**
 * Publish and go-live, both audited.
 * @param {HandlerKit} kit
 */
function createPublishHandlers({ deps, cmsStore, live, resolveSite, loadDraft, validationOf }) {
    /**
     * The internal broken links as warnings; the publish already happened, so a failure here is only logged.
     * @param {string} siteId
     * @param {{ errors: object[], warnings: object[] } | null} validation
     */
    async function withLinkWarnings(siteId, validation) {
        try {
            const report = await runLinkCheck(siteId, { external: false }, { cmsStore });
            if (!report.problems.length) return validation;
            return { errors: validation?.errors || [], warnings: [...(validation?.warnings || []), ...asValidationWarnings(report)] };
        } catch (e) {
            log.warn('[CMS] link check after publish failed:', e.message);
            return validation;
        }
    }

    /**
     * @param {ToolArgs} args
     * @param {McpCtx} ctx
     */
    async function publish(args, ctx) {
        const site = await resolveSite(args);
        if (site.error) return err(site.error);
        const published = await cmsStore.publishSite(site.siteId);
        if (deps.afterPublish) await Promise.resolve(deps.afterPublish(site.siteId, ctx)).catch((e) => log.warn('[CMS] afterPublish hook failed:', e.message));
        await deps.audit('cms.publish.mcp', 'cms_site', site.siteId, ctx.userId, null, { tokenName: ctx.token.name }, ctx.orgId || null);
        const liveSiteId = await live.getLiveSiteId();
        const draftWrap = await loadDraft(site.siteId, ctx);
        const validation = await withLinkWarnings(site.siteId, validationOf(draftWrap));
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

    /**
     * Name the homepage in the go-live answer. Every new site starts with an
     * empty "Home" page; an agent that does not know that creates a second one
     * (slug home-2). Say which page it is so the agent fills it instead.
     * @param {string} siteId
     * @param {McpCtx} ctx
     */
    async function homepageReport(siteId, ctx) {
        const draftWrap = await loadDraft(siteId, ctx);
        const entry = (draftWrap.site.pages || []).find((/** @type {Record<string, any>} */ p) => p.id === draftWrap.site.homepageId)
            || (draftWrap.site.pages || [])[0];
        if (!entry) return { homepage: null, note: 'This site has no pages yet, so visitors see nothing. Create a page with cms_create_page.' };
        const doc = draftWrap.pages.get(entry.id);
        const empty = !doc || !Array.isArray(doc.blocks) || doc.blocks.length === 0;
        return {
            homepage: { pageId: entry.id, slug: entry.slug, title: entry.title, empty },
            ...(empty ? { note: `The homepage is the page "${entry.title || entry.slug}" (pageId ${entry.id}) and it has no blocks yet. New sites start with it: fill it with cms_add_blocks instead of creating another one.` } : {}),
        };
    }

    /**
     * @param {ToolArgs} args
     * @param {McpCtx} ctx
     */
    async function setLiveSite(args, ctx) {
        const site = await resolveSite({ siteId: args.siteId });
        if (site.error) return err(site.error);
        const goLive = args.live !== false;
        if (goLive) {
            // Publish first: a version without a snapshot must never become
            // the live one. On failure the current live site stays.
            try {
                await live.ensurePublishedSnapshot(site.siteId);
            } catch (e) {
                return err(e && e.expose ? e.message : 'This version could not be published, so it was not set live. The current live site is unchanged.');
            }
            await live.setLiveSiteId(site.siteId);
        } else {
            const current = await live.getLiveSiteId();
            if (current === site.siteId) await live.setLiveSiteId(null);
        }
        await deps.audit('cms.live.mcp', 'cms_site', site.siteId, ctx.userId, null, { tokenName: ctx.token.name, live: goLive }, ctx.orgId || null);
        const liveSiteId = await live.getLiveSiteId();
        /** @type {Record<string, any>} */
        const result = { siteId: site.siteId, live: liveSiteId === site.siteId, liveSiteId };
        if (goLive) {
            // The switch already happened: a failure to describe the homepage
            // must not turn a successful call into an error the agent retries.
            try {
                Object.assign(result, await homepageReport(site.siteId, ctx));
            } catch (e) {
                log.warn('[CMS] go-live homepage report failed:', e.message);
                result.homepage = null;
            }
        }
        return { result };
    }

    return { publish, setLiveSite };
}

module.exports = { createPublishHandlers };
