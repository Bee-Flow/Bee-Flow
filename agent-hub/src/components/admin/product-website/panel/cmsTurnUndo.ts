// Undo of an AI builder turn: put the pre-turn snapshot back on the server.
//
// Undoing overwrites on purpose, so every save names the revision the server
// holds RIGHT NOW (the one the panel loaded is older than the turn's own saves).
// The chrome save does not carry the page list, so the page index is restored
// through the page operations: settings of each page, order, homepage.
import { authFetch } from '../../../../utils/helpers';
import { cmsApi } from '../cmsApi';
import { isRecord, revOf, storedRev, withRev } from './cmsRevisions';
import type { CmsPageDoc, CmsPageIndexEntry, CmsSiteDoc } from './cmsPanelTypes';
import type { BuilderTurn } from './useCmsPanelState';
import { mutate, ApiError, errorBody, RefusedError } from '../../../../api/mutate';

/** The site as the server holds it right now: its chrome revision and its page index. */
interface ServerSiteState {
    rev: number;
    homepageId: string | null;
    pages: CmsPageIndexEntry[];
}

/**
 * Read the site's current revision and page index. Undoing an AI turn
 * overwrites on purpose, so it names the revision that is stored now.
 */
async function fetchSiteState(siteId: string): Promise<ServerSiteState> {
    const res = await authFetch(cmsApi.site(siteId));
    const body: unknown = await res.json().catch(() => null);
    const site = isRecord(body) ? body.site : null;
    if (!res.ok || !isRecord(site)) throw new Error('Failed to read the site');
    const pages = Array.isArray(site.pages) ? site.pages.filter(isRecord).map((p) => ({ ...p, id: String(p.id) })) : [];
    return {
        rev: revOf(site),
        homepageId: typeof site.homepageId === 'string' ? site.homepageId : null,
        pages,
    };
}

/** The revision of one page as the server holds it right now, or null when the page is gone. */
async function fetchPageRev(siteId: string, pageId: string): Promise<number | null> {
    const res = await authFetch(cmsApi.page(siteId, pageId));
    if (res.status === 404) return null;
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new Error('Failed to read the page');
    return revOf(body);
}

/** The settings of a page that live in the site's page index (not on the PageDoc). */
const INDEX_FIELDS = ['slug', 'title', 'hideHeader', 'hideFooter', 'noAnalytics', 'isNotFound'] as const;

/** The documents as they stand after the revert, carrying the revisions the server just stored. */
export interface RevertedTurn {
    site: CmsSiteDoc | null;
    pages: CmsPageDoc[];
}

/** Revert one AI turn on the server and return what the panel should show afterwards. */
export async function revertBuilderTurn(siteId: string, turn: BuilderTurn): Promise<RevertedTurn> {
    // 1. DELETE created pages FIRST — removePage rewrites the site
    //    index, so restoring the pre-turn site doc afterwards leaves
    //    the index canonical.
    for (const id of turn.created) {
        const res = await authFetch(cmsApi.page(siteId, id), { method: 'DELETE' });
        if (!res.ok && res.status !== 404) {
            const d = await res.json().catch(() => ({}));
            throw new Error(d.error || `Failed to delete page (${res.status})`);
        }
    }
    // 2. Restore the pre-turn chrome + design. The save names the revision
    //    stored NOW: undoing a turn overwrites on purpose, and the revision
    //    the panel loaded is older than the turn's own saves.
    const restoredRevs = new Map<string, number>();
    let siteRev: number | null = null;
    const serverSite = await fetchSiteState(siteId);
    if (turn.preSite) {
        let res: Response;
        try {
            res = await mutate(cmsApi.site(siteId), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ site: withRev(turn.preSite, serverSite.rev) }),
        });
        } catch (apiErr) {
            if (!(apiErr instanceof RefusedError)) throw apiErr;
            const d = errorBody(apiErr) ?? {};
            throw new Error(d.error || 'Failed to restore site');
        }
        siteRev = storedRev(await res.json().catch(() => null), 'site');
        // The chrome save does not carry the page list, so put the index back
        // through the page operations: settings of each page, order, homepage.
        const pre = turn.preSite;
        const preEntries = (pre.pages || []).filter(e => serverSite.pages.some(p => p.id === e.id));
        for (const entry of preEntries) {
            const now = serverSite.pages.find(p => p.id === entry.id);
            if (!now || INDEX_FIELDS.every(f => now[f] === entry[f])) continue;
            const patch: Record<string, unknown> = {};
            for (const f of INDEX_FIELDS) patch[f] = entry[f];
            try {
                await mutate(cmsApi.pageMeta(siteId, entry.id), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(patch),
            });
            } catch (err) {
                if (!(err instanceof ApiError)) throw err;
                throw new Error('Failed to restore page settings');
            }
        }
        const nowOrder = serverSite.pages.map(p => p.id).join();
        if (preEntries.length && nowOrder !== preEntries.map(e => e.id).join()) {
            try {
                await mutate(cmsApi.pagesOrder(siteId), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderedIds: preEntries.map(e => e.id) }),
            });
            } catch (err) {
                if (!(err instanceof ApiError)) throw err;
                throw new Error('Failed to restore page order');
            }
        }
        if (pre.homepageId && pre.homepageId !== serverSite.homepageId) {
            try {
                await mutate(cmsApi.pageHomepage(siteId, pre.homepageId), { method: 'PUT' });
            } catch (err) {
                if (!(err instanceof ApiError)) throw err;
                throw new Error('Failed to restore the homepage');
            }
        }
    }
    // 3. Restore each touched pre-existing page.
    for (const id of turn.touched) {
        if (turn.created.includes(id)) continue;
        const pre = turn.prePages.find(p => p.id === id);
        if (!pre) continue;
        const rev = await fetchPageRev(siteId, id);
        if (rev === null) continue;
        let res: Response;
        try {
            res = await mutate(cmsApi.page(siteId, id), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ page: withRev(pre, rev) }),
        });
        } catch (err) {
            if (!(err instanceof RefusedError)) throw err;
            const d = errorBody(err) ?? {};
            throw new Error(d.error || 'Failed to restore page');
        }
        const stored = storedRev(await res.json().catch(() => null), 'page');
        if (stored !== null) restoredRevs.set(id, stored);
    }
    const restoredSite = turn.preSite && siteRev !== null ? { ...turn.preSite, rev: siteRev } : turn.preSite;
    const restoredPages = turn.prePages.map(p => {
        const rev = restoredRevs.get(p.id);
        return rev === undefined ? p : { ...p, rev };
    });
    return { site: restoredSite, pages: restoredPages };
}
