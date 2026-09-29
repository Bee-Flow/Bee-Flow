import { useState, useRef, useEffect, useCallback } from 'react';
import { SECTION_TTL_MS, readNavHas, writeNavHas } from './sidebarTokens';
import { useStudioCounts } from '../../../hooks/useStudioCounts';
import { useRuntimeStudioApps } from '../../../moduleRuntime/registry';
import { API_BASE, authFetch } from '../../../utils/helpers';
import { rankStudioItems } from '../../../utils/studioRecents';
import { STUDIO_RECENT_SOURCES, normaliseRecentItems } from '../../../utils/studioRecentSources';
import { studioAppsApi } from '../../admin/Studio/AppStudio/studioAppsApi';
import { makeCanUse } from '../../admin/Studio/studioApps';

/* Published apps, published forms, per-section recent items AND the
   per-section counts for the sidebar's Studio/Apps/Forms flyouts. Extracted
   verbatim from Sidebar — the hook runs on Sidebar's fiber, in the exact
   position the inline code held.

   `countsEnabled` — whether this user gets a Studio row at all. The counts
   poll is the ONE eager fetch in here (see useStudioCounts for why it is
   eager where everything below is hover-lazy); a member with no Studio row
   must not pay for it. */
export function useStudioSectionData({ currentPage, canUseCapability, hasLicenseFeature, user, countsEnabled = false }) {
    // Runtime (remotely-installed) modules contribute extra Studio sections;
    // they join the group after the built-ins, exactly like the old tab bar.
    const runtimeStudioApps = useRuntimeStudioApps();

    // The rail's numbers: one gate-aware aggregate, absent until known.
    const { counts: studioCounts, makers: studioMakers } = useStudioCounts({ enabled: !!countsEnabled });

    // Published apps for the Apps group — the same merge AppsHomePage does
    // (accessible ∪ own, published only), but alphabetical: a menu should not
    // reshuffle every time someone saves. Loaded once, then refreshed when
    // entering the directory or coming back from Studio (where publishing
    // happens) — not on every page change.
    const canSeeApps = canUseCapability('app_studio');
    const [publishedApps, setPublishedApps] = useState([]);
    // Whether the Apps ROW belongs in the menu at all. The capability says the
    // person is allowed an apps directory; this says there is one to look at.
    // Seeded from the last known answer so the menu does not reshuffle on
    // every load — see readNavHas in sidebarTokens.
    const [hasApps, setHasApps] = useState(() => readNavHas('apps'));
    const prevPageRef = useRef(undefined);
    const appsLoadedRef = useRef(false);
    useEffect(() => {
        const prev = prevPageRef.current;
        prevPageRef.current = currentPage;
        if (!canSeeApps) return undefined;
        if (appsLoadedRef.current && currentPage !== 'apps' && prev !== 'studio') return undefined;
        let cancelled = false;
        (async () => {
            // Per-call catches: a consumer without builder rights may 403 on
            // /mine, and the shared directory must still fill the menu.
            const [accessible, mine] = await Promise.all([
                studioAppsApi.listAccessible().catch(() => null),
                studioAppsApi.listMine().catch(() => null),
            ]);
            if (cancelled) return;
            const isPublished = (a) => !!(a?.isPublished ?? a?.is_published);
            const byId = new Map();
            for (const a of [...(accessible?.apps || []), ...(mine?.apps || [])]) {
                if (a?.id && isPublished(a) && !byId.has(a.id)) byId.set(a.id, a);
            }
            const apps = [...byId.values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            setPublishedApps(apps);
            // Only when BOTH calls answered. If they both failed we know
            // nothing, and "nothing" must not be mistaken for "none" — that
            // would take the row away over a dropped connection.
            if (accessible || mine) {
                setHasApps(apps.length > 0);
                writeNavHas('apps', apps.length > 0);
            }
            // Claimed AFTER the load, not before — see the note on
            // formsLoadedRef below. Claiming it up front meant StrictMode's
            // second pass skipped the fetch while the first pass's result had
            // already been discarded as cancelled, leaving the menu empty.
            appsLoadedRef.current = true;
        })();
        return () => { cancelled = true; };
    }, [currentPage, canSeeApps]);

    // Published forms for the Forms group. Org-wide, not per-user: a form has a
    // public URL, so it is the organisation's and a colleague's form has to be
    // findable while they are away. Same refresh discipline as the apps above —
    // once, then on entering Forms or returning from Studio, where forms are
    // built.
    const canSeeForms = hasLicenseFeature('automations') && makeCanUse(user)('automations');
    const [publishedForms, setPublishedForms] = useState([]);
    // Same idea as hasApps: the licence says forms are allowed here, this says
    // the organisation has actually published one.
    const [hasForms, setHasForms] = useState(() => readNavHas('forms'));
    // Set only once a load SUCCEEDS. Setting it before the request finishes is
    // what emptied this menu: StrictMode runs every effect twice in dev, the
    // first pass claimed the flag and was then cancelled by its own cleanup,
    // and the second pass saw the flag and never fetched at all — so the state
    // was never written. Flipping it after the fact makes the load self-heal
    // from a double-invoke, a failed request and an offline moment alike.
    const formsLoadedRef = useRef(false);
    // Its OWN previous-page ref: the apps effect above stamps prevPageRef with
    // the current page before this one runs, so sharing it would compare
    // currentPage against itself and never see "came back from Studio".
    const prevPageForFormsRef = useRef(undefined);
    useEffect(() => {
        const prev = prevPageForFormsRef.current;
        prevPageForFormsRef.current = currentPage;
        if (!canSeeForms) return undefined;
        if (formsLoadedRef.current && currentPage !== 'forms' && prev !== 'studio') return undefined;
        let cancelled = false;
        (async () => {
            try {
                const res = await authFetch(`${API_BASE}/api/automation/forms`);
                if (!res.ok || cancelled) return;
                const data = await res.json();
                const forms = Array.isArray(data?.forms) ? data.forms : [];
                setPublishedForms(forms);
                setHasForms(forms.length > 0);
                writeNavHas('forms', forms.length > 0);
                formsLoadedRef.current = true;
            } catch { /* the row still opens the directory */ }
        })();
        return () => { cancelled = true; };
    }, [currentPage, canSeeForms]);

    /* ─── Recent items per Studio section ───
       Eight sections, so NOT eight eager loaders: a section is fetched the
       first time someone opens its sub-panel, and never again until they come
       back from Studio (where the editing happens).

       `sectionItems` holds normalised `{ id, name, description, updatedAt }[]`
       per section. A section advertises its panel only once it HAS items, so
       there is no loading state to render: nothing is promised before there is
       something to show.

       Freshness is a short TTL rather than a load-once claim plus invalidation
       rules. Renaming an agent, creating a routine and deleting a page all make
       a cached list wrong, and they all happen WHILE you are in Studio — the
       one place you never navigate away from before reaching for this menu. A
       hover is a deliberate act, so re-reading a list a minute old is cheap and
       always right, where "when did this go stale" would be a guess. */
    const [sectionItems, setSectionItems] = useState({});
    const sectionFetchedAtRef = useRef({});
    const sectionInFlightRef = useRef(new Set());
    const loadSectionItems = useCallback(async (sectionId) => {
        const source = STUDIO_RECENT_SOURCES[sectionId];
        if (!source?.url) return;
        // In-flight guard: crossing a row fires mouseenter more than once, and
        // React StrictMode doubles effects — neither should double the request.
        if (sectionInFlightRef.current.has(sectionId)) return;
        const fetchedAt = sectionFetchedAtRef.current[sectionId] || 0;
        if (Date.now() - fetchedAt < SECTION_TTL_MS) return;
        sectionInFlightRef.current.add(sectionId);
        try {
            const res = await authFetch(`${API_BASE}${source.url}`);
            if (!res.ok) return;
            const items = normaliseRecentItems(sectionId, await res.json());
            setSectionItems(prev => ({ ...prev, [sectionId]: items }));
            // Stamped AFTER the load succeeds, never before: a section that
            // 403s or times out stays retryable on the very next hover instead
            // of going quiet for a minute.
            sectionFetchedAtRef.current[sectionId] = Date.now();
        } catch {
            // A section whose list is unreachable simply offers no shortcuts;
            // its row still opens the section itself.
        } finally {
            sectionInFlightRef.current.delete(sectionId);
        }
    }, []);

    /** The five rows to offer for a section — yours first, then most recent. */
    const recentItemsFor = useCallback(
        (sectionId) => rankStudioItems(sectionItems[sectionId] || [], sectionId, 5),
        [sectionItems],
    );

    return {
        runtimeStudioApps, canSeeApps, publishedApps, hasApps,
        canSeeForms, publishedForms, hasForms,
        loadSectionItems, recentItemsFor,
        studioCounts, studioMakers,
    };
}
