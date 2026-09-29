import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { NdvSide } from './ndvLayout';

type PointerHandler = (e: ReactPointerEvent<HTMLElement>) => void;

/**
 * One of the full drawer's side columns: Comes in (left) or Continues on
 * (right), at the width ndvLayout.ts gave it, with a drag handle on its
 * inner edge. A double click on the handle hands the width back to the
 * layout, which then grows the column with the drawer again.
 *
 * `@container/ndvside` lets what is inside adapt to the column, not the
 * window (Continues on hides its standing hint when it is narrow).
 */
export default function NdvSideColumn({
    side, width, onResizeDown, onResizeMove, onResizeUp, onReset, children,
}: {
    side: NdvSide;
    width: number;
    onResizeDown: PointerHandler;
    onResizeMove: PointerHandler;
    onResizeUp: PointerHandler;
    onReset: () => void;
    children: ReactNode;
}) {
    const { t } = useTranslation();
    const handle = (
        <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t('routines.ndv.resize_column', 'Resize column')}
            onPointerDown={onResizeDown}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            onDoubleClick={onReset}
            className={`absolute top-0 ${side === 'input' ? 'right-0' : 'left-0'} h-full w-1.5 cursor-col-resize z-10 hover:bg-[var(--bg-tertiary)] transition-colors`}
        />
    );
    return (
        <aside
            style={{ width }}
            className={`@container/ndvside relative flex-shrink-0 ${side === 'input' ? 'border-r' : 'border-l'} border-[var(--border-default)] bg-[var(--bg-secondary)] min-h-0 min-w-0 flex flex-col`}
        >
            {side === 'output' && handle}
            {children}
            {side === 'input' && handle}
        </aside>
    );
}
