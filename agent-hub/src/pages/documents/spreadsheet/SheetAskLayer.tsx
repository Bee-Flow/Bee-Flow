// Everything that floats over the selection for the inline "Ask AI": the round
// button, the box, and the shimmer on the selection while the assistant works.
// Positioned from CSS variables (useSelectionBox), so none of the ~1,300 cells
// re-renders for it.

import { Sparkles } from 'lucide-react';
import React, { useRef } from 'react';
import useTranslation from '../../../hooks/useTranslation';
import SheetAskBox from './SheetAskBox';
import type { SelectionKind } from './sheetModel';
import type { GridState } from './useGridState';
import useSelectionBox from './useSelectionBox';
import type { SheetAsk } from './useSheetAsk';

// Top-right corner of the selection; for whole columns / rows the header area.
const BUTTON_AT: Record<SelectionKind, string> = {
    cell: 'left-[calc(var(--sel-right)_-_12px)] top-[calc(var(--sel-top)_-_12px)]',
    range: 'left-[calc(var(--sel-right)_-_12px)] top-[calc(var(--sel-top)_-_12px)]',
    columns: 'left-[calc(var(--sel-right)_-_28px)] top-[3px]',
    rows: 'left-[37px] top-[calc(var(--sel-top)_+_3px)]',
};
// Where the ask box (and its result) opens.
const BOX_AT: Record<SelectionKind, string> = {
    // Just BELOW the selection, left-aligned with it, so what is asked about
    // stays in view; whole columns get it beside them, right of the last one.
    cell: 'left-[max(52px,var(--sel-left))] top-[calc(var(--sel-bottom)_+_6px)]',
    range: 'left-[max(52px,var(--sel-left))] top-[calc(var(--sel-bottom)_+_6px)]',
    columns: 'left-[calc(var(--sel-right)_+_8px)] top-[34px]',
    rows: 'left-[56px] top-[calc(var(--sel-bottom)_+_6px)]',
};

export interface SheetAskLayerProps {
    grid: GridState;
    ask: SheetAsk;
    /** The element the cells sit in (the layer is positioned inside it). */
    content: React.RefObject<HTMLElement | null>;
    /** The grid has focus: only then does the button show. */
    focused: boolean;
    readOnly: boolean;
}

export default function SheetAskLayer({ grid, ask, content, focused, readOnly }: SheetAskLayerProps) {
    const { t } = useTranslation();
    const layer = useRef<HTMLDivElement>(null);
    const open = ask.phase !== 'closed';
    const range = open && ask.snapshot ? ask.snapshot.range : grid.range;
    const kind = open && ask.snapshot ? ask.snapshot.kind : grid.kind;
    const showButton = !open && focused && !grid.editing;
    useSelectionBox(content, layer, range, open || showButton);
    return (
        <div ref={layer} className="absolute inset-0 z-[5] pointer-events-none" data-testid="sheet-ask-layer">
            {ask.phase === 'working' && (
                <div
                    data-testid="sheet-ask-shimmer" aria-hidden="true"
                    className="absolute left-[var(--sel-left)] top-[var(--sel-top)] w-[calc(var(--sel-right)_-_var(--sel-left))] h-[calc(var(--sel-bottom)_-_var(--sel-top))] rounded-sm border-2 border-[var(--accent-primary)] bg-[color-mix(in_srgb,var(--accent-primary)_10%,transparent)] animate-pulse"
                />
            )}
            {showButton && (
                <button
                    type="button" onMouseDown={(e) => e.preventDefault()} onClick={ask.open}
                    aria-label={t('spreadsheet.ask.button', 'Ask AI')} title={t('spreadsheet.ask.button', 'Ask AI')}
                    className={`absolute pointer-events-auto inline-flex items-center justify-center w-6 h-6 rounded-full border border-[color-mix(in_srgb,var(--accent-primary)_40%,transparent)] bg-[color-mix(in_srgb,var(--accent-primary)_16%,var(--bg-primary))] text-[var(--accent-primary)] shadow-sm hover:bg-[color-mix(in_srgb,var(--accent-primary)_28%,var(--bg-primary))] transition ${BUTTON_AT[kind]}`}
                >
                    <Sparkles size={12} aria-hidden="true" />
                </button>
            )}
            {open && <SheetAskBox ask={ask} readOnly={readOnly} position={BOX_AT[kind]} />}
        </div>
    );
}
