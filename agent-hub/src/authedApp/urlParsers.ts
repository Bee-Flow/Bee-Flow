import { PAGE_ROUTES } from './appRoutes';

/**
 * The parsers of what a page is opened with, read off an address: the admin
 * and organisation-settings segments, the chat ids, a Cowork item, a document
 * reference and the Nextcloud app-menu param. appRoutes.ts decides WHICH page
 * an address is; these read the details for that page.
 */

/** The member library's selected document, including notebook/<id> references. */
export function parseDocumentUrl(pathname: string): string | null {
    const ref = pathname.match(/^\/app\/documents\/(.+?)\/?$/)?.[1];
    if (!ref) return null;
    try { return ref.split('/').map(decodeURIComponent).join('/'); }
    catch { return null; }
}

export function documentRoutePath(ref: string | null = null): string {
    return ref ? `${PAGE_ROUTES.documents}/${ref.split('/').map(encodeURIComponent).join('/')}` : PAGE_ROUTES.documents;
}

// Parse /app/admin/{seg1}/{seg2}/{seg3} from the URL. The query and hash are
// never part of a segment: in-app navigation hands over the whole page string
// ('admin/compliance/frameworks?tab=calendar'), and 'frameworks?tab=calendar'
// is not a section.
export function parseAdminPath(pathname: unknown): { seg1: string; seg2: string; seg3: string } {
    const match = String(pathname || '').match(/^\/(?:app\/)?admin(?:\/([^/?#]+))?(?:\/([^/?#]+))?(?:\/([^/?#]+))?/);
    return {
        seg1: match?.[1] || '',
        seg2: match?.[2] || '',
        seg3: match?.[3] || '',
    };
}

// Parse /app/org-settings/{seg1}/{seg2} from the URL
export function parseOrgSettingsPath(pathname: string): { seg1: string; seg2: string } {
    const match = pathname.match(/^\/(?:app\/)?org-settings(?:\/([^/]+))?(?:\/([^/]+))?/);
    return {
        seg1: match?.[1] || '',
        seg2: match?.[2] || '',
    };
}

// parseStudioUrl (parsing /app/studio/* + legacy /app/webpages, /app/meeting-notes)
// now lives in ../components/admin/Studio/studioRoutes.js, derived from the
// Studio app registry.

// Extract the cowork id from /app/cowork/:id, plus the two legacy shapes it
// used to live at: /app/work/:id and the Studio tab /app/studio/cowork/:id.
export function parseCoworkUrl(pathname: string): string | null {
    const match = pathname.match(/^\/app\/(?:studio\/cowork|cowork|work)(?:\/([^/]+))?/);
    return match?.[1] || null;
}

// Extract agent ID prefix and conversation ID prefix from URL
// Supports: /app/a/:shortId, /app/a/:shortId/:shortConvId, /app/agent/:fullId, and legacy bare forms
export function parseAgentUrl(pathname: string): { agentId: string | null; conversationId: string | null } {
    const match = pathname.match(/^\/(?:app\/)?(?:a|agent)\/([a-zA-Z0-9_-]+)(?:\/([a-zA-Z0-9_-]+))?/);
    if (match) {
        return { agentId: match[1], conversationId: match[2] || null };
    }
    return { agentId: null, conversationId: null };
}

// Extract direct chat conversation ID from URL: /app/d/:shortConvId (legacy: /d/:shortConvId)
export function parseDirectChatUrl(pathname: string): string | null {
    const match = pathname.match(/^\/(?:app\/)?d\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
}


// A Studio app opened from its own Nextcloud app-menu entry. The connector's
// per-entry page script (nextcloud-connector/src/studioAppMenus.js) mounts the
// SPA iframe at the signed-proxy ROOT with `?ncStudioApp=<appId>` — inside
// Nextcloud the pathname is the proxy path and never matches /app/apps/:id,
// so the boot route comes from this query param instead.
export function parseNcStudioAppParam(search: string = window.location.search): string | null {
    try {
        const id = new URLSearchParams(search).get('ncStudioApp');
        // App ids are UUIDs; refuse anything else so a mangled param falls
        // back to the normal home screen instead of a broken run view.
        return (id && /^[0-9a-f-]{36}$/i.test(id)) ? id : null;
    } catch (_) {
        return null;
    }
}

// Reserved top-level paths + CMS slug routing rules live in
// utils/cmsPublicRouting.js (shared with the CMS editor's slug warnings).
