// Page/block content mutators + locale-override (translation-mode) mutators
// + AI translate of the ProductWebsitePanel container — moved verbatim from
// ProductWebsitePanel.jsx. State stays owned by the panel (threaded in).
import { useCallback, useEffect } from 'react';
import { authFetch } from '../../../../utils/helpers';
import { toast } from '../../../shared/Toast';
import { cmsApi } from '../cmsApi';
import { setLocalePath } from '../localeMerge';
import type useCmsPanelState from './useCmsPanelState';
import type useCmsAutosave from './useCmsAutosave';
import type useCmsHistory from './useCmsHistory';
import type { CmsPageDoc, CmsBlock } from './cmsPanelTypes';

type PanelState = ReturnType<typeof useCmsPanelState>;
type History = ReturnType<typeof useCmsHistory>;
type Scope = 'page' | 'site';
type LocaleOverride = Record<string, unknown>;

interface MutationsInput extends Pick<PanelState,
    'pages' | 'activeLocale' | 'locales' | 'translateTier' | 'aiStatus' | 'setAiStatus'
    | 'localeOverrides' | 'setLocaleOverrides' | 'localeOverridesRef'
    | 'aiRunningRef' | 'activeSiteIdRef' | 'confirm'> {
    activePage: CmsPageDoc | null | undefined;
    activePageId: string | null;
    siteStateRef: History['siteStateRef'];
    pagesStateRef: History['pagesStateRef'];
    history: History['history'];
    scheduleSave: ReturnType<typeof useCmsAutosave>['scheduleSave'];
    drainPendingSaves: ReturnType<typeof useCmsAutosave>['drainPendingSaves'];
}

