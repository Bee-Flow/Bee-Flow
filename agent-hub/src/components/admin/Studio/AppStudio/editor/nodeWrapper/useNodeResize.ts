/**
 * ON-CANVAS RESIZE for the selected cell: a right-edge WIDTH grip (drags span
 * in 1–12 steps snapped to the section grid) and, for types whose spec
 * carries the `height` knob, a bottom-edge HEIGHT grip (snaps
 * auto→sm→md→lg). Both live-preview via LOCAL inline style only — no reducer
 * churn — and commit ONE history entry on pointer-up, so the draft-history
 * sees the pre-drag definition as current and records a single undoable step.
 *
 * The width grip works in the columns of the grid the cell sits in (12, or the grid's own
 * `columns`) and for the screen size the canvas switch is on (canvasBreakpoint): it reads and
 * writes `span` on Desktop, `spanMd` on Tablet and `spanSm` on Phone. On Tablet and Phone the
 * cell also shows the width it has at that size (`previewClass`), so what was dragged stays
 * visible after the pointer lets go.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent, RefObject } from 'react';
import { clampSpan } from './nodeWrapperModel';
import { previewSpanClass, useCellSpanView } from './spanView';
import type { AppDefinition } from '../../inspector/appDefinition';
import { resolveHeight, spanGridColumn } from '../../runtime/styleResolver';
import type { ParentGrid } from '../../runtime/styleResolver';
import { updateNodeStyle } from '../../state/definitionOps';
import { HEIGHT_STEPS, heightFromDrag as heightFromDragJs, measureGrid, spanFromDrag } from '../resize';

interface NodeResizeInputs {
    nodeId: string;
    nodeStyle: { span?: unknown; height?: unknown; [key: string]: unknown } | undefined;
    /** The node's type and the grid it sits in; without them the grip works on `span` in 12 columns. */
    nodeType?: string;
    parent?: ParentGrid | null;
    definition: AppDefinition | null;
    streamLock: boolean;
    cellRef: RefObject<HTMLDivElement | null>;
    onCommit?: (def: AppDefinition) => void;
}

type GripEvent = PointerEvent<HTMLDivElement>;

// resize.js defaults `stepPx`, which makes TypeScript read the options as that key alone.
const heightFromDrag = heightFromDragJs;

const release = (e: GripEvent) => e.currentTarget?.releasePointerCapture?.(e.pointerId);

