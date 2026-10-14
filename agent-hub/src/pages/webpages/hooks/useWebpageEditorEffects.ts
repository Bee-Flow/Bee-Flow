import { useCallback, useEffect, useMemo, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { WebpagePatch, WebpageRow, WebpageSettings } from '../webpageEditorTypes';

type Flush = () => Promise<unknown>;

/** Let the shell flush the OUTGOING page before it unmounts this editor. */
export function useFlushRegistration(flushRef: RefObject<Flush | null> | undefined, flushNow: Flush) {
    useEffect(() => {
        if (!flushRef) return undefined;
        flushRef.current = flushNow;
        return () => { if (flushRef.current === flushNow) flushRef.current = null; };
    }, [flushRef, flushNow]);
}

/**
 * Cmd/Ctrl+S → flush. Only intercept the browser's native save when the user
 * is actually inside the IDE pane (Monaco editor, chat input, etc.). Outside
 * the IDE the keypress falls through to the browser so the user gets the
 * expected "Save page as…" dialog. Returns the ref for the pane.
 */
export function useSaveShortcut(flushNow: Flush) {
    const idePaneRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (!((e.metaKey || e.ctrlKey) && e.key === 's')) return;
            const pane = idePaneRef.current;
            if (!pane) return;
            const active = document.activeElement;
            if (!active || !pane.contains(active)) return;
            e.preventDefault();
            flushNow();
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [flushNow]);
    return idePaneRef;
}

/**
 * Live framework/runtime switches from the AI (emitted as SSE → DOM events by
 * useChatEngine). Update the page's settings so the preview recomposes into
 * the new mode (e.g. vanilla → react-mui) without a reload.
 */
export function useSettingsSwitchEvents(
    pageId: string,
    page: WebpageRow,
    setPage: Dispatch<SetStateAction<WebpageRow>>,
    onMetaChange?: (id: string, patch: WebpagePatch) => void,
) {
    const pageRef = useRef(page);
    useEffect(() => { pageRef.current = page; }, [page]);
    const patchSettings = useCallback((patch: WebpageSettings) => {
        const settings = { ...(pageRef.current?.settings || {}), ...patch };
        setPage(prev => ({ ...prev, settings }));
        onMetaChange?.(pageId, { settings });
    }, [onMetaChange, pageId, setPage]);
    useEffect(() => {
        const onFramework = (e: Event) => {
            const framework = (e as CustomEvent<{ framework?: string }>)?.detail?.framework;
            if (framework) patchSettings({ framework });
        };
        const onRuntime = (e: Event) => {
            const runtime = (e as CustomEvent<{ runtime?: string }>)?.detail?.runtime;
            if (runtime) patchSettings({ runtime });
        };
        window.addEventListener('webpage_framework_changed', onFramework);
        window.addEventListener('webpage_runtime_changed', onRuntime);
        return () => {
            window.removeEventListener('webpage_framework_changed', onFramework);
            window.removeEventListener('webpage_runtime_changed', onRuntime);
        };
    }, [patchSettings]);
}

/**
 * What the header's badges may claim. Both counts come from data already
 * loaded, so neither costs a request — and both are `undefined` (not 0) until
 * they are really known, because the badge slot renders nothing for
 * undefined and a "0" would be a claim. "Used by" has no source at all and
 * stays absent on purpose.
 */
export function useHeaderCounts(page: WebpageRow, sources: unknown[], versionCount: number | null) {
    const dataCount = useMemo(() => {
        const grants = page?.bridgeGrants || {};
        const n = (Array.isArray(grants.automations) ? grants.automations.length : 0)
            + (Array.isArray(grants.integrations) ? grants.integrations.length : 0)
            + (Array.isArray(sources) ? sources.length : 0);
        return n > 0 ? n : undefined;
    }, [page?.bridgeGrants, sources]);
    return useMemo(() => ({
        data: dataCount,
        // Only after the list has actually been fetched — before that we do
        // not know whether there are none or none-loaded.
        history: versionCount === null ? undefined : (versionCount || undefined),
        usedBy: undefined,
    }), [dataCount, versionCount]);
}
