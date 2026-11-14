import { useEffect, useEffectEvent } from 'react';
import type { MutableRefObject } from 'react';
import type { CmsLocale, CmsLocaleOverrides, CmsPageDoc, CmsSiteDoc, CmsSiteListEntry } from './cmsPanelTypes';
import { ACTIVE_SITE_LS_KEY } from './helpers';
import { useCmsEditorRead } from '@/api/queries/cmsEditorReads';
import { cmsApi } from '../cmsApi';
import { HEADER_VIRTUAL_ID } from '../sentinels';
import { errorMessage } from '@/utils/caughtError';

type Setter<T> = (value: T) => void;

/** GET /api/cms/sites/:siteId — the whole editor payload of one site. */
interface SitePayload {
    liveSiteId?: string | null;
    defaultLocale?: string;
    locales?: CmsLocale[];
    site?: CmsSiteDoc | null;
    pages?: CmsPageDoc[];
    localeOverrides?: CmsLocaleOverrides;
    publishedAt?: string | null;
}

/** GET /api/cms/sites. */
interface SitesAnswer {
    sites?: CmsSiteListEntry[];
    liveSiteId?: string | null;
}

interface SitesListInput {
    activeSiteIdRef: MutableRefObject<string | null>;
    setActiveSiteId: Setter<string | null>;
    setError: Setter<string | null | undefined>;
    setLiveSiteId: Setter<string | null>;
    setLoading: Setter<boolean>;
    setSites: Setter<CmsSiteListEntry[]>;
    setSitesLoaded: Setter<boolean>;
}

interface SitePayloadInput extends Pick<SitesListInput, 'setError' | 'setLiveSiteId' | 'setLoading'> {
    activeSiteId: string | null;
    sites: CmsSiteListEntry[];
    historyResetRef: MutableRefObject<() => void>;
    pendingSaves: MutableRefObject<Record<string, unknown>>;
    setActiveBlockId: Setter<string | null>;
    setActiveLocale: Setter<string>;
    setActivePageId: Setter<string | null>;
    setDefaultLocale: Setter<string>;
    setDirtySincePublish: Setter<boolean>;
    setLocaleOverrides: Setter<CmsLocaleOverrides>;
    setLocales: Setter<CmsLocale[]>;
    setPages: Setter<CmsPageDoc[]>;
    setPublishedAt: Setter<string | null>;
    setSaveStatus: Setter<string>;
    setSiteDoc: Setter<CmsSiteDoc | null>;
}

const errorText = (err: unknown) => errorMessage(err);

function rememberedSiteId(): string | null {
    try { return localStorage.getItem(ACTIVE_SITE_LS_KEY); } catch { return null; }
}

/**
 * On mount: GET /api/cms/sites → state list. Pick last-used (from
 * localStorage) if it still exists, else the first site, else null.
 * useCmsSitePayload then loads that site's full editor payload.
 */
export function useCmsSitesList({ activeSiteIdRef, setActiveSiteId, setError, setLiveSiteId, setLoading, setSites, setSitesLoaded }: SitesListInput) {
    const list = useCmsEditorRead<SitesAnswer>(['sites'], cmsApi.listSites(), 'Failed to load sites');
    useEffect(() => {
        if (!list.data) return;
        const sites: CmsSiteListEntry[] = Array.isArray(list.data.sites) ? list.data.sites : [];
        setSites(sites);
        setLiveSiteId(list.data.liveSiteId || null);
        const remembered = rememberedSiteId();
        const initial = (remembered && sites.find(s => s.id === remembered))
            ? remembered
            : (sites[0]?.id || null);
        activeSiteIdRef.current = initial;
        setActiveSiteId(initial);
        if (!initial) setLoading(false);  // empty state — no payload to fetch
        setSitesLoaded(true);
    }, [list.data, activeSiteIdRef, setActiveSiteId, setLiveSiteId, setLoading, setSites, setSitesLoaded]);
    useEffect(() => {
        if (!list.error) return;
        setError(errorText(list.error));
        setLoading(false);
        setSitesLoaded(true);
    }, [list.error, setError, setLoading, setSitesLoaded]);
}

/**
 * Load the active site's editor payload whenever activeSiteId changes
 * (initial pick or site switch). Resets all per-site state, then fetches
 * GET /api/cms/sites/:siteId. The soft dirty-since-publish heuristic reads
 * the site list as it is when the payload lands (best effort), without
 * re-running the load.
 */
export function useCmsSitePayload(input: SitePayloadInput) {
    const {
        activeSiteId, sites, historyResetRef, pendingSaves: pendingSavesRef,
        setActiveBlockId, setActiveLocale, setActivePageId, setDefaultLocale, setDirtySincePublish, setError,
        setLiveSiteId, setLoading, setLocaleOverrides, setLocales, setPages, setPublishedAt, setSaveStatus, setSiteDoc,
    } = input;
    const seedDirtySincePublish = useEffectEvent((siteId: string, publishedAt: string | null | undefined) => {
        const listEntry = sites.find(s => s.id === siteId);
        setDirtySincePublish(!!(
            publishedAt
            && listEntry?.updatedAt
            && Date.parse(listEntry.updatedAt) > Date.parse(publishedAt)
        ));
    });
    // A new site starts from nothing, so the editor never shows stale content
    // from the previous site mid-read.
    useEffect(() => {
        if (!activeSiteId) return;
        setLoading(true);
        setError(null);
        setSiteDoc(null);
        setPages([]);
        setActivePageId(HEADER_VIRTUAL_ID);
        setActiveBlockId(null);
        setSaveStatus('idle');
        setPublishedAt(null);
        pendingSavesRef.current = {};
    }, [activeSiteId, pendingSavesRef, setActiveBlockId, setActivePageId, setError, setLoading, setPages, setPublishedAt, setSaveStatus, setSiteDoc]);

    const payload = useCmsEditorRead<SitePayload>(['site', activeSiteId], activeSiteId ? cmsApi.site(activeSiteId) : null, 'Failed to load site');
    const data = activeSiteId ? payload.data : undefined;
    useEffect(() => {
        if (!activeSiteId || !data) return;
        // Server includes liveSiteId on the site payload — refresh
        // it here in case another tab toggled live in the meantime.
        if (data.liveSiteId !== undefined) setLiveSiteId(data.liveSiteId || null);
        setDefaultLocale(data.defaultLocale || 'en');
        setLocales(data.locales || [{ code: 'en', name: 'English', isDefault: true }]);
        setSiteDoc(data.site || null);
        setPages(data.pages || []);
        setLocaleOverrides(data.localeOverrides || { siteByLocale: {}, pagesByLocale: {} });
        setPublishedAt(data.publishedAt || null);
        seedDirtySincePublish(activeSiteId, data.publishedAt);
        setActiveLocale(data.defaultLocale || 'en');
        historyResetRef.current();
        const firstPageId = data.site?.pages?.[0]?.id;
        setActivePageId(firstPageId || HEADER_VIRTUAL_ID);
        if (firstPageId && data.pages?.length) {
            setActiveBlockId(data.pages[0]?.blocks?.[0]?.id || null);
        }
        setLoading(false);
    }, [activeSiteId, data, historyResetRef, setActiveBlockId, setActiveLocale, setActivePageId, setDefaultLocale, setLiveSiteId, setLoading, setLocaleOverrides, setLocales, setPages, setPublishedAt, setSiteDoc]);
    const failure = activeSiteId ? payload.error : null;
    useEffect(() => {
        if (!failure) return;
        setError(errorText(failure));
        setLoading(false);
    }, [failure, setError, setLoading]);
}
