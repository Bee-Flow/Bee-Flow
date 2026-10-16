// @typecheck
/**
 * The link-check tool of the CMS MCP server: cms_check_links. Internal links
 * are resolved against the site's own pages, posts and redirects (no network).
 * External URLs are requested only when the caller passes external:true, from
 * the server, through the SSRF-guarded probe, capped and rate limited per user.
 */

'use strict';

const { err } = require('./handlerKit');
const { runLinkCheck } = require('../../core/cms/linkReport');
const { MAX_URLS } = require('../../core/cms/linkProbe');

/** External runs per user and window: each one makes up to MAX_URLS requests. */
const EXTERNAL_MAX_PER_WINDOW = 5;
const EXTERNAL_WINDOW_MS = 10 * 60 * 1000;

/** @type {import('./tools').McpOnlyTool[]} */
const LINK_TOOLS = [
    {
        name: 'cms_check_links',
        description: `Check every link of a site draft: menus, footer, cookie banner (privacy link), announcement, blocks and translations. Internal links are checked against the site's pages, posts and redirects without any network call (page missing, address that answers nothing). With external:true the server also asks each external http(s) URL (HEAD, then a small GET; up to ${MAX_URLS} URLs, private addresses refused) and reports the ones that answer 404/410, error out or cannot be reached. Returns { problems: [{ where, url, code, problem, severity }], summary }. cms_publish already returns the internal problems in its validation.`,
        parameters: {
            type: 'object',
            properties: {
                siteId: { type: 'string', description: 'The site to check (pj_… id from cms_list_sites). Omit it to use the live site.' },
                external: { type: 'boolean', description: `true = also request the external URLs (at most ${MAX_URLS}, ${EXTERNAL_MAX_PER_WINDOW} runs per ${EXTERNAL_WINDOW_MS / 60000} minutes). Default false.` },
            },
        },
        readOnly: true,
    },
];

/**
 * @param {{ deps: any, cmsStore: any, resolveSite: (args: any) => Promise<any>, takeBudget: Function }} kit
 */
function createLinkHandlers({ deps, cmsStore, resolveSite, takeBudget }) {
    const externalBudget = new Map();

    async function checkLinks(args, ctx) {
        const unknown = Object.keys(args).filter((k) => !['siteId', 'external'].includes(k));
        if (unknown.length) return err(`Unknown field: ${unknown.slice(0, 5).join(', ')}.`, { _fixHint: 'Send siteId and external.' });
        const external = args.external === true;
        const site = await resolveSite(args);
        if (site.error) return err(site.error);
        if (external && !takeBudget(externalBudget, ctx.userId, EXTERNAL_MAX_PER_WINDOW, EXTERNAL_WINDOW_MS)) {
            return err(`External link checks are limited to ${EXTERNAL_MAX_PER_WINDOW} per ${EXTERNAL_WINDOW_MS / 60000} minutes. Ask again later, or run it without external.`);
        }
        const report = await runLinkCheck(site.siteId, { external }, { cmsStore });
        // Counts only: the URLs themselves may carry a token in their query string.
        await deps.audit('cms.links.check.mcp', 'cms_site', site.siteId, ctx.userId, null, {
            tokenName: ctx.token?.name, external, urls: report.external.checked, errors: report.summary.errors, warnings: report.summary.warnings,
        }, ctx.orgId || null);
        return { result: report };
    }

    return { handlers: { cms_check_links: checkLinks } };
}

module.exports = { LINK_TOOLS, createLinkHandlers, EXTERNAL_MAX_PER_WINDOW, EXTERNAL_WINDOW_MS };
