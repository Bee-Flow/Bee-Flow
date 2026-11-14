import { useEffect, useMemo } from 'react';
import { refreshLocation, useLocation } from '../router/history';
import { parseStudioQuery, parseStudioUrl } from '../components/admin/Studio/studioRoutes';
import { parseProjectUrl, type ProjectUrl } from '../utils/projectRoutes';
import { matchAppRoute, type AppRoute } from './appRoutes';
import { parseAdminPath, parseCoworkUrl, parseDocumentUrl, parseNcStudioAppParam, parseOrgSettingsPath } from './urlParsers';
import type { StudioRoute } from '../AgentHub/studioRouteProps';

/**
 * Everything the app shell used to hold in state about "where are we", read
 * off the address instead: the page and the ids and flags each page is opened
 * with. One object per published move, so a page handed the same address again
 * still gets a fresh route object (the projects page relies on that to come
 * back after a chat hid it).
 */
export interface AppRouteState {
    route: AppRoute;
    page: string;
    adminPath: { seg1: string; seg2: string; seg3: string };
    orgSettingsPath: { seg1: string; seg2: string };
    coworkId: string | null;
    documentId: string | null;
    designerAgentId: string | null;
    formViewToken: string | null;
    appRunId: string | null;
    studioRoute: StudioRoute;
    /** Null off the projects pages; `{ projectId: null }` is the list. */
    projectRoute: ProjectUrl | null;
}

const NO_STUDIO: StudioRoute = { section: 'agents', id: null };

function deriveAppRoute(pathname: string, search: string): AppRouteState {
    // Opened from a Nextcloud app-menu entry, the proxy-root pathname cannot
    // say which screen: the app id travels in ?ncStudioApp instead.
    const ncAppId = parseNcStudioAppParam(search);
    const route = ncAppId ? { page: 'appRun', params: { appId: ncAppId }, pathname, search, redirect: null } : matchAppRoute(pathname, search);
    const { page, params } = route;
    const onDesigner = page === 'agentDesigner' || page === 'agentDesignerAdvanced';
    return {
        route,
        page,
        adminPath: parseAdminPath(pathname),
        orgSettingsPath: parseOrgSettingsPath(pathname),
        coworkId: page === 'cowork' ? parseCoworkUrl(pathname) : null,
        documentId: page === 'documents' ? parseDocumentUrl(pathname) : null,
        designerAgentId: onDesigner ? params.agentId ?? null : null,
        formViewToken: page === 'formView' ? params.token ?? null : null,
        appRunId: page === 'appRun' ? params.appId ?? null : null,
        // Path = which Studio item; query = what of it is open (?view/run/step),
        // so a run deep link survives a cold load.
        studioRoute: page === 'studio' ? { ...parseStudioUrl(pathname), ...parseStudioQuery(search) } : NO_STUDIO,
        projectRoute: page === 'projects' ? parseProjectUrl(pathname) : null,
    };
}

/**
 * The current route, re-derived on every move. Runtime (remotely installed)
 * modules add Studio sections of their own; on a cold load of a deep link into
 * one the module map is still empty, so the Studio part is parsed again once
 * the descriptors arrive.
 */
export function useAppRoute(): AppRouteState {
    const location = useLocation();
    useEffect(() => {
        window.addEventListener('beeflow:modules-changed', refreshLocation);
        return () => window.removeEventListener('beeflow:modules-changed', refreshLocation);
    }, []);
    // `location` is a new object per published move: that is the key.
    return useMemo(() => deriveAppRoute(location.pathname, location.search), [location]);
}
