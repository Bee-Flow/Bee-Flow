import { useCallback, useMemo, useState } from 'react';
import { stepOutputIsArray } from '../flow/ribbon/fitsAfter';
import { itemForKey } from '../flow/stepPalette';
import { recordStep, readUsage, readTransitions, topFrequentKeys, scoreSuggestions } from '../flow/stepUsage';


export interface UseSmartAddStepOptions {
    palette: { open: boolean; edgeSource?: string | null };
    scopedDef: any;
    catalog: any;
    paletteLayers: any;
}

/**
 * Smart Add-step: the per-user frequency list and the context suggestions of
 * the positioned add menu. Split out of BuildTab without a change in behaviour.
 */
export default function useSmartAddStep({ palette, scopedDef, catalog, paletteLayers }: UseSmartAddStepOptions) {
    // ── Smart Add-step: per-user frequency + context-aware suggestions ────────
    // `usageTick` bumps after each add so the memos below re-read scopedStorage.
    const [usageTick, setUsageTick] = useState(0);
    const recordUsage = useCallback((payload: any, sourceStep?: any) => {
        recordStep(payload, sourceStep || null);
        setUsageTick(t => t + 1);
    }, []);
    // The user's recency-weighted favourites, resolved to render-ready items.
    const frequentItems = useMemo(
        () => topFrequentKeys(readUsage(), 8)
            .map(k => itemForKey(k, { catalog, layers: paletteLayers }))
            .filter(Boolean),
        // usageTick invalidates readUsage(), which reads scopedStorage
        [catalog, paletteLayers, usageTick],
    );
    // Context "Suggested next" for the edge-drop / node-"+" popover (it knows
    // the source step). Empty unless the popover is open.
    const suggestedItems = useMemo(() => {
        if (!palette.open) return [];
        const src = palette.edgeSource
            ? [scopedDef?.trigger, ...(scopedDef?.steps || [])].find(n => n?.id === palette.edgeSource)
            : null;
        const ranked = scoreSuggestions({
            sourceKind: src ? (src.kind || src.type) : null,
            sourceOutputIsArray: stepOutputIsArray(src, catalog),
            usage: readUsage(),
            transitions: readTransitions(),
            limit: 5,
        });
        const seen = new Set();
        return ranked
            .map(s => {
                const it = itemForKey(s.key, { catalog, layers: paletteLayers });
                return it ? { ...it, context: s.reason } : null;
            })
            .filter(it => it && !seen.has(it.key) && seen.add(it.key));
    // usageTick invalidates readUsage()/readTransitions(), which read scopedStorage
    }, [palette.open, palette.edgeSource, scopedDef, catalog, paletteLayers, usageTick]);

    return { usageTick, recordUsage, frequentItems, suggestedItems };
}
