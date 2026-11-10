// The organisation the admin dashboard shows: dashboard state, owned here and
// read by the sections from context (useAdminOrgChoice), never from the URL.
//
//   platform admin  chooses one organisation, or none for "all organisations".
//                   The choice is in the URL as ?org=<id> (a link can be shared,
//                   a reload keeps it) and remembered per browser; an id that is
//                   not one of the organisations falls back to all of them.
//   anyone else     no choice: the server answers for their home organisation
//                   (server/auth/adminOrg.mts), so the SPA never sends an orgId.
//
// The choice is sent with each organisation-scoped request as ?orgId; it is not
// a session setting.

import { createContext, useContext, useEffect, useState } from 'react';
import { useAdminOrganizationsQuery, type AdminOrgOption } from '@/api/queries/adminOrganizations';
import { isPlatformAdmin } from '@/utils/adminAccess';
import { logger } from '@/utils/logger';

const STORAGE_KEY = 'beeflow.admin.org';
const URL_PARAM = 'org';

/** The viewer's home organisation as /auth/my-permissions names it. */
interface HomeOrganization {
    id: string;
    name: string | null;
}

export interface AdminOrgChoice {
    isPlatformAdmin: boolean;
    /** The chosen organisation, or null: all organisations (platform admin) or the home organisation (anyone else). */
    orgId: string | null;
    /** The chosen organisation's name, null while unknown or when none is chosen. */
    orgName: string | null;
    /** The picker's organisations (a platform admin's; empty for anyone else). */
    organizations: readonly AdminOrgOption[];
    /** The organisations have been read (always true for anyone but a platform admin). */
    organizationsLoaded: boolean;
    /**
     * An organisation asked for by the URL or this browser is waiting for the
     * organisation list, which decides whether it exists. Until then no orgId is
     * sent and the sections wait, so a stale id never reaches a request.
     */
    pending: boolean;
    homeOrganization: HomeOrganization | null;
    /** Choose an organisation, or null for all of them. Does nothing for anyone but a platform admin. */
    setOrgId: (id: string | null) => void;
}

const AdminOrgContext = createContext<AdminOrgChoice | null>(null);

export const AdminOrgProvider = AdminOrgContext.Provider;

/** The dashboard's organisation choice, or null outside the admin dashboard. */
export function useAdminOrgChoice(): AdminOrgChoice | null {
    return useContext(AdminOrgContext);
}

/** The orgId to send with an organisation-scoped request: the chosen organisation, or null (send none). */
export function useAdminOrgIdParam(): string | null {
    return useContext(AdminOrgContext)?.orgId ?? null;
}

/** The home organisation from the user object (useAuthSession stores the my-permissions answer there). */
function homeOrganizationOf(user: Readonly<Record<string, unknown>> | null | undefined): HomeOrganization | null {
    const home = user?.homeOrganization as { id?: unknown; name?: unknown } | null | undefined;
    if (!home || typeof home.id !== 'string' || home.id === '') return null;
    return { id: home.id, name: typeof home.name === 'string' && home.name !== '' ? home.name : null };
}

function readUrlOrg(): string | null {
    try {
        return new URLSearchParams(window.location.search).get(URL_PARAM) || null;
    } catch {
        return null;
    }
}

function readStoredOrg(): string | null {
    try {
        return window.localStorage.getItem(STORAGE_KEY) || null;
    } catch {
        return null;
    }
}

function writeStoredOrg(id: string | null): void {
    try {
        if (id) window.localStorage.setItem(STORAGE_KEY, id);
        else window.localStorage.removeItem(STORAGE_KEY);
    } catch (err) {
        logger.debug('admin org choice not remembered: storage blocked; it still lives in the URL and in state', err);
    }
}

/** Put the choice in the address bar without a history entry; other parameters stay. */
function writeUrlOrg(id: string | null): void {
    const url = new URL(window.location.href);
    if ((url.searchParams.get(URL_PARAM) || null) === id) return;
    if (id) url.searchParams.set(URL_PARAM, id);
    else url.searchParams.delete(URL_PARAM);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

/**
 * Owns the dashboard's organisation choice. `locationKey` changes on every
 * dashboard navigation, so the URL gets ?org back after the app router pushed a
 * path without it.
 */
export function useAdminOrg(user: Readonly<Record<string, unknown>> | null | undefined, locationKey: string): AdminOrgChoice {
    const platformAdmin = isPlatformAdmin(user);
    const [requested, setRequested] = useState<string | null>(() => (platformAdmin ? readUrlOrg() ?? readStoredOrg() : null));
    const query = useAdminOrganizationsQuery(platformAdmin);
    const organizations = query.data ?? [];
    const organizationsLoaded = !platformAdmin || query.isSuccess || query.isError;
    // Only an id from the loaded list is sent: one that is not on it (deleted,
    // mistyped, another server's) is all organisations, and before the list is
    // in, nothing is known, so nothing is sent.
    const pending = platformAdmin && !!requested && !organizationsLoaded;
    const known = !!requested && organizationsLoaded && organizations.some(o => o.id === requested);
    const orgId = platformAdmin && known ? requested : null;

    useEffect(() => {
        // While pending, the URL and the remembered choice keep the requested id.
        if (!platformAdmin || pending) return;
        writeUrlOrg(orgId);
        if (organizationsLoaded) writeStoredOrg(orgId);
    }, [platformAdmin, pending, orgId, organizationsLoaded, locationKey]);

    return {
        isPlatformAdmin: platformAdmin,
        orgId,
        orgName: orgId ? organizations.find(o => o.id === orgId)?.name ?? null : null,
        organizations,
        organizationsLoaded,
        pending,
        homeOrganization: homeOrganizationOf(user),
        setOrgId: (id) => { if (platformAdmin) setRequested(id || null); },
    };
}
