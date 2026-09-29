import { useEffect, useRef, useState } from 'react';
import type { Dispatch, PointerEvent as ReactPointerEvent, SetStateAction } from 'react';
import scopedStorage from '../../../utils/scopedStorage';
import { COL_MAX, COL_MIN, INPUT_DEFAULT, OUTPUT_DEFAULT, type NdvNarrowSide, type NdvSide } from './ndv/ndvLayout';

/** What the step editor's chrome reads off this hook. */
export interface NdvPanels {
    inputOpen: boolean;
    setInputOpen: Dispatch<SetStateAction<boolean>>;
    outputOpen: boolean;
    setOutputOpen: Dispatch<SetStateAction<boolean>>;
    /** The narrow drawer's one side column (ndv/ndvLayout.ts). */
    narrowSide: NdvNarrowSide;
    setNarrowSide: Dispatch<SetStateAction<NdvNarrowSide>>;
    quickOutputOpen: boolean;
    setQuickOutputOpen: Dispatch<SetStateAction<boolean>>;
    inputW: number;
    outputW: number;
    /** True once the user dragged the column: the layout then keeps its width. */
    inputSized: boolean;
    outputSized: boolean;
    drawerH: number;
    onHResizeDown: (e: ReactPointerEvent<HTMLElement>) => void;
    onHResizeMove: (e: ReactPointerEvent<HTMLElement>) => void;
    onHResizeUp: (e: ReactPointerEvent<HTMLElement>) => void;
    /** `curW` is the width the column is drawn at now, which can be wider than the stored one. */
    onColResizeDown: (side: NdvSide, curW: number) => (e: ReactPointerEvent<HTMLElement>) => void;
    onColResizeMove: (e: ReactPointerEvent<HTMLElement>) => void;
    onColResizeUp: (e: ReactPointerEvent<HTMLElement>) => void;
    /** Back to the default width that follows the drawer (a double click on the handle). */
    resetColumn: (side: NdvSide) => void;
}

interface HeightDrag { startY: number; startH: number; }
interface ColumnDrag { side: NdvSide; startX: number; startW: number; }

const NARROW_SIDES: readonly NdvNarrowSide[] = ['input', 'output', 'none'];

/**
 * How big the drawer is and which of its columns are open — the only state in
 * the step editor that outlives the step being edited, so all of it is
 * persisted per user and none of it is derived from props.
 */
