// The link pre-check of Publish: internal links only (the server resolves them
// against the site's own pages, posts and redirects, no network). A failed or
// slow check never blocks publishing; it only means no warning is shown.
import { mutate } from '@/api/mutate';
import { cmsApi } from '../cmsApi';
import type { ConfirmOptions } from '@/components/shared/useConfirm';

const CHECK_TIMEOUT_MS = 8000;

export interface LinkProblem {
    where: string;
    url: string;
    code: string;
    problem: string;
    severity: 'error' | 'warning';
}

const isLinkProblem = (value: unknown): value is LinkProblem => {
    if (typeof value !== 'object' || value === null) return false;
    const v: Record<string, unknown> = { ...value };
    return typeof v.where === 'string' && typeof v.url === 'string' && typeof v.problem === 'string' && v.severity === 'error';
};

/** The broken internal links of a site draft, errors only; [] when the check cannot run. */
export async function fetchLinkErrors(siteId: string): Promise<LinkProblem[]> {
    try {
        const res = await mutate(cmsApi.siteLinkCheck(siteId), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
            // A hanging server must not hang Publish: an abort counts as "no problems".
            signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        });
        const data: unknown = await res.json();
        const problems = typeof data === 'object' && data !== null && 'problems' in data ? data.problems : [];
        return Array.isArray(problems) ? problems.filter(isLinkProblem) : [];
    } catch {
        return [];
    }
}

/** The first few problems as one sentence part for a confirmation: "address (where), ...". */
export function describeLinkErrors(problems: LinkProblem[], max = 5): string {
    const lines = problems.slice(0, max).map(p => `${p.url || '(empty)'} (${p.where})`);
    return lines.join(', ');
}

/**
 * Pre-check of Publish: with broken internal links, ask whether to publish anyway.
 * True when nothing is broken or the administrator confirms.
 */
export async function confirmPublishDespiteBrokenLinks(
    siteId: string,
    confirm: (opts: ConfirmOptions) => Promise<boolean>,
    t: (key: string, fallback: string, params?: Record<string, string | number>) => string,
): Promise<boolean> {
    const broken = await fetchLinkErrors(siteId);
    if (!broken.length) return true;
    return confirm({
        title: t('cms_site.site.publish.links_title', 'Some links lead nowhere'),
        description: t('cms_site.site.publish.links_body', '{count} links lead nowhere: {list}', { count: broken.length, list: describeLinkErrors(broken) }),
        confirmLabel: t('cms_site.site.publish.links_confirm', 'Publish anyway'),
    });
}