export function useNodeResize({ nodeId, nodeStyle, nodeType, parent = null, definition, streamLock, cellRef, onCommit }: NodeResizeInputs) {
    // The width the cell has at the canvas switch's screen size, and the knob that holds it.
    const { spanKnob, columns, currentSpan, restClass } = useCellSpanView({ type: nodeType, style: nodeStyle }, parent);
    const currentHeight = HEIGHT_STEPS.includes(nodeStyle?.height as string) ? nodeStyle?.height as string : 'auto';

    // Live definition for the pointer-up commit (no reducer writes happen
    // during a drag, but read via ref so an unrelated re-render can't stale it).
    const definitionRef = useRef(definition);
    useEffect(() => { definitionRef.current = definition; });

    const widthDragRef = useRef<{ startSpan: number; startX: number; columnWidth: number; columns: number } | null>(null);
    const heightDragRef = useRef<{ startHeight: string; startY: number } | null>(null);
    const [widthPreview, setWidthPreview] = useState<number | null>(null);   // span while dragging, else null
    const [heightPreview, setHeightPreview] = useState<string | null>(null); // height step while dragging, else null

    const commitStyle = useCallback((patch: Record<string, unknown>) => {
        const next = updateNodeStyle(definitionRef.current, nodeId, patch);
        if (next !== definitionRef.current) onCommit?.(next);
    }, [nodeId, onCommit]);

    // WIDTH — right edge. One span step accounts for the grid's padding and
    // column-gap, so the handle tracks the pointer on padded sections too
    // (see resize.measureColumnWidth).
    const startWidthResize = useCallback((e: GripEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (streamLock) return;
        // The step comes from the grid as it is drawn (its real track count); the reach is the
        // grid's own column count. Below 640px the drawn grid has one track, and a reach of one
        // would turn a click on the grip into span 1.
        const measured = measureGrid(cellRef.current?.parentElement);
        widthDragRef.current = { startSpan: currentSpan, startX: e.clientX, columnWidth: measured.columnWidth, columns };
        setWidthPreview(currentSpan);
        e.currentTarget.setPointerCapture?.(e.pointerId);
    }, [streamLock, currentSpan, columns, cellRef]);

    const moveWidthResize = useCallback((e: GripEvent) => {
        const d = widthDragRef.current;
        if (!d) return;
        setWidthPreview(spanFromDrag({ startSpan: d.startSpan, dx: e.clientX - d.startX, columnWidth: d.columnWidth, columns: d.columns }));
    }, []);

    const endWidthResize = useCallback((e: GripEvent) => {
        const d = widthDragRef.current;
        widthDragRef.current = null;
        release(e);
        if (!d) return;
        const span = spanFromDrag({ startSpan: d.startSpan, dx: e.clientX - d.startX, columnWidth: d.columnWidth, columns: d.columns });
        setWidthPreview(null);
        if (span !== d.startSpan) commitStyle({ [spanKnob]: span });
    }, [commitStyle, spanKnob]);

    const cancelWidthResize = useCallback((e: GripEvent) => {
        widthDragRef.current = null;
        release(e);
        setWidthPreview(null);
    }, []);

    const onWidthKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        e.stopPropagation();
        const span = Math.min(columns, clampSpan(currentSpan + (e.key === 'ArrowRight' ? 1 : -1)));
        if (span !== currentSpan) commitStyle({ [spanKnob]: span });
    }, [currentSpan, columns, commitStyle, spanKnob]);

    // HEIGHT — bottom edge (height-capable types only). Snaps by dragged step.
    const startHeightResize = useCallback((e: GripEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (streamLock) return;
        heightDragRef.current = { startHeight: currentHeight, startY: e.clientY };
        setHeightPreview(currentHeight);
        e.currentTarget.setPointerCapture?.(e.pointerId);
    }, [streamLock, currentHeight]);

    const moveHeightResize = useCallback((e: GripEvent) => {
        const d = heightDragRef.current;
        if (!d) return;
        setHeightPreview(heightFromDrag({ startHeight: d.startHeight, dy: e.clientY - d.startY }));
    }, []);

    const endHeightResize = useCallback((e: GripEvent) => {
        const d = heightDragRef.current;
        heightDragRef.current = null;
        release(e);
        if (!d) return;
        const height = heightFromDrag({ startHeight: d.startHeight, dy: e.clientY - d.startY });
        setHeightPreview(null);
        if (height !== d.startHeight) commitStyle({ height });
    }, [commitStyle]);

    const cancelHeightResize = useCallback((e: GripEvent) => {
        heightDragRef.current = null;
        release(e);
        setHeightPreview(null);
    }, []);

    const onHeightKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        e.stopPropagation();
        const idx = Math.max(0, HEIGHT_STEPS.indexOf(currentHeight));
        const next = Math.max(0, Math.min(HEIGHT_STEPS.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)));
        const height = HEIGHT_STEPS[next];
        if (height !== currentHeight) commitStyle({ height });
    }, [currentHeight, commitStyle]);

    // Live-preview overrides — LOCAL only, so the reducer/history stay clean.
    const previewStyle: CSSProperties = {};
    if (widthPreview != null) previewStyle.gridColumn = spanGridColumn(widthPreview);
    if (heightPreview != null) previewStyle.height = resolveHeight(heightPreview) || 'auto';
    // The width as a CLASS too (editor.css, app-span-preview-N). The stylesheet places a cell
    // with !important wherever a grid has its own columns or a breakpoint span applies, and
    // an inline preview loses to that. While dragging it is the dragged width; on Tablet and
    // Phone it is the width the cell has at that size. On Desktop at rest there is none, so
    // the canvas is drawn by the runtime's own rules alone.
    return {
        currentSpan, currentHeight, widthPreview, heightPreview, previewStyle, columns,
        previewClass: widthPreview === null ? restClass : previewSpanClass(widthPreview),
        width: { onPointerDown: startWidthResize, onPointerMove: moveWidthResize, onPointerUp: endWidthResize, onPointerCancel: cancelWidthResize, onKeyDown: onWidthKeyDown },
        height: { onPointerDown: startHeightResize, onPointerMove: moveHeightResize, onPointerUp: endHeightResize, onPointerCancel: cancelHeightResize, onKeyDown: onHeightKeyDown },
    };
}

export type NodeResize = ReturnType<typeof useNodeResize>;
