import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { API_BASE, authFetch } from '../utils/helpers';
import { buildStampedCacheKey, ICONPACK_CACHE_PREFIX } from '../utils/storageMigrations';

/** One override: an emoji, or an image the icon API serves. */
export interface CustomIcon {
    type: 'emoji' | 'image';
    value: string;
}

/** Icon key → override, as one pack stores them. */
export type IconMap = Record<string, CustomIcon>;

export interface IconPackValue {
    getCustomIcon: (key: string) => CustomIcon | null;
    activePackId: string | null;
    setIconPack: (packId: string | null) => Promise<void>;
    isLoading: boolean;
    reload: () => void;
}

const IconPackContext = createContext<IconPackValue | null>(null);
// Build-stamped (`beeflow_iconpack_<packId>_<sha>`) for the same reason as the
// i18n catalogue cache: the stored timestamp was never checked, so a deploy
// kept rendering the old pack until the fetch landed — and forever when it
// didn't. Old builds' keys are swept by storageMigrations at app start.
const cacheKeyFor = (packId: string) => buildStampedCacheKey(ICONPACK_CACHE_PREFIX, packId);

// Guarded cache read: storage can be unavailable (private mode, blocked
// context) and a stored entry can be junk — apply only a plain-object icon
// map, JSON validity alone doesn't make it one. Returns null for "no usable
// cache", so the caller renders defaults until the fetch lands.
function readCachedPack(packId: string): IconMap | null {
    let raw = null;
    try { raw = localStorage.getItem(cacheKeyFor(packId)); } catch { /* storage unavailable */ }
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.data === 'object' && parsed.data !== null && !Array.isArray(parsed.data)) {
            return parsed.data;
        }
    } catch { /* corrupt entry — treat as absent */ }
    return null;
}

function writeCachedPack(packId: string, icons: IconMap): void {
    try {
        localStorage.setItem(cacheKeyFor(packId), JSON.stringify({
            data: icons,
            timestamp: Date.now(),
        }));
    } catch { /* quota / blocked — cache is best-effort */ }
}

export function IconPackProvider({ children }: { children: ReactNode }) {
    const [icons, setIcons] = useState<IconMap>({});
    const [activePackId, setActivePackId] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const loadedPackRef = useRef<string | null>(null);

    const loadIconPack = useCallback(async (packId: string | null) => {
        if (!packId) {
            setIcons({});
            loadedPackRef.current = null;
            return;
        }

        // Check the (build-stamped, shape-validated) cache first.
        const cached = readCachedPack(packId);
        if (cached) {
            setIcons(cached);
            loadedPackRef.current = packId;
        }

        setIsLoading(true);
        try {
            // First fetch user's active configurations
            const res = await authFetch(`${API_BASE}/api/icons`);
            if (res.ok) {
                const data = await res.json();
                const targetPack = data.packs.find((p: { id: string }) => p.id === packId);
                if (targetPack) {
                    setIcons(targetPack.icons || {});
                    loadedPackRef.current = packId;
                    writeCachedPack(packId, targetPack.icons);
                }
            }
        } catch (err) {
            console.warn('[IconPack] Failed to load icon pack:', err instanceof Error ? err.message : err);
        }
        setIsLoading(false);
    }, []);

    // Initial load to check which pack is active
    useEffect(() => {
        let mounted = true;
        const fetchInitial = async () => {
            try {
                const res = await authFetch(`${API_BASE}/api/icons`);
                if (res.ok && mounted) {
                    const data = await res.json();
                    if (data.activeIconPackId) {
                        setActivePackId(data.activeIconPackId);
                    }
                }
            } catch {
                // No pack list means the default icons, which is what renders
                // until one arrives — nothing to report.
            }
        };
        fetchInitial();
        return () => { mounted = false; };
    }, []);

    // Reload pack when activeId changes
    useEffect(() => {
        if (activePackId && activePackId !== loadedPackRef.current) {
            loadIconPack(activePackId);
        } else if (!activePackId) {
            setIcons({});
            loadedPackRef.current = null;
        }
    }, [activePackId, loadIconPack]);

    const setIconPack = useCallback(async (newPackId: string | null) => {
        try {
            const res = await authFetch(`${API_BASE}/api/icons/${newPackId || 'default'}/activate`, {
                method: 'POST'
            });
            if (res.ok) {
                setActivePackId(newPackId);
            }
        } catch (err) {
            console.error('[IconPack] Could not activate pack', err);
        }
    }, []);

    /** null means "use the default icon for this key". */
    const getCustomIcon = useCallback((key: string): CustomIcon | null => {
        const item = icons[key];
        if (!item) return null;
        return item;
    }, [icons]);

    const value: IconPackValue = {
        getCustomIcon,
        activePackId,
        setIconPack,
        isLoading,
        reload: () => { loadIconPack(activePackId); },
    };

    return (
        <IconPackContext.Provider value={value}>
            {children}
        </IconPackContext.Provider>
    );
}

export function useIconPack(): IconPackValue {
    const ctx = useContext(IconPackContext);
    if (!ctx) {
        return {
            getCustomIcon: () => null,
            activePackId: null,
            setIconPack: async () => {},
            isLoading: false,
            reload: () => {}
        };
    }
    return ctx;
}

export default useIconPack;
