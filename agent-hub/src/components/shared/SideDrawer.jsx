import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import Modal from './Modal';
import useTranslation from '../../hooks/useTranslation';

/**
 * SideDrawer — the 380px right-hand editing lade of the register pages
 * (Compliance artboards 1c DSR and 1d SoA; later Risks, Incidents, Audits).
 *
 * It is a CARD, not a modal. `Modal placement="right"` portals, traps focus
 * and dims the page — right for a confirmation, wrong for a panel you keep
 * open while you read the table beside it. pages/notebooks/shell/Drawer.jsx
 * has the right behaviour (push, no scrim, no trap) but paints a flat
 * `--bg-secondary` panel with no header or footer slot, so this is the
 * Studio-shaped sibling: rounded-xl, hairline border, popover shadow, a
 * header row with an X, a scrolling body, a footer that sinks to the bottom.
 *
 * Three modes, chosen by the HOST (it knows its own width):
 *   inline   the card fills the second column of the host's
 *            `grid-template-columns: 1fr 380px`; nothing else moves;
 *   overlay  the same card floats `absolute inset-y-3 right-3` over the
 *            page behind a light click-to-close scrim — for pages narrower
 *            than 1180px where a second column would crush the table.
 *   modal    the phone (artboard 1h): a real right-side `Modal` — portalled,
 *            full-height, sliding in from the right edge. On a 390px frame
 *            there is no table left to keep reachable, and a 380px card
 *            pinned `right-3` would overhang the viewport, so the drawer
 *            stops being a card and becomes a dialog. This is exactly what
 *            DSR already does (`pages/dsr/DsrDrawer.jsx`); every register
 *            now reaches it through `mode="modal"`. `width` is ignored here
 *            — the panel follows the Modal's `md` preset and the viewport.
 *
 * Keyboard: Escape closes while open (a window listener, so it works from
 * any field inside). In `inline`/`overlay` there is deliberately NO focus
 * trap and no aria-modal — the table beside the drawer stays reachable.
 * Focus does move INTO the drawer (its header) when it opens, so a screen
 * reader hears the title, and goes back to whatever had it (the row that
 * opened the drawer) when it closes. In `modal` the Modal owns both (trap +
 * Escape + focus restore), so this file's own focus move stands down; its
 * Escape listener is harmless because Modal's document-level handler stops
 * the event before it reaches the window.
 *
 * Also exported: `DrawerSection` (the 10px uppercase label + content stack
 * that appears seven times across the two artboard drawers — "Betrokkene",
 * "Tijdlijn", "Besluit", "Motivatie · verplicht bij Uitgesloten") and
 * `DrawerId` (the mono 11px id in the header: "#2038", "A.5.20").
 */
export default function SideDrawer({
    open = false,
    onClose,
    width = 380,
    header = null,
    footer = null,
    children = null,
    ariaLabel = undefined,
    mode = 'inline',
    className = '',
    testId = undefined,
}) {
    const { t } = useTranslation();
    const headerRef = useRef(null);
    const returnFocusRef = useRef(null);

    // Escape closes — while open, from anywhere on the page.
    useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => {
            if (e.key === 'Escape' && !e.defaultPrevented) onClose?.();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    // Focus in on open, back out on close. The element that had focus is
    // remembered at open time (the row that was clicked / Enter-ed) and gets
    // it back when the drawer goes — if it is still on the page. In `modal`
    // the Modal does this itself; two owners would fight over it.
    useEffect(() => {
        if (!open || mode === 'modal') return undefined;
        const active = document.activeElement;
        returnFocusRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
        headerRef.current?.focus?.({ preventScroll: true });
        return () => {
            const back = returnFocusRef.current;
            returnFocusRef.current = null;
            if (back && back.isConnected && typeof back.focus === 'function') back.focus({ preventScroll: true });
        };
    }, [open, mode]);

    if (!open) return null;

    const closeButton = (
        <button
            type="button"
            onClick={() => onClose?.()}
            aria-label={t('common.close', 'Close')}
            data-testid={testId ? `${testId}-close` : undefined}
            className="grid place-items-center w-7 h-7 -mr-1.5 rounded-md flex-shrink-0 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
        >
            <X size={14} aria-hidden="true" />
        </button>
    );

    const footerBlock = footer ? (
        <div className="mt-auto flex flex-col gap-1.5 pt-1" data-testid={testId ? `${testId}-footer` : undefined}>
            {footer}
        </div>
    ) : null;

    // Phone (1h): the drawer is a right-side dialog, not a card beside a table.
    if (mode === 'modal') {
        return (
            <Modal
                open
                onClose={() => onClose?.()}
                placement="right"
                size="md"
                title={<span data-testid={testId ? `${testId}-header` : undefined} className="flex items-center gap-2 min-w-0">{header}</span>}
                headerActions={closeButton}
            >
                <div
                    aria-label={ariaLabel}
                    data-testid={testId}
                    data-mode="modal"
                    className={`flex flex-col gap-3.5 min-h-full ${className}`.trim()}
                >
                    {children}
                    {footerBlock}
                </div>
            </Modal>
        );
    }

    const overlay = mode === 'overlay';
    const card = (
        <section
            role="complementary"
            aria-label={ariaLabel}
            data-testid={testId}
            data-mode={overlay ? 'overlay' : 'inline'}
            className={[
                'rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] flex flex-col min-h-0 overflow-hidden',
                overlay ? 'absolute inset-y-3 right-3 z-30' : 'h-full max-w-full',
                className,
            ].join(' ').trim()}
            style={{ boxShadow: 'var(--shadow-popover)', width }}
        >
            <div
                ref={headerRef}
                tabIndex={-1}
                data-testid={testId ? `${testId}-header` : undefined}
                className="flex items-center gap-2 px-3.5 py-3 border-b border-[var(--border-default)] flex-shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent-primary)]"
            >
                <div className="flex-1 min-w-0 flex items-center gap-2">{header}</div>
                {closeButton}
            </div>
            <div className="p-3.5 flex-1 min-h-0 overflow-y-auto flex flex-col gap-3.5">
                {children}
                {footerBlock}
            </div>
        </section>
    );

    if (!overlay) return card;
    return (
        <>
            <div
                className="absolute inset-0 z-20"
                style={{ background: 'rgba(0,0,0,.25)' }}
                onClick={() => onClose?.()}
                aria-hidden="true"
                data-testid={testId ? `${testId}-scrim` : undefined}
            />
            {card}
        </>
    );
}

/**
 * A labelled block inside the drawer: 10px uppercase tracking-[.08em] label,
 * an optional quieter hint after it ("· required when excluded"), then the
 * content stacked below.
 */
export function DrawerSection({ label = null, hint = null, children = null, className = '', testId = undefined }) {
    return (
        <div className={`flex flex-col gap-1.5 ${className}`.trim()} data-testid={testId}>
            {(label || hint) && (
                <div className="text-[10px] uppercase tracking-[.08em] font-semibold text-[var(--text-tertiary)]">
                    {label}
                    {hint && <span className="font-normal normal-case tracking-normal"> · {hint}</span>}
                </div>
            )}
            {children}
        </div>
    );
}

/** The mono 11px identifier that leads a drawer header: "#2038", "A.5.20". */
export function DrawerId({ children, className = '', testId = undefined }) {
    return (
        <span className={`font-mono text-[11px] text-[var(--text-secondary)] flex-shrink-0 ${className}`.trim()} data-testid={testId}>
            {children}
        </span>
    );
}
