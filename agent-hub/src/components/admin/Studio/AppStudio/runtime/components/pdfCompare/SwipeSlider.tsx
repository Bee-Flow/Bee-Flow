import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { clampPercent } from './pdfCompareMath';

/** The draggable divider of swipe mode: a pointer-draggable and arrow-key accessible slider. */
export default function SwipeSlider({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
    const lineRef = useRef<HTMLDivElement>(null);
    const dragging = useRef(false);

    const fromPointer = (e: PointerEvent<HTMLDivElement>) => {
        const host = lineRef.current?.parentElement;
        if (!host) return;
        const rect = host.getBoundingClientRect();
        if (rect.width > 0) onChange(clampPercent(((e.clientX - rect.left) / rect.width) * 100));
    };
    const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
        const step = e.shiftKey ? 10 : 2;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); onChange(clampPercent(value - step)); }
        else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); onChange(clampPercent(value + step)); }
        else if (e.key === 'Home') { e.preventDefault(); onChange(0); }
        else if (e.key === 'End') { e.preventDefault(); onChange(100); }
    };
    const pos = { left: `${value}%` };
    return (
        <div
            ref={lineRef}
            role="slider"
            tabIndex={0}
            aria-label={label}
            aria-orientation="horizontal"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(value)}
            onKeyDown={onKey}
            onPointerDown={(e) => { dragging.current = true; e.currentTarget.setPointerCapture?.(e.pointerId); fromPointer(e); }}
            onPointerMove={(e) => { if (dragging.current) fromPointer(e); }}
            onPointerUp={() => { dragging.current = false; }}
            onPointerCancel={() => { dragging.current = false; }}
            className="group absolute bottom-0 top-0 z-10 -ml-3 flex w-6 cursor-ew-resize touch-none justify-center outline-none"
            style={pos}
            data-pdf-slider="true"
        >
            <div className="h-full w-0.5 bg-[var(--app-accent,#2563eb)] shadow group-focus-visible:w-1" />
            <div className="absolute top-1/2 h-8 w-4 -translate-y-1/2 rounded-full border-2 border-[var(--app-accent,#2563eb)] bg-white shadow" />
        </div>
    );
}
