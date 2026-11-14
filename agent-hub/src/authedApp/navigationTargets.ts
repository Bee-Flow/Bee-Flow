import {
    MOBILE_ALLOWED_PAGES,
    PAGE_ROUTES,
    isApprovalsStudioPath,
    isPageAllowedOnMobile,
    matchAppRoute,
    mobilePageKey,
} from './appRoutes';
import { documentRoutePath } from './urlParsers';
import { isProjectsPage, projectRouteFromPage } from './projectNavigation';
import { orgLicensePage } from './settingsRoutes';
import { parseStudioQuery, sectionFromRaw, segmentForSection } from '../components/admin/Studio/studioRoutes';
import { projectRoutePath } from '../utils/projectRoutes';

/**
 * The page names the app's 180 `onNavigate` call sites speak ('studio/agents',
 * 'admin/ai-config', 'agentDesigner:<id>', 'cowork/<id>', …), each resolved to
 * the one address of that page plus the history.state pages read back. The
 * page itself is then derived from the address (useAppRoute), so this is the
 * only place a page name is turned into a move.
 */
export interface NavigationTarget {
    path: string;
    state: Record<string, unknown>;
    replace: boolean;
}

export interface NavigationContextInfo {
    isMobile: boolean;
    isConsumerAccount: boolean;
    /** The address the app is at when the call is made. */
    currentPathname: string;
}

interface Options { replace?: boolean }

const target = (path: string, state: Record<string, unknown>, replace = false): NavigationTarget => ({ path, state, replace });

/** A phone may open this page, as the allow-list and the approvals slice of Studio say. */
function allowedOnPhone(page: string): boolean {
    if (page.startsWith('/')) {
        const { page: key } = matchAppRoute(page);
        return MOBILE_ALLOWED_PAGES.has(key) || (key === 'studio' && isApprovalsStudioPath(page));
    }
    return isPageAllowedOnMobile(mobilePageKey(page));
}

function withId(page: string, head: string): string | null {
    return page.startsWith(`${head}:`) ? page.slice(head.length + 1) : null;
}

function studioTarget(page: string, replace: boolean): NavigationTarget {
    // Split off the query FIRST: ?view/run/step is builder state and must not
    // be chopped up by the path split below.
    const qIndex = page.indexOf('?');
    const pagePath = qIndex >= 0 ? page.slice(0, qIndex) : page;
    const search = qIndex >= 0 ? page.slice(qIndex) : '';
    // 'studio:agents:<id>' and 'studio/agents/<id>' are the same address.
    const parts = pagePath.replace(/^studio[/:]?/, '').split(/[/:]/).filter(Boolean);
    const section = sectionFromRaw(parts[0] || 'agents');
    const rest = parts.slice(1).join('/');
    const path = `/app/studio/${segmentForSection(section)}${rest ? `/${rest}` : ''}${search}`;
    // `beeflowRunOpen` lets the runs panel prefer history.back() when closing
    // a run IT pushed, so Back stays symmetric.
    return target(path, { page: 'studio', beeflowRunOpen: parseStudioQuery(search).runId || null }, replace);
}

type Resolver = (page: string, replace: boolean, ctx: NavigationContextInfo) => NavigationTarget | null;

const idOf = (page: string, head: string) => (page.startsWith(`${head}/`) ? page.slice(head.length + 1) : null);
const isPage = (page: string, head: string) => page === head || page.startsWith(`${head}/`);

