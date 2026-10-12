import { useCallback, useState } from 'react';
import scopedStorage from '../../../../utils/scopedStorage';

/**
 * Whether the canvas legend (north-east) is open.
 *
 * Someone who opened or closed it has said what they want, and that holds on
 * every canvas from then on. Until they do, the canvas decides by its own
 * size: on a laptop the 232px card sits over the last card of the first row,
 * and above an open step drawer it fills half of what is left of the canvas,
 * so there it starts closed and the "?" beside the lines lens opens it. From
 * LEGEND_ROOM_PX wide and LEGEND_ROOM_HEIGHT_PX tall it starts open, and the
 * fit keeps the cards clear of it (flow/furnitureFit.ts). A size of 0 is a
 * pane not measured yet: closed, so a laptop never sees it flash open.
 */
export const LEGEND_ROOM_PX = 1500;
export const LEGEND_ROOM_HEIGHT_PX = 600;

const CHOICE_KEY = 'automationsLegendChoice';
// The old key was written on every visit under an always-open default, so its
// '1' says nothing; only a '0' is someone closing it.
const LEGACY_KEY = 'automationsLegendOpen';

function readChoice(): boolean | null {
    try {
        const v = scopedStorage.getItem(CHOICE_KEY);
        if (v === 'open') return true;
        if (v === 'closed') return false;
        return scopedStorage.getItem(LEGACY_KEY) === '0' ? false : null;
    } catch {
        return null;
    }
}

export function useLegendPreference(paneWidth: number, paneHeight: number): [boolean, () => void] {
    const [choice, setChoice] = useState<boolean | null>(readChoice);
    const open = choice ?? (paneWidth >= LEGEND_ROOM_PX && paneHeight >= LEGEND_ROOM_HEIGHT_PX);
    const toggle = useCallback(() => {
        const next = !open;
        setChoice(next);
        try { scopedStorage.setItem(CHOICE_KEY, next ? 'open' : 'closed'); } catch { /* storage unavailable */ }
    }, [open]);
    return [open, toggle];
}
