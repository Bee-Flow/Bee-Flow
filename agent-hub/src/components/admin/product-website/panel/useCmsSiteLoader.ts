import { useEffect, useEffectEvent } from 'react';
import type { MutableRefObject } from 'react';
import type { CmsLocale, CmsLocaleOverrides, CmsPageDoc, CmsSiteDoc, CmsSiteListEntry } from './cmsPanelTypes';
import { ACTIVE_SITE_LS_KEY } from './helpers';
import { authFetch } from '../../../../utils/helpers';
import { cmsApi } from '../cmsApi';
import { HEADER_VIRTUAL_ID } from '../sentinels';
import { errorMessage } from '../../../../utils/caughtError';

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
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await authFetch(cmsApi.listSites());
                if (!res.ok) throw new Error(`Failed to load sites (${res.status})`);
                const data = await res.json();
                if (cancelled) return;
                const list: CmsSiteListEntry[] = Array.isArray(data.sites) ? data.sites : [];
                setSites(list);
                setLiveSiteId(data.liveSiteId || null);
                const remembered = rememberedSiteId();
                const initial = (remembered && list.find(s => s.id === remembered))
                    ? remembered
                    : (list[0]?.id || null);
                activeSiteIdRef.current = initial;
                setActiveSiteId(initial);
                if (!initial) setLoading(false);  // empty state — no payload to fetch
            } catch (err) {
                if (!cancelled) {
                    setError(errorText(err));
                    setLoading(false);
                }
            } finally {
                if (!cancelled) setSitesLoaded(true);
            }
        })();
        return () => { cancelled = true; };
    }, [activeSiteIdRef, setActiveSiteId, setError, setLiveSiteId, setLoading, setSites, setSitesLoaded]);
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
        activeSiteId, sites, historyResetRef, pendingSaves,
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
    useEffect(() => {
        if (!activeSiteId) return;
        let cancelled = false;
        setLoading(true);
        setError(null);
        // Clean local state so the editor never shows stale content from
        // the previous site mid-fetch.
        setSiteDoc(null);
        setPages([]);
        setActivePageId(HEADER_VIRTUAL_ID);
        setActiveBlockId(null);
        setSaveStatus('idle');
        setPublishedAt(null);
        pendingSaves.current = {};
        (async () => {
            try {
                const res = await authFetch(cmsApi.site(activeSiteId));
                if (!res.ok) throw new Error(`Failed to load site (${res.status})`);
                const data: SitePayload = await res.json();
                if (cancelled) return;
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
            } catch (err) {
                if (!cancelled) setError(errorText(err));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [activeSiteId, historyResetRef, pendingSaves, setActiveBlockId, setActiveLocale, setActivePageId, setDefaultLocale, setError, setLiveSiteId, setLoading, setLocaleOverrides, setLocales, setPages, setPublishedAt, setSaveStatus, setSiteDoc]);
}
