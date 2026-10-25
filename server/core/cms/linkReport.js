// @typecheck noImplicitAny
/**
 * One link check of a site draft: the internal links always, the external URLs
 * only when `external` is true. Used by the admin route, the CMS MCP tool and
 * the publish pre-check (which asks for internal links only).
 */

'use strict';

const { collectLinks, checkInternalLinks, bareUrl } = require('./linkCheck');
const { probeUrls } = require('./linkProbe');

/**
 * @param {{ status: number } | { error: string }} result
 * @returns {{ code: string, problem: string, severity: 'error' | 'warning' } | null}
 */
function problemOfProbe(result) {
    if ('error' in result) {
        if (result.error === 'refused') return { code: 'external_refused', severity: 'warning', problem: 'This address points at a private or internal network and was not requested.' };
        if (result.error === 'invalid') return { code: 'external_invalid', severity: 'error', problem: 'Not a plain http(s) address (credentials, an unusual port or another scheme).' };
        return { code: 'external_unreachable', severity: 'error', problem: 'The server could not be reached (name, connection or timeout).' };
    }
    const { status } = result;
    if (status === 404 || status === 410) return { code: 'external_gone', severity: 'error', problem: `The page answers ${status}.` };
    if (status === 401 || status === 403 || status === 429 || status === 999) return { code: 'external_blocked', severity: 'warning', problem: `The site answers ${status} to an automated check, so the link could not be verified.` };
    if (status >= 400) return { code: 'external_error', severity: 'error', problem: `The page answers ${status}.` };
    return null;
}

/**
 * @param {string} siteId
 * @param {{ external?: boolean }} options
 * @param {{ cmsStore: any, probe?: typeof probeUrls }} deps
 */
async function runLinkCheck(siteId, options, deps) {
    const { cmsStore } = deps;
    const probe = deps.probe || probeUrls;
    const [payload, redirects, posts] = await Promise.all([
        cmsStore.getAdminPayload(siteId),
        cmsStore.getRedirects(siteId, { fresh: true }),
        cmsStore.listPosts(siteId, { fresh: true }),
    ]);
    const entries = payload.site?.pages || [];
    const known = {
        pageIds: new Set(entries.map(/** @param {import('../../stores/cms/shared').PageIndexEntry} p */ (p) => p.id)),
        slugs: new Set(entries.map(/** @param {import('../../stores/cms/shared').PageIndexEntry} p */ (p) => p.slug).filter(Boolean)),
        postSlugs: new Set(posts.map(/** @param {{ slug?: string }} p */ (p) => p.slug).filter(Boolean)),
        redirectFroms: new Set(redirects.redirects.map(/** @param {{ from: string }} r */ (r) => r.from)),
    };
    const { problems, external, checked } = checkInternalLinks(collectLinks(payload), known);

    const report = { siteId, internal: { checked }, external: { requested: options.external === true, checked: 0, skipped: 0 }, problems };
    if (options.external !== true || !external.length) return summarise(report);

    const { results, skipped } = await probe(external.map((l) => l.target));
    report.external.checked = results.size;
    report.external.skipped = skipped;
    for (const link of external) {
        const result = results.get(link.target);
        const found = result && problemOfProbe(result);
        if (found) problems.push({ where: link.where, url: bareUrl(link.target), ...found });
    }
    return summarise(report);
}

/** @template {{ problems: any[] }} R @param {R} report */
function summarise(report) {
    const errors = report.problems.filter((p) => p.severity === 'error').length;
    return { ...report, summary: { errors, warnings: report.problems.length - errors } };
}

/**
 * The problems as validation warnings (the shape cms_publish already returns),
 * capped so one broken menu does not bury the answer.
 * @param {{ problems: any[] }} report
 * @param {number} [cap]
 */
function asValidationWarnings(report, cap = 20) {
    const shown = report.problems.slice(0, cap).map((p) => ({
        code: 'broken_link', path: p.where, message: `${p.url || '(empty)'}: ${p.problem}`,
        hint: 'cms_check_links lists every broken link; fix it, or ignore it when it is intended.',
    }));
    const more = report.problems.length - shown.length;
    if (more > 0) shown.push({ code: 'broken_link', path: 'site', message: `${more} more broken links.`, hint: 'cms_check_links lists them all.' });
    return shown;
}

module.exports = { runLinkCheck, asValidationWarnings, problemOfProbe };
