import { useCallback, useMemo, useState } from 'react';
import type { MouseEvent, RefObject } from 'react';
import { DRAG_THRESHOLD } from './sitemapGraph';
import type { Point } from './sitemapGraph';

interface DragCandidate {
    id: string;
    startMouseX: number;
    startMouseY: number;
    offsetX: number;
    offsetY: number;
}

interface ActiveDrag {
    id: string;
    offsetX: number;
    offsetY: number;
}

/** Mouse position in canvas coordinates (scroll included). */
function canvasPoint(container: HTMLElement, e: MouseEvent): Point {
    const rect = container.getBoundingClientRect();
    return {
        x: e.clientX - rect.left + container.scrollLeft,
        y: e.clientY - rect.top  + container.scrollTop,
    };
}

/**
 * Card dragging. Mousedown captures the candidate node + offset; drag mode
 * starts only once the mouse moves past DRAG_THRESHOLD pixels. This lets
 * click handlers on the gear icon fire cleanly without ever triggering a
 * "click after drag" miss.
 *
 * `overrides` are the manual positions; they survive a Refresh so the user's
 * tidying isn't lost when the layout recomputes, and Reset layout clears them.
 */
export default function useSitemapDrag(containerRef: RefObject<HTMLDivElement | null>, layoutPositions: Map<string, Point> | null) {
    const [overrides, setOverrides] = useState<Record<string, Point>>({});
    const [candidate, setCandidate] = useState<DragCandidate | null>(null);
    const [dragging,  setDragging]  = useState<ActiveDrag | null>(null);

    // Positions: layout-computed unless the user has dragged the node.
    const positions = useMemo(() => {
        const out = new Map<string, Point>();
        if (!layoutPositions) return out;
        for (const [id, pos] of layoutPositions) {
            out.set(id, overrides[id] || pos);
        }
        return out;
    }, [layoutPositions, overrides]);

    const handleNodeMouseDown = useCallback((e: MouseEvent, nodeId: string) => {
        if (!containerRef.current) return;
        const mouse = canvasPoint(containerRef.current, e);
        const pos = positions.get(nodeId);
        if (!pos) return;
        setCandidate({
            id: nodeId,
            startMouseX: mouse.x,
            startMouseY: mouse.y,
            offsetX: mouse.x - pos.x,
            offsetY: mouse.y - pos.y,
        });
    }, [positions]);

    const handleMouseMove = useCallback((e: MouseEvent) => {
        if (!candidate && !dragging) return;
        if (!containerRef.current) return;
        const mouse = canvasPoint(containerRef.current, e);

        if (candidate && !dragging) {
            const dx = mouse.x - candidate.startMouseX;
            const dy = mouse.y - candidate.startMouseY;
            if (Math.hypot(dx, dy) > DRAG_THRESHOLD) {
                setDragging({
                    id: candidate.id,
                    offsetX: candidate.offsetX,
                    offsetY: candidate.offsetY,
                });
            }
        }
        if (dragging) {
            setOverrides(prev => ({
                ...prev,
                [dragging.id]: {
                    x: Math.max(0, mouse.x - dragging.offsetX),
                    y: Math.max(0, mouse.y - dragging.offsetY),
                },
            }));
        }
    }, [candidate, dragging]);

    const handleMouseUp = useCallback(() => {
        setCandidate(null);
        setDragging(null);
    }, []);

    const resetLayout = useCallback(() => { setOverrides({}); }, []);

    return { positions, overrides, handleNodeMouseDown, handleMouseMove, handleMouseUp, resetLayout };
}