export default function useCmsContentMutations({
    pages, activePage, activePageId, activeLocale, locales, translateTier,
    aiStatus, setAiStatus, localeOverrides, setLocaleOverrides, localeOverridesRef,
    aiRunningRef, activeSiteIdRef, siteStateRef, pagesStateRef,
    history, scheduleSave, drainPendingSaves, confirm,
}: MutationsInput) {
    // ── page mutations ───────────────────────────────────────────────

    // The history object is rebuilt per render; its commit is a stable callback.
    const commitHistory = history.commit;
    const updatePage = useCallback((pageId: string, updater: (p: CmsPageDoc) => CmsPageDoc) => {
        const prevPages = pagesStateRef.current || [];
        let found = false;
        const nextPages = prevPages.map((p) => {
            if (p.id !== pageId) return p;
            found = true;
            return updater(p);
        });
        if (!found) return;
        commitHistory({ site: siteStateRef.current, pages: nextPages });
    }, [commitHistory, pagesStateRef, siteStateRef]);

    // Block content updated via panel editor
    const updateBlockContent = useCallback((pageId: string, blockId: string, nextContent: unknown) => {
        // Translations follow their items: the server re-aligns the locale
        // overrides when the reordered content is saved and returns them
        // (see useCmsAutosave), so no reorder warning is needed here.
        updatePage(pageId, p => ({
            ...p,
            blocks: (p.blocks as CmsBlock[]).map(b => b.id === blockId ? { ...b, content: nextContent as CmsBlock['content'] } : b),
        }));
    }, [updatePage]);

    // Block style overrides — same flow as content, just lands on block.style.
    // Both run through updatePage → scheduleSave(pageId, …) → debounced PUT,
    // so a content edit and a style edit in the same window coalesce into
    // one PageDoc save.
    const updateBlockStyle = useCallback((pageId: string, blockId: string, nextStyle: unknown) => {
        updatePage(pageId, p => ({
            ...p,
            blocks: (p.blocks as CmsBlock[]).map(b => b.id === blockId ? { ...b, style: nextStyle as CmsBlock['style'] } : b),
        }));
    }, [updatePage]);

    // ── locale-override mutators (translation mode) ─────────────────
    // Keep a synchronous mirror so rapid edits read the latest override.
    useEffect(() => { localeOverridesRef.current = localeOverrides; }, [localeOverrides, localeOverridesRef]);

    // Write a single sparse text leaf into the active page's locale override
    // (segs are into the override root, e.g. ['blocks', id, 'content', …] or
    // ['seo','metaTitle']). Empty string prunes the leaf so it re-inherits the
    // source. Saves via the namespaced 'locale:page:…' debounce key.
    const updatePageOverride = useCallback((pageId: string, locale: string, segs: (string | number)[], value: unknown) => {
        // Block manual translation writes while an AI translate is in flight.
        // The AI call reads a snapshot at request start and returns the whole
        // override; letting a manual edit land in between would be silently
        // overwritten when that result folds into local state.
        if (aiRunningRef.current) return;
        const prev = localeOverridesRef.current;
        const cur = prev.pagesByLocale?.[pageId]?.[locale] || { version: 1, blocks: {} };
        const next = setLocalePath(cur, segs, value);
        const updated = {
            ...prev,
            pagesByLocale: {
                ...prev.pagesByLocale,
                [pageId]: { ...(prev.pagesByLocale?.[pageId] || {}), [locale]: next },
            },
        };
        localeOverridesRef.current = updated;
        setLocaleOverrides(updated);
        scheduleSave(`locale:page:${pageId}:${locale}`, next);
    }, [scheduleSave, aiRunningRef, localeOverridesRef, setLocaleOverrides]);

    // Write a single sparse text leaf into the site (chrome) locale override —
    // header/footer text by storage path, or ['pageTitles', pageId].
    const updateSiteOverride = useCallback((locale: string, segs: (string | number)[], value: unknown) => {
        if (aiRunningRef.current) return; // see updatePageOverride
        const prev = localeOverridesRef.current;
        const cur = prev.siteByLocale?.[locale] || { version: 1 };
        const next = setLocalePath(cur, segs, value);
        const updated = { ...prev, siteByLocale: { ...prev.siteByLocale, [locale]: next } };
        localeOverridesRef.current = updated;
        setLocaleOverrides(updated);
        scheduleSave(`locale:site:${locale}`, next);
    }, [scheduleSave, aiRunningRef, localeOverridesRef, setLocaleOverrides]);

    // Replace a whole override in local state WITHOUT scheduling a save — used
    // after AI translate, which has already persisted server-side.
    const replacePageOverride = useCallback((pageId: string, locale: string, full: LocaleOverride | null) => {
        const prev = localeOverridesRef.current;
        const updated = {
            ...prev,
            pagesByLocale: {
                ...prev.pagesByLocale,
                [pageId]: { ...(prev.pagesByLocale?.[pageId] || {}), [locale]: full },
            },
        };
        localeOverridesRef.current = updated;
        setLocaleOverrides(updated);
    }, [localeOverridesRef, setLocaleOverrides]);
    const replaceSiteOverride = useCallback((locale: string, full: LocaleOverride | null) => {
        const prev = localeOverridesRef.current;
        const updated = { ...prev, siteByLocale: { ...prev.siteByLocale, [locale]: full } };
        localeOverridesRef.current = updated;
        setLocaleOverrides(updated);
    }, [localeOverridesRef, setLocaleOverrides]);

    // AI pre-fill: translate the active page ('page') or site chrome ('site')
    // to the active locale. The server preserves existing manual translations
    // and returns the merged override, which we fold into local state.
    const handleAiTranslate = useCallback(async (scope: Scope, tier = 'fast') => {
        const siteId = activeSiteIdRef.current;
        if (!siteId || aiStatus?.state === 'running') return;
        if (scope === 'page' && !activePage) return;
        // Flush any pending manual edits first so the server reads them and
        // doesn't translate over text the user just typed.
        await drainPendingSaves();
        aiRunningRef.current = true;
        setAiStatus({ state: 'running', scope });
        try {
            const url = scope === 'site'
                ? cmsApi.siteAiTranslate(siteId, activeLocale)
                : cmsApi.pageAiTranslate(siteId, (activePage as CmsPageDoc).id, activeLocale);
            const res = await authFetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ modelTier: tier || 'fast' }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `Translate failed (${res.status})`);
            if (scope === 'site') replaceSiteOverride(activeLocale, data.override);
            else replacePageOverride((activePage as CmsPageDoc).id, activeLocale, data.override);
            setAiStatus({ state: 'done', scope, translated: data.translated, total: data.total });
            toast.success(data.message || `Translated ${data.translated || 0} fields`);
        } catch (err) {
            setAiStatus({ state: 'error', scope });
            toast.error(`AI translate failed: ${(err as Error).message}`);
        } finally {
            aiRunningRef.current = false;
        }
    }, [activeLocale, activePage, aiStatus, drainPendingSaves, replacePageOverride, replaceSiteOverride, activeSiteIdRef, aiRunningRef, setAiStatus]);

    // Reset AI status when switching page/locale so stale "done" badges clear.
    useEffect(() => { setAiStatus(null); }, [activePageId, activeLocale, setAiStatus]);

    // D3 recovery — clear ONE block's translations for the active locale,
    // then run the normal AI translate (the server only fills missing leaves,
    // so manual work on other blocks is never re-sent or overwritten).
    const handleClearAndRetranslateBlock = useCallback(async (blockId: string) => {
        if (!activePage || aiRunningRef.current) return;
        const pageId = (activePage as CmsPageDoc).id;
        const prev = localeOverridesRef.current;
        const ov = prev.pagesByLocale?.[pageId]?.[activeLocale];
        if (ov?.blocks && Object.prototype.hasOwnProperty.call(ov.blocks, blockId)) {
            const nextBlocks = { ...(ov.blocks as Record<string, unknown>) };
            delete nextBlocks[blockId];
            const nextOv = { ...ov, blocks: nextBlocks };
            const updated = {
                ...prev,
                pagesByLocale: {
                    ...prev.pagesByLocale,
                    [pageId]: { ...(prev.pagesByLocale?.[pageId] || {}), [activeLocale]: nextOv },
                },
            };
            localeOverridesRef.current = updated;
            setLocaleOverrides(updated);
            scheduleSave(`locale:page:${pageId}:${activeLocale}`, nextOv);
        }
        await handleAiTranslate('page', translateTier);
    }, [activePage, activeLocale, scheduleSave, handleAiTranslate, translateTier, aiRunningRef, localeOverridesRef, setLocaleOverrides]);

    // Remove EVERY override of the active locale for the current scope —
    // rides the (previously unused) DELETE locale-override endpoints. Drain
    // first so a queued locale:* save can't resurrect the override after
    // the DELETE lands.
    const handleResetTranslations = useCallback(async (scope: Scope) => {
        const siteId = activeSiteIdRef.current;
        if (!siteId || aiRunningRef.current) return;
        if (scope === 'page' && !activePage) return;
        const localeLabel = locales.find(l => l.code === activeLocale)?.name || activeLocale;
        const ok = await confirm({
            title: `Reset ${localeLabel} translations?`,
            description: scope === 'site'
                ? `Removes every ${localeLabel} translation for the header, footer and page titles. Fields fall back to the source language.`
                : `Removes every ${localeLabel} translation for this page. Fields fall back to the source language.`,
            confirmLabel: 'Reset translations',
            destructive: true,
        });
        if (!ok) return;
        await drainPendingSaves();
        try {
            const url = scope === 'site'
                ? cmsApi.siteLocaleOverride(siteId, activeLocale)
                : cmsApi.pageLocaleOverride(siteId, (activePage as CmsPageDoc).id, activeLocale);
            const res = await authFetch(url, { method: 'DELETE' });
            if (!res.ok) {
                const d = await res.json().catch(() => ({}));
                throw new Error(d.error || `Reset failed (${res.status})`);
            }
            if (scope === 'site') replaceSiteOverride(activeLocale, null);
            else replacePageOverride((activePage as CmsPageDoc).id, activeLocale, null);
            setAiStatus(null);
            toast.success(`${localeLabel} translations reset`);
        } catch (err) {
            toast.error(`Reset failed: ${(err as Error).message}`);
        }
    }, [activePage, activeLocale, locales, confirm, drainPendingSaves, replacePageOverride, replaceSiteOverride, activeSiteIdRef, aiRunningRef, setAiStatus]);

    return {
        updatePage, updateBlockContent, updateBlockStyle,
        updatePageOverride, updateSiteOverride, replacePageOverride, replaceSiteOverride,
        handleAiTranslate, handleClearAndRetranslateBlock, handleResetTranslations,
    };
}
