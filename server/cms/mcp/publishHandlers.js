// @typecheck
'use strict';
/**
 * The publishing CMS-over-MCP tools (./dispatch.js maps tool names to them;
 * both need the cms.publish scope, checked there): publish a site, and make
 * a site the live one or take it off.
 */

const { err } = require('./handlerKit');
const log = require('../../telemetry/log');

/** Publish and go-live, both audited. */
function createPublishHandlers({ deps, cmsStore, live, resolveSite, loadDraft, validationOf }) {
    async function publish(args, ctx) {
        const site = await resolveSite(args);
        if (site.error) return err(site.error);
        const published = await cmsStore.publishSite(site.siteId);
        if (deps.afterPublish) await Promise.resolve(deps.afterPublish(site.siteId, ctx)).catch((e) => log.warn('[CMS] afterPublish hook failed:', e.message));
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
        return { result: { siteId: site.siteId, live: liveSiteId === site.siteId, liveSiteId } };
    }

    return { publish, setLiveSite };
}

module.exports = { createPublishHandlers };
