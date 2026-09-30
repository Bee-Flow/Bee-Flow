import { normalizeWorkspaceTab } from '../components/projects/workspace/types';
import { parseProjectUrl } from '../utils/projectRoutes';

/**
 * How a move between projects pages is written into the browser history.
 *
 *   none     the URL already says it (a re-render asking for the same page).
 *   replace  the move is a correction, not a step the person took: leaving the
 *            create form for the project it just created, or a workspace
 *            address being normalised (no tab yet, or a tab id from before the
 *            workspace existed, rewritten to the tab it already shows). Pushing
 *            those would make Back land on a page that sends you forward again.
 *   push     everything else, so Back walks the person's own steps — including
 *            the first click from a bare project address to another tab: Back
 *            from there must return to the overview, not leave the project.
 */
export type ProjectHistoryMode = 'none' | 'replace' | 'push';

/** Tab ids the old project page used; the workspace maps them on arrival. */
export const LEGACY_PROJECT_TABS: ReadonlySet<string> = new Set(['general', 'threads', 'resources', 'memory', 'danger']);

export function projectHistoryMode(currentPathname: string, nextPath: string): ProjectHistoryMode {
    if (currentPathname === nextPath) return 'none';
    const current = parseProjectUrl(currentPathname);
    const next = parseProjectUrl(nextPath);
    if (!current || !next) return 'push';
    if (current.projectId === '' && next.projectId) return 'replace';
    const normalising = !!current.projectId && current.projectId === next.projectId
        && (!current.tab || LEGACY_PROJECT_TABS.has(current.tab))
        && next.tab === normalizeWorkspaceTab(current.tab)
        && (next.sub || null) === (current.sub || null);
    return normalising ? 'replace' : 'push';
}

/** A projects page named the way `navigateToPage` names pages:
 *  'projects', 'projects/new', 'projects/<id>[/<tab>[/<sub>]]'. */
export function isProjectsPage(page: string): boolean {
    return page === 'projects' || page.startsWith('projects/');
}

/** The route a projects page name points at. */
export function projectRouteFromPage(page: string) {
    return parseProjectUrl(`/app/${page}`) || { projectId: null, tab: null, sub: null };
}
