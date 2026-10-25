// @typecheck noImplicitAny
/**
 * Redirect tools of the CMS MCP server: list, set and delete the 301/302
 * redirects of a site. Same access model as every other CMS tool (dispatch.js
 * checks scope and CMS-admin before any handler). Edits land in the draft; the
 * public site follows them at the next cms_publish.
 *
 * The list of hosts an external redirect may point at is NOT settable here, on
 * purpose: it is what stops a redirect from becoming an open redirect, so only
 * an administrator in the CMS admin can widen it. An agent can read it.
 */

'use strict';

const { RedirectError } = require('../../stores/cms/redirectRules');
const { err } = require('./handlerKit');

const SITE_ID_PROP = Object.freeze({
    type: 'string',
    description: 'The site to act on (pj_… id from cms_list_sites). Omit it to use the live site.',
});

const NOTE = 'Redirects are part of the draft; visitors get them after cms_publish. A page rename already creates its own 301 from the old address.';

/** @type {import('./tools').McpOnlyTool[]} */
const REDIRECT_TOOLS = [
    {
        name: 'cms_list_redirects',
        description: `List the redirects of a site (from, to, status 301/302, whether it was made automatically by a slug change) and the hosts an external redirect may point at. ${NOTE}`,
        parameters: { type: 'object', properties: { siteId: SITE_ID_PROP } },
        readOnly: true,
    },
    {
        name: 'cms_set_redirect',
        description: `Create or replace the redirect from an old address. "from" is a path on this site such as /old-page (lower case, not the homepage, not an application path like /app). "to" is a path on this site (/new-page, optionally with ?query or #hash) or, only with external:true, an https:// URL whose host is on the site's allowed list (see cms_list_redirects; an administrator manages that list in the CMS). status is 301 (permanent, default) or 302 (temporary). Loops are refused, and a chain (a -> b -> c) is stored as a -> c. ${NOTE}`,
        parameters: {
            type: 'object',
            properties: {
                siteId: SITE_ID_PROP,
                from: { type: 'string', description: 'The old address, e.g. "/old-page".' },
                to: { type: 'string', description: 'The new address, e.g. "/new-page", or an allowed https URL with external:true.' },
                status: { type: 'integer', enum: [301, 302], description: '301 permanent (default), 302 temporary.' },
                external: { type: 'boolean', description: 'true when "to" is an https URL on another website.' },
            },
            required: ['from', 'to'],
        },
        readOnly: false,
    },
    {
        name: 'cms_delete_redirect',
        description: `Delete the redirect from an address (or by id). The old address then answers as a page or 404/410 again after cms_publish.`,
        parameters: {
            type: 'object',
            properties: {
                siteId: SITE_ID_PROP,
                from: { type: 'string', description: 'The old address of the redirect, e.g. "/old-page".' },
                id: { type: 'string', description: 'The redirect id (rd_…), instead of from.' },
            },
        },
        readOnly: false,
        destructive: true,
    },
];

/**
 * @typedef {import('./handlerKit').ToolArgs} ToolArgs
 * @typedef {import('./handlerKit').McpCtx} McpCtx
 * @typedef {Record<string, any>} Redirect
 */

/**
 * The host of an external target, never the full URL (it may carry a token in its query).
 * @param {unknown} to
 */
function hostOf(to) {
    try { return new URL(String(to)).hostname; } catch { return null; }
}

/**
 * @param {{ cmsStore: any, resolveSite: (args: any) => Promise<any>, audit?: Function }} deps
 */
function createRedirectHandlers(deps) {
    const { cmsStore, resolveSite } = deps;
    /**
     * Ids and addresses only; the target is recorded as a host when external.
     * @param {string} action
     * @param {string} siteId
     * @param {Redirect} redirect
     * @param {McpCtx} [ctx]
     */
    const audit = async (action, siteId, redirect, ctx) => {
        if (!deps.audit) return;
        await deps.audit(action, 'cms_redirect', redirect.id, ctx?.userId, null, {
            tokenName: ctx?.token?.name, siteId, from: redirect.from, external: !!redirect.external,
            ...(redirect.external ? { host: hostOf(redirect.to) } : {}),
        }, ctx?.orgId || null);
    };

    /** @param {ToolArgs} args */
    async function listRedirects(args) {
        const site = await resolveSite(args);
        if (site.error) return err(site.error);
        const doc = await cmsStore.getRedirects(site.siteId, { fresh: true });
        return { result: { siteId: site.siteId, count: doc.redirects.length, redirects: doc.redirects, allowedHosts: doc.allowedHosts } };
    }

    /**
     * @param {ToolArgs} args
     * @param {McpCtx} ctx
     */
    async function setRedirect(args, ctx) {
        const unknown = Object.keys(args).filter((k) => !['siteId', 'from', 'to', 'status', 'external'].includes(k));
        if (unknown.length) return err(`Unknown field: ${unknown.slice(0, 5).join(', ')}.`, { _fixHint: 'Send from, to, status and external.' });
        if (typeof args.from !== 'string' || typeof args.to !== 'string') return err('from and to must be text.');
        const site = await resolveSite(args);
        if (site.error) return err(site.error);
        try {
            const { entry, redirects } = await cmsStore.setRedirect(site.siteId, {
                from: args.from, to: args.to, status: args.status, external: args.external === true,
            });
            await audit('cms.redirect.set.mcp', site.siteId, entry, ctx);
            return { result: { siteId: site.siteId, redirect: entry, count: redirects.length, note: 'Draft only: visitors get it after cms_publish.' } };
        } catch (e) {
            if (e instanceof RedirectError) return err(/** @type {Error} */ (e).message, { code: e.code });
            throw e;
        }
    }

    /**
     * @param {ToolArgs} args
     * @param {McpCtx} ctx
     */
    async function deleteRedirect(args, ctx) {
        const site = await resolveSite(args);
        if (site.error) return err(site.error);
        const doc = await cmsStore.getRedirects(site.siteId, { fresh: true });
        let target = null;
        if (typeof args.id === 'string' && args.id) target = doc.redirects.find((/** @type {Redirect} */ r) => r.id === args.id);
        else if (typeof args.from === 'string' && args.from) {
            const want = `/${args.from.trim().replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase()}`;
            target = doc.redirects.find((/** @type {Redirect} */ r) => r.from === want);
        }
        if (!target) {
            const list = doc.redirects.slice(0, 15).map((/** @type {Redirect} */ r) => r.from).join(', ') || 'none';
            return err('No such redirect in this site.', { _fixHint: `Pass from or id. Redirects: ${list}. cms_list_redirects lists them all.` });
        }
        await cmsStore.removeRedirect(site.siteId, target.id);
        await audit('cms.redirect.delete.mcp', site.siteId, target, ctx);
        return { result: { siteId: site.siteId, deleted: { id: target.id, from: target.from }, note: 'Draft only: the redirect stops after cms_publish.' } };
    }

    return {
        handlers: {
            cms_list_redirects: listRedirects,
            cms_set_redirect: setRedirect,
            cms_delete_redirect: deleteRedirect,
        },
    };
}

module.exports = { REDIRECT_TOOLS, createRedirectHandlers };
