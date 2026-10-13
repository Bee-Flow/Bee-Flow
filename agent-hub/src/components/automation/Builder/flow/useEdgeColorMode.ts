import { useCallback, useState } from 'react';
import scopedStorage from '../../../../utils/scopedStorage';

export type EdgeColorMode = 'branches' | 'off' | 'pii';

/**
 * "Colour lines by" — a per-user presentational lens (never part of the
 * definition: it would pollute version diffs for zero shared value).
 * 'branches' by default: automatic case colours only touch case edges,
 * and manual colours render in every mode.
 */
export function useEdgeColorMode(): [EdgeColorMode, (mode: EdgeColorMode) => void] {
    const [edgeColorMode, setEdgeColorModeState] = useState<EdgeColorMode>(
        () => {
            const v = scopedStorage.getItem('builderEdgeColorMode');
            return v === 'off' || v === 'pii' ? v : 'branches';
        },
    );
    const setEdgeColorMode = useCallback((mode: EdgeColorMode) => {
        setEdgeColorModeState(mode);
        scopedStorage.setItem('builderEdgeColorMode', mode);
    }, []);
    return [edgeColorMode, setEdgeColorMode];
}
