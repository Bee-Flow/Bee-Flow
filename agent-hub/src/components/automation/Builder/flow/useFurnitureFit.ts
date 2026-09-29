import { useReactFlow, useStoreApi, type FitViewOptions } from '@xyflow/react';
import { useCallback, useMemo } from 'react';
import { furniturePadding } from './furnitureFit';

/**
 * The canvas's own fits, clear of its furniture (flow/furnitureFit.ts).
 *
 * The padding is worked out when React Flow actually fits, not when the fit
 * is asked for: `fitView()` only queues a fit for the next node update, and
 * the mount fit runs once the cards are measured, frames after the options
 * were handed over. So `padding` is a getter, read at that moment, against
 * the furniture and the node sizes as they are then.
 *
 * `fit(options)` is the Fit button and Arrange; `mountOptions` goes to
 * <ReactFlow fitViewOptions>, stable, so React Flow does not take a new
 * options object on every render.
 */
export function useFurnitureFit() {
    const rf = useReactFlow();
    const store = useStoreApi();
    const withFurniture = useCallback((options: FitViewOptions = {}): FitViewOptions => {
        const padding = () => {
            const s = store.getState();
            return furniturePadding({
                pane: s.domNode,
                width: s.width,
                height: s.height,
                nodes: s.nodeLookup.values(),
                minZoom: options.minZoom ?? s.minZoom,
                maxZoom: options.maxZoom ?? s.maxZoom,
            });
        };
        return Object.defineProperty({ ...options }, 'padding', { get: padding, enumerable: true });
    }, [store]);
    const mountOptions = useMemo(() => withFurniture({ duration: 0 }), [withFurniture]);
    const fit = useCallback((options?: FitViewOptions) => {
        try { void rf.fitView(withFurniture(options)); } catch { /* canvas gone */ }
    }, [rf, withFurniture]);
    return { fit, mountOptions };
}