/** The page names, in the order the old navigateToPage tried them, so every alias keeps landing where it did. */
const RESOLVERS: readonly Resolver[] = [
    // An address rather than a page name: go there as is.
    (page, replace) => (page.startsWith('/') ? target(page, { page: matchAppRoute(page).page }, replace) : null),
    (page, replace) => {
        if (!isProjectsPage(page)) return null;
        const route = projectRouteFromPage(page);
        return target(projectRoutePath(route.projectId, route.tab, route.sub), { page: 'projects', projectId: route.projectId }, replace);
    },
    (page) => (page === '/' || page === 'home' ? target('/app', {}) : null),
    (page, replace) => {
        if (page !== 'agentDesignerAdvanced' && !page.startsWith('agentDesignerAdvanced:')) return null;
        const agentId = withId(page, 'agentDesignerAdvanced');
        return target(agentId ? `/app/agent-designer-advanced/${agentId}` : '/app/agent-designer-advanced', { page: 'agentDesignerAdvanced' }, replace);
    },
    (page, replace) => (isPage(page, 'studio') || page.startsWith('studio:') ? studioTarget(page, replace) : null),
    (page, replace) => (page === 'agentWizard' ? target('/app/agent-wizard', { page: 'agentWizard' }, replace) : null),
    (page, replace) => {
        if (page !== 'agentDesigner' && !page.startsWith('agentDesigner:')) return null;
        const agentId = withId(page, 'agentDesigner');
        // Without an agent the editor is Studio's agents section (the same
        // forward a cold load of /app/agent-designer makes).
        return agentId ? target(`/app/agent-designer/${agentId}`, { page: 'agentDesigner' }, replace) : studioTarget('studio/agents', replace);
    },
    // The old standalone automations page key: Automations live in Studio.
    (page, replace) => {
        if (page !== 'aiTasks' && !page.startsWith('aiTasks:')) return null;
        const id = withId(page, 'aiTasks');
        return studioTarget(id ? `studio/automations/${id}` : 'studio/automations', replace);
    },
    (page, replace) => (isPage(page, 'settings') ? target(`/app/settings${page.slice('settings'.length)}`, { page: 'settings' }, replace) : null),
    // Admin sub-paths ('admin/ai-config', 'admin/security/sso') keep their
    // query: the Compliance Center hands over its header tab in it.
    (page, replace) => (page.startsWith('admin') ? target(`/app/admin${page.slice('admin'.length)}`, { page: 'admin' }, replace) : null),
    (page, replace) => (page === 'orgSettings' || page.startsWith('org-settings')
        ? target(`/app/${page === 'orgSettings' ? 'org-settings' : page}`, { page: 'orgSettings' }, replace)
        : null),
    (page, replace) => (isPage(page, 'documents') ? target(documentRoutePath(idOf(page, 'documents')), { page: 'documents' }, replace) : null),
    // 'notebooks' opens the library in Studio → Documents; 'notebooks/<id>' that notebook.
    (page, replace) => {
        if (!isPage(page, 'notebooks')) return null;
        const notebookId = idOf(page, 'notebooks');
        return studioTarget(notebookId ? `studio/documents/notebook/${notebookId}` : 'studio/documents', replace);
    },
    (page, replace, ctx) => {
        if (!isPage(page, 'cowork')) return null;
        const coworkId = idOf(page, 'cowork');
        // Selecting a row inside Cowork is a filter, not a destination, so it
        // replaces: Back keeps meaning "leave Cowork". Arriving from another
        // page pushes, so Back returns to that page.
        const onCowork = matchAppRoute(ctx.currentPathname).page === 'cowork';
        return target(coworkId ? `/app/cowork/${coworkId}` : '/app/cowork', { page: 'cowork', coworkId }, replace || (!!coworkId && onCowork));
    },
    (page, replace) => (page.startsWith('forms/') ? target(`/app/forms/${page.slice('forms/'.length)}`, { page: 'formView' }, replace) : null),
    (page, replace) => (page.startsWith('apps/') ? target(`/app/apps/${page.slice('apps/'.length)}`, { page: 'appRun' }, replace) : null),
    // Webpages live inside Studio; the old page names keep landing there.
    (page, replace) => {
        if (!isPage(page, 'webpages')) return null;
        const webpageId = idOf(page, 'webpages');
        return target(webpageId ? `/app/studio/webpages/${webpageId}` : '/app/studio/webpages', { page: 'studio' }, replace);
    },
];

/** The move a page name asks for. */
export function resolveNavigationTarget(page: string, { replace = false }: Options, ctx: NavigationContextInfo): NavigationTarget {
    // The plan page of this account: Settings for a personal account, the
    // dashboard's licence page for an organisation (Settings on a phone).
    // Resolved ahead of the phone gate, which judges the page it resolves to.
    if (page === 'billing') {
        return resolveNavigationTarget(ctx.isConsumerAccount ? 'settings/account/license' : orgLicensePage(ctx.isMobile), { replace }, ctx);
    }
    // Mobile access control: on phones, any destination that is not chat or
    // user-settings bounces to the app home.
    if (ctx.isMobile && !allowedOnPhone(page)) return target('/app', { page: 'agents' });
    for (const resolve of RESOLVERS) {
        const hit = resolve(page, replace, ctx);
        if (hit) return hit;
    }
    return target(PAGE_ROUTES[page] || '/', { page }, replace);
}
