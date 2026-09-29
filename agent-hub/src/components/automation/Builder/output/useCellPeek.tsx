import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { prettyJson, scalarText } from './valueHelpers';

/**
 * Hover a cell, see what's in it.
 *
 * Columns are capped and cells clamp to one line, so the full value has to be
 * reachable without leaving the table, and a native `title` is the wrong tool:
 * it waits a second, collapses newlines, and renders JSON as one grey ribbon.
 * This is a real card, portalled to <body> so the panel's own `overflow: auto`
 * can't clip it, and delayed just long enough that sweeping the pointer across
 * a table doesn't strobe.
 *
 * Cells whose content already fits (short scalars) get no card.
 */
const PEEK_DELAY_MS = 260;
const PEEK_MIN_CHARS = 26;
const PEEK_MAX_CHARS = 1200;
const PEEK_W = 340;

interface PeekState { top: number; left: number; label: string; text: string; mono: boolean }

export interface CellPeek {
    open: (el: HTMLElement, value: unknown, label: string) => void;
    close: () => void;
    card: ReactNode;
}

export default function useCellPeek(): CellPeek {
    const [state, setState] = useState<PeekState | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const clearTimer = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };

    const close = useCallback(() => { clearTimer(); setState(null); }, []);

    const open = useCallback((el: HTMLElement, value: unknown, label: string) => {
        clearTimer();
        if (value === null || value === undefined || value === '') return;
        const mono = typeof value === 'object';
        const full = mono ? prettyJson(value) : scalarText(value);
        if (!mono && full.length < PEEK_MIN_CHARS) return;
        const rect = el.getBoundingClientRect();
        timer.current = setTimeout(() => {
            // Flip above / left when the card would fall off the viewport.
            const vw = window.innerWidth || 0;
            const vh = window.innerHeight || 0;
            const left = Math.max(8, Math.min(rect.left, vw - PEEK_W - 8));
            const below = rect.bottom + 6;
            const top = below + 180 > vh ? Math.max(8, rect.top - 186) : below;
            setState({
                top, left, label, mono,
                text: full.length > PEEK_MAX_CHARS ? `${full.slice(0, PEEK_MAX_CHARS)}…` : full,
            });
        }, PEEK_DELAY_MS);
    }, []);

    useEffect(() => clearTimer, []);

    const card = state && typeof document !== 'undefined'
        ? createPortal(
            <div
                role="tooltip"
                style={{ position: 'fixed', top: state.top, left: state.left, width: PEEK_W, zIndex: 2000 }}
                className="pointer-events-none rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] shadow-lg p-2"
            >
                <div className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)] mb-1">{state.label}</div>
                <div className={`max-h-40 overflow-hidden text-[11px] leading-snug text-[var(--text-primary)] whitespace-pre-wrap break-words ${state.mono ? 'font-mono' : ''}`}>
                    {state.text}
                </div>
            </div>,
            document.body,
        )
        : null;

    return { open, close, card };
}
