// Page/block content mutators + locale-override (translation-mode) mutators
// + AI translate of the ProductWebsitePanel container — moved verbatim from
// ProductWebsitePanel.jsx. State stays owned by the panel (threaded in).
import { useCallback, useEffect, type MutableRefObject } from 'react';
import { authFetch } from '../../../../utils/helpers';
import { toast } from '../../../shared/Toast';
import { cmsApi } from '../cmsApi';
import { setLocalePath } from '../localeMerge';
import { detectArrayReorder, blockHasArrayOverrides } from '../translatable';
import type { CmsActivePage, CmsBlock, CmsLocale, CmsLocaleOverrides, CmsPageDoc, CmsSiteDoc } from './cmsPanelTypes';
import type { CmsAiStatus } from './useCmsPanelState';
import type { CmsHistoryDraft } from './useCmsHistory';
import type { ConfirmFn } from './PanelSlots';

type Segs = (string | number)[];
type Override = Record<string, unknown>;
type PageOverrideShape = { blocks?: Record<string, unknown>; [key: string]: unknown };

interface AiTranslateResponse {
    error?: string;
    override?: Override | null;
    translated?: number;
    total?: number;
    message?: string;
}

export interface UseCmsContentMutationsArgs {
    pages: CmsPageDoc[];
    activePage: CmsActivePage | null | undefined;
    activePageId: string;
    activeLocale: string;
    locales: CmsLocale[];
    translateTier: string;
    aiStatus: CmsAiStatus | null;
    setAiStatus: (status: CmsAiStatus | null) => void;
    localeOverrides: CmsLocaleOverrides;
    setLocaleOverrides: (overrides: CmsLocaleOverrides) => void;
    localeOverridesRef: MutableRefObject<CmsLocaleOverrides>;
    reorderWarnedRef: MutableRefObject<Set<string>>;
    aiRunningRef: MutableRefObject<boolean>;
    activeSiteIdRef: MutableRefObject<string | null | undefined>;
    siteStateRef: MutableRefObject<CmsSiteDoc | null | undefined>;
    pagesStateRef: MutableRefObject<CmsPageDoc[]>;
    history: { commit: (draft: CmsHistoryDraft) => void };
    scheduleSave: (key: string, payload: unknown) => void;
    drainPendingSaves: () => Promise<void>;
    confirm: ConfirmFn;
}