export default function useNdvPanels(): NdvPanels {
    // Collapsible Input / Output columns (persisted per-user).
    const [inputOpen, setInputOpen] = useState(() => scopedStorage.getItem('ndvInputOpen') !== '0');
    const [outputOpen, setOutputOpen] = useState(() => scopedStorage.getItem('ndvOutputOpen') !== '0');
    useEffect(() => { scopedStorage.setItem('ndvInputOpen', inputOpen ? '1' : '0'); }, [inputOpen]);
    useEffect(() => { scopedStorage.setItem('ndvOutputOpen', outputOpen ? '1' : '0'); }, [outputOpen]);
    // When only one side column fits, the one the user last asked for.
    // Comes in by default: the drawer is where a step gets its data mapped.
    const [narrowSide, setNarrowSide] = useState<NdvNarrowSide>(() => {
        const v = scopedStorage.getItem('ndvNarrowSide') as NdvNarrowSide | null;
        return v && NARROW_SIDES.includes(v) ? v : 'input';
    });
    useEffect(() => { scopedStorage.setItem('ndvNarrowSide', narrowSide); }, [narrowSide]);
    // The quick view's own output strip. Separate from the full view's column:
    // pressing Execute here used to produce nothing on screen at all — the
    // result landed in a column this dialog does not render — so the only way to
    // see what a step returned was to expand to the full view.
    const [quickOutputOpen, setQuickOutputOpen] = useState(() => scopedStorage.getItem('ndvQuickOutput') !== '0');
    useEffect(() => { scopedStorage.setItem('ndvQuickOutput', quickOutputOpen ? '1' : '0'); }, [quickOutputOpen]);

    // Resizable Input / Output column widths (persisted). Drag the inner edge
    // of either column to make it wider/narrower (Parameters takes the rest).
    const clampW = (v: string | null, d: number) => { const n = Number(v); return Number.isFinite(n) && n >= COL_MIN && n <= COL_MAX ? n : d; };
    // Wide enough for a field tree with a value column: 320 forced every row
    // to truncate to almost nothing (BFSF-329).
    // 400 | 460 are the round-4 defaults (artboard 4a); a width the user dragged is kept.
    const [inputW, setInputW] = useState(() => clampW(scopedStorage.getItem('ndvInputWidth'), INPUT_DEFAULT));
    const [outputW, setOutputW] = useState(() => clampW(scopedStorage.getItem('ndvOutputWidth'), OUTPUT_DEFAULT));
    useEffect(() => { scopedStorage.setItem('ndvInputWidth', String(inputW)); }, [inputW]);
    useEffect(() => { scopedStorage.setItem('ndvOutputWidth', String(outputW)); }, [outputW]);
    // An undragged column grows with a wide drawer (ndvLayout.ts); a dragged one stays put.
    const [inputSized, setInputSized] = useState(() => scopedStorage.getItem('ndvInputSized') === '1');
    const [outputSized, setOutputSized] = useState(() => scopedStorage.getItem('ndvOutputSized') === '1');
    useEffect(() => { scopedStorage.setItem('ndvInputSized', inputSized ? '1' : '0'); }, [inputSized]);
    useEffect(() => { scopedStorage.setItem('ndvOutputSized', outputSized ? '1' : '0'); }, [outputSized]);
    // The drawer's height at full density (design 1h). Persisted; the top
    // edge drags it. The quick drawer is a fixed 300px with Settings only.
    const H_MIN = 240;
    const H_MAX = 1200;
    const clampH = (v: string | null, d: number) => { const n = Number(v); return Number.isFinite(n) && n >= H_MIN && n <= H_MAX ? n : d; };
    const [drawerH, setDrawerH] = useState(() => clampH(scopedStorage.getItem('ndvDrawerHeight'), 520));
    useEffect(() => { scopedStorage.setItem('ndvDrawerHeight', String(drawerH)); }, [drawerH]);
    const hDragRef = useRef<HeightDrag | null>(null);
    const onHResizeDown = (e: ReactPointerEvent<HTMLElement>) => {
        // From the height on screen, not the stored one: the drawer is capped
        // to leave the canvas room, and a drag must move from where it is.
        const shown = e.currentTarget.parentElement?.getBoundingClientRect().height;
        hDragRef.current = { startY: e.clientY, startH: shown && shown > 0 ? shown : drawerH };
        e.currentTarget.setPointerCapture?.(e.pointerId);
        e.preventDefault();
    };
    const onHResizeMove = (e: ReactPointerEvent<HTMLElement>) => {
        const d = hDragRef.current;
        if (!d) return;
        // Dragging UP grows the drawer.
        setDrawerH(Math.min(H_MAX, Math.max(H_MIN, d.startH - (e.clientY - d.startY))));
    };
    const onHResizeUp = (e: ReactPointerEvent<HTMLElement>) => { if (hDragRef.current) { hDragRef.current = null; e.currentTarget.releasePointerCapture?.(e.pointerId); } };
    const dragRef = useRef<ColumnDrag | null>(null);
    const onColResizeDown = (side: NdvSide, curW: number) => (e: ReactPointerEvent<HTMLElement>) => {
        dragRef.current = { side, startX: e.clientX, startW: curW };
        e.currentTarget.setPointerCapture?.(e.pointerId);
        e.preventDefault();
    };
    const onColResizeMove = (e: ReactPointerEvent<HTMLElement>) => {
        const d = dragRef.current;
        if (!d) return;
        // Comes in's handle is on its right edge, Continues on's on its left.
        const sign = d.side === 'input' ? 1 : -1;
        const w = Math.min(COL_MAX, Math.max(COL_MIN, d.startW + (e.clientX - d.startX) * sign));
        if (d.side === 'input') { setInputW(w); setInputSized(true); } else { setOutputW(w); setOutputSized(true); }
    };
    const onColResizeUp = (e: ReactPointerEvent<HTMLElement>) => { if (dragRef.current) { dragRef.current = null; e.currentTarget.releasePointerCapture?.(e.pointerId); } };
    const resetColumn = (side: NdvSide) => {
        if (side === 'input') { setInputW(INPUT_DEFAULT); setInputSized(false); } else { setOutputW(OUTPUT_DEFAULT); setOutputSized(false); }
    };
    return {
        inputOpen, setInputOpen,
        outputOpen, setOutputOpen,
        narrowSide, setNarrowSide,
        quickOutputOpen, setQuickOutputOpen,
        inputW, outputW, inputSized, outputSized,
        drawerH,
        onHResizeDown, onHResizeMove, onHResizeUp,
        onColResizeDown, onColResizeMove, onColResizeUp, resetColumn,
    };
}
