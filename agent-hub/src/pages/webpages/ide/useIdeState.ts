import { useCallback, useEffect, useRef, useState } from 'react';
import scopedStorage from '@/utils/scopedStorage';
import type { FileKey } from './ideFiles';
import { logger } from '@/utils/logger';

// Below this container width the 3-pane layout is too cramped, so the chat
// collapses to a top-bar toggle and the preview takes the full width.
const NARROW_BREAKPOINT = 720;

/**
 * No-code-by-default: the simplified surface (preview + chat + upload) is the
 * default; the "</> Code" toggle reveals the full IDE (explorer, editor, tabs,
 * status bar). Persisted per user. Controlled when the caller supplies
 * `devModeProp`, uncontrolled otherwise.
 */
export function useDevMode(devModeProp: boolean | undefined, onDevModeChange?: (next: boolean) => void) {
    const [ownDevMode, setOwnDevMode] = useState(() => {
        // scopedStorage returns null when no user is active yet or storage is
        // unavailable (private browsing) — default to the simplified surface.
        try { return scopedStorage.getItem('webpages_dev_mode') === 'true'; } catch { return false; }
    });
    const controlled = devModeProp !== undefined;
    const devMode = controlled ? !!devModeProp : ownDevMode;
    const toggleDevMode = () => {
        const next = !devMode;
        // The preference is remembered either way: whichever surface the user
        // last chose is the one that opens next time.
        try { scopedStorage.setItem('webpages_dev_mode', String(next)); } catch (err) { logger.debug('storage unavailable', err); }
        if (controlled) { onDevModeChange?.(next); return; }
        setOwnDevMode(next);
    };
    return { devMode, toggleDevMode };
}

/**
 * Open editor tabs (keys: 'html'|'css'|'js'|'extra:<path>') + the active key.
 * Honours a focus request from outside (the chat's "Change in code" chip).
 */
export function useOpenFiles(focusFile: { key?: string; at?: number } | null | undefined) {
    const [openFiles, setOpenFiles] = useState<FileKey[]>([]);
    const [activeKey, setActiveKey] = useState<FileKey | null>(null);

    const openFile = useCallback((key: FileKey) => {
        setOpenFiles(prev => prev.includes(key) ? prev : [...prev, key]);
        setActiveKey(key);
    }, []);

    useEffect(() => {
        if (!focusFile || !focusFile.key) return;
        openFile(focusFile.key);
    }, [focusFile, openFile]);

    const closeFile = useCallback((key: FileKey) => {
        setOpenFiles(prev => {
            const next = prev.filter(k => k !== key);
            if (activeKey === key) {
                setActiveKey(next.length > 0 ? next[next.length - 1] : null);
            }
            return next;
        });
    }, [activeKey]);

    return { openFiles, activeKey, setActiveKey, openFile, closeFile };
}

/**
 * Responsive chat: auto-collapse the chat panel on a narrow container so the
 * preview stays usable; a top-bar toggle lets the user reopen it. Only
 * crossing the breakpoint auto-collapses/expands, so a manual choice sticks
 * until the next crossing. Returns the ref for the observed root.
 */
export function useResponsiveChat() {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const [chatOpen, setChatOpen] = useState(true);
    const wasNarrowRef = useRef(false);
    useEffect(() => {
        const el = rootRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver((entries) => {
            const w = entries[0]?.contentRect?.width || 0;
            const narrow = w > 0 && w < NARROW_BREAKPOINT;
            if (narrow !== wasNarrowRef.current) {
                wasNarrowRef.current = narrow;
                setChatOpen(!narrow);
            }
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    return { rootRef, chatOpen, setChatOpen };
}