export default function useCmsContentMutations({
    pages, activePage, activePageId, activeLocale, locales, translateTier,
    aiStatus, setAiStatus, localeOverrides, setLocaleOverrides, localeOverridesRef,
    reorderWarnedRef, aiRunningRef, activeSiteIdRef, siteStateRef, pagesStateRef,
    history, scheduleSave, drainPendingSaves, confirm,
}: UseCmsContentMutationsArgs) {
    // ── page mutations ───────────────────────────────────────────────

    // The history object is rebuilt per render; its commit is a stable callback.
    const commitHistory = history.commit;
    const updatePage = useCallback((pageId: string, updater: (p: CmsPageDoc) => CmsPageDoc) => {
        const prevPages = pagesStateRef.current || [];
        let found = false;
        const nextPages = prevPages.map(p => {
            if (p.id !== pageId) return p;
            found = true;
            return updater(p);
        });
        if (!found) return;
        commitHistory({ site: siteStateRef.current, pages: nextPages });
    }, [commitHistory, pagesStateRef, siteStateRef]);

    // Block content updated via panel editor
    const updateBlockContent = useCallback((pageId: string, blockId: string, nextContent: unknown) => {
        // D4 guard: overrides address array items by INDEX, so reordering a
        // list in the default locale silently shifts translations onto the
        // wrong items in every other locale (schema fix deferred). Detect the
        // reorder and warn — once per block per session, only when that block
        // actually has array translations.
        const prevContent = pages.find(p => p.id === pageId)?.blocks?.find(b => b.id === blockId)?.content;
        if (prevContent
            && !reorderWarnedRef.current.has(blockId)
            && detectArrayReorder(prevContent, nextContent)
            && blockHasArrayOverrides(localeOverridesRef.current, pageId, blockId)) {
            reorderWarnedRef.current.add(blockId);
            toast.error('Reordering list items can shift their translations in other languages — review them in translate mode.');
        }
        updatePage(pageId, p => ({
            ...p,
            blocks: (p.blocks as CmsBlock[]).map(b => b.id === blockId ? { ...b, content: nextContent as Record<string, unknown> } : b),
        }));
    }, [updatePage, pages, localeOverridesRef, reorderWarnedRef]);

    // Block style overrides — same flow as content, just lands on block.style.
    // Both run through updatePage → scheduleSave(pageId, …) → debounced PUT,
    // so a content edit and a style edit in the same window coalesce into
    // one PageDoc save.
    const updateBlockStyle = useCallback((pageId: string, blockId: string, nextStyle: unknown) => {
        updatePage(pageId, p => ({
            ...p,
            blocks: (p.blocks as CmsBlock[]).map(b => b.id === blockId ? { ...b, style: nextStyle as Record<string, unknown> } : b),
        }));
    }, [updatePage]);

    // ── locale-override mutators (translation mode) ─────────────────
    // Keep a synchronous mirror so rapid edits read the latest override.
    useEffect(() => { localeOverridesRef.current = localeOverrides; }, [localeOverrides, localeOverridesRef]);

    // Write a single sparse text leaf into the active page's locale override
    // (segs are into the override root, e.g. ['blocks', id, 'content', …] or
    // ['seo','metaTitle']). Empty string prunes the leaf so it re-inherits the
    // source. Saves via the namespaced 'locale:page:…' debounce key.
    const updatePageOverride = useCallback((pageId: string, locale: string, segs: Segs, value: unknown) => {
        // Block manual translation writes while an AI translate is in flight.
        // The AI call reads a snapshot at request start and returns the whole
        // override; letting a manual edit land in between would be silently
        // overwritten when that result folds into local state.
        if (aiRunningRef.current) return;
        const prev = localeOverridesRef.current;
        const cur = prev.pagesByLocale?.[pageId]?.[locale] || { version: 1, blocks: {} };
        const next = setLocalePath(cur, segs, value) as Override;
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
    const updateSiteOverride = useCallback((locale: string, segs: Segs, value: unknown) => {
        if (aiRunningRef.current) return; // see updatePageOverride
        const prev = localeOverridesRef.current;
        const cur = prev.siteByLocale?.[locale] || { version: 1 };
        const next = setLocalePath(cur, segs, value) as Override;
        const updated = { ...prev, siteByLocale: { ...prev.siteByLocale, [locale]: next } };
        localeOverridesRef.current = updated;
        setLocaleOverrides(updated);
        scheduleSave(`locale:site:${locale}`, next);
    }, [scheduleSave, aiRunningRef, localeOverridesRef, setLocaleOverrides]);

    // Replace a whole override in local state WITHOUT scheduling a save — used
    // after AI translate, which has already persisted server-side.
    const replacePageOverride = useCallback((pageId: string, locale: string, full: Override | null | undefined) => {
        const prev = localeOverridesRef.current;
        const updated = {
            ...prev,
            pagesByLocale: {
                ...prev.pagesByLocale,
                [pageId]: { ...(prev.pagesByLocale?.[pageId] || {}), [locale]: full as Override },
            },
        };
        localeOverridesRef.current = updated;
        setLocaleOverrides(updated);
    }, [localeOverridesRef, setLocaleOverrides]);
    const replaceSiteOverride = useCallback((locale: string, full: Override | null | undefined) => {
        const prev = localeOverridesRef.current;
        const updated = { ...prev, siteByLocale: { ...prev.siteByLocale, [locale]: full as Override } };
        localeOverridesRef.current = updated;
        setLocaleOverrides(updated);
    }, [localeOverridesRef, setLocaleOverrides]);

    // AI pre-fill: translate the active page ('page') or site chrome ('site')
    // to the active locale. The server preserves existing manual translations
    // and returns the merged override, which we fold into local state.
    const handleAiTranslate = useCallback(async (scope: string, tier: string = 'fast') => {
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
                : cmsApi.pageAiTranslate(siteId, (activePage as CmsActivePage).id, activeLocale);
            const res = await authFetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ modelTier: tier || 'fast' }),
            });
            const data = await res.json().catch(() => ({})) as AiTranslateResponse;
            if (!res.ok) throw new Error(data.error || `Translate failed (${res.status})`);
            if (scope === 'site') replaceSiteOverride(activeLocale, data.override);
            else replacePageOverride((activePage as CmsActivePage).id, activeLocale, data.override);
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
        const pageId = activePage.id;
        const prev = localeOverridesRef.current;
        const ov = prev.pagesByLocale?.[pageId]?.[activeLocale] as PageOverrideShape | undefined;
        if (ov?.blocks && Object.prototype.hasOwnProperty.call(ov.blocks, blockId)) {
            const nextBlocks: Record<string, unknown> = { ...ov.blocks };
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
    const handleResetTranslations = useCallback(async (scope: string) => {
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
                : cmsApi.pageLocaleOverride(siteId, (activePage as CmsActivePage).id, activeLocale);
            const res = await authFetch(url, { method: 'DELETE' });
            if (!res.ok) {
                const d = await res.json().catch(() => ({})) as { error?: string };
                throw new Error(d.error || `Reset failed (${res.status})`);
            }
            if (scope === 'site') replaceSiteOverride(activeLocale, null);
            else replacePageOverride((activePage as CmsActivePage).id, activeLocale, null);
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
