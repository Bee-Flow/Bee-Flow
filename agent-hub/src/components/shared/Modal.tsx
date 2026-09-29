import React, { useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    DEFAULT_Z_INDEX, ParentDialog, closeDialog, openDialog, setDialogEscape, setDialogFloor, stackLevel, useDialogStack,
    type DialogEntry,
} from './dialogStack';

/**
 * Modal — accessible dialog with backdrop, focus trap, ESC-to-close, and
 * focus restoration on unmount.
 *
 * Replaces the ad-hoc inline "[showX, setShowX] + fixed div + click-outside"
 * patterns across the admin panels and chat pickers. Drive it with plain
 * open/close state from the caller:
 *
 *   const [open, setOpen] = useState(false);
 *   <Modal open={open} onClose={() => setOpen(false)} title="Edit">
 *     ...body
 *   </Modal>
 *
 * Three size presets cover the common cases; pass className to escape the
 * preset when you need a custom width.
 *
 * Open Modals form a stack (see dialogStack.ts): the one opened last renders
 * above the others, so a confirmation asked for by a dialog lands on top of
 * it whatever z-index that dialog needed, and Escape closes that one only.
 */

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'full' | 'auto';
export type ModalPlacement = 'center' | 'top' | 'left' | 'right' | 'bottom';
export type ModalVariant = 'panel' | 'bare';

export interface ModalProps {
    open: boolean;
    onClose: () => void;
    title?: React.ReactNode;
    description?: React.ReactNode;
    /** Optional element rendered in the header's right slot (e.g. close X). */
    headerActions?: React.ReactNode;
    /** Optional footer slot (typically action buttons). */
    footer?: React.ReactNode;
    size?: ModalSize;
    /**
     * Where the panel sits. 'center' (default) is the classic dialog — every
     * existing caller renders exactly as before. 'top' drops it a fifth of the
     * way down the viewport, where a command palette belongs; 'left'/'right'
     * make it a full-height panel against that edge (width still follows
     * `size`); 'bottom' makes it a sheet (the MobileNav drawer pattern,
     * formalised).
     */
    placement?: ModalPlacement;
    /**
     * 'panel' (default) draws the standard surface: border, background,
     * shadow, padded body. 'bare' draws none of it, for the dialogs whose
     * content IS the surface — an image lightbox, a full-bleed preview. They
     * come through here for the focus trap and the ESC key, not for the
     * chrome.
     */
    variant?: ModalVariant;
    /**
     * 'alertdialog' for the dialogs that interrupt with a consequence — a
     * delete confirmation, a save conflict. Assistive technology announces
     * those differently, and the hand-rolled overlays that already claimed
     * the role keep it here.
     */
    role?: 'dialog' | 'alertdialog';
    /**
     * Stacking level, as an inline style so it beats the default z-50 class
     * without depending on which Tailwind utility the stylesheet happens to
     * emit last. Needed where a dialog opens above app chrome that is itself
     * positioned high — the studio shells sit at z-[1000] and up. A floor, not
     * a fixed number: a dialog opened on top of a higher one goes above it.
     */
    zIndex?: number;
    /** Disables backdrop-click-to-close (use for destructive confirmations). */
    disableBackdropClose?: boolean;
    /**
     * Disables ESC-to-close, for a dialog that must be answered or is busy.
     * Only the top dialog hears Escape, so a nested one needs no help: while
     * this one is on top and holding Escape back, the ones below stay open.
     */
    disableEscapeClose?: boolean;
    /**
     * The element that gets the focus when the dialog opens, for a dialog
     * whose main field is not its first control (a search field below the
     * close button). Without it, a field inside with autoFocus keeps the
     * focus it took, and otherwise the first control gets it.
     */
    initialFocus?: React.RefObject<HTMLElement | null>;
    children?: React.ReactNode;
    /** Extra classes for the panel container. */
    className?: string;
    /** ID of the element that labels the dialog. Falls back to internal id. */
    labelledBy?: string;
    /** Accessible name for a dialog that shows no visible title. */
    label?: string;
    /** Forwarded to the panel, for tests and deep links that query it. */
    'data-testid'?: string;
}

const SIZE: Record<ModalSize, string> = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
    full: 'max-w-[95vw] max-h-[95vh]',
    // No width at all: the caller's className decides. Two max-w utilities on
    // one element is a coin toss decided by stylesheet order, so a caller with
    // its own width says so here instead of stacking a second one on top.
    auto: '',
};

// Overlay layout per placement. 'center' keeps its exact original classes
// (identity); the edge placements drop the p-4 so the panel touches its edge.
const OVERLAY: Record<ModalPlacement, string> = {
    center: 'fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4',
    top: 'fixed inset-0 z-50 flex items-start justify-center bg-black/60 backdrop-blur-sm p-4 pt-[15vh]',
    left: 'fixed inset-0 z-50 flex items-stretch justify-start bg-black/60 backdrop-blur-sm',
    right: 'fixed inset-0 z-50 flex items-stretch justify-end bg-black/60 backdrop-blur-sm',
    bottom: 'fixed inset-0 z-50 flex flex-col justify-end bg-black/60 backdrop-blur-sm',
};

// Panel shape per placement: corners rounded away from the attached edge, the
// slide-in classes live in index.css (and are zeroed under reduced motion).
const PANEL_SHAPE: Record<ModalPlacement, string> = {
    center: 'rounded-xl max-h-[90vh]',
    top: 'rounded-xl max-h-[70vh]',
    left: 'h-full max-h-full rounded-r-xl modal-slide-in-left',
    right: 'h-full max-h-full rounded-l-xl modal-slide-in-right',
    bottom: 'mx-auto rounded-t-2xl max-h-[85vh] modal-slide-in-up',
};

const PANEL_CHROME: Record<ModalVariant, string> = {
    panel: 'border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-2xl',
    bare: '',
};

const BODY_CHROME: Record<ModalVariant, string> = {
    panel: 'flex-1 overflow-y-auto px-5 py-4',
    bare: 'flex-1 min-h-0 flex flex-col',
};

const FOCUSABLE_SELECTOR =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * This dialog's place in the stack of open ones. Registered in a layout
 * effect, so the level is right before the browser paints. The stack listens
 * for Escape on the document, so the dialog closes whichever inner element
 * has focus, and only while it is the top one.
 */
function useStackEntry(open: boolean, zIndex: number | undefined, onEscape: (() => void) | null): DialogEntry {
    const parent = useContext(ParentDialog);
    const floor = zIndex ?? DEFAULT_Z_INDEX;
    const [entry] = useState<DialogEntry>(() => ({ parent, floor, onEscape: null }));
    useDialogStack(open);
    useLayoutEffect(() => { setDialogFloor(entry, floor); }, [entry, floor]);
    useLayoutEffect(() => { setDialogEscape(entry, onEscape); }, [entry, onEscape]);
    useLayoutEffect(() => {
        if (!open) return undefined;
        openDialog(entry);
        return () => closeDialog(entry);
    }, [open, entry]);
    return entry;
}

function focusedElement(): HTMLElement | null {
    return typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null);
}

/**
 * The element that had the focus when the dialog opened. Read while the
 * dialog renders open, before any child mounts: a child with autoFocus takes
 * the focus during the commit, ahead of every effect of the Modal, so an
 * effect would record that child (gone once the dialog closes) and the focus
 * would land on <body> instead of back on the opener.
 */
function useOpener(open: boolean): HTMLElement | null {
    const [opener, setOpener] = useState(() => (open ? focusedElement() : null));
    const [wasOpen, setWasOpen] = useState(open);
    if (open !== wasOpen) {
        setWasOpen(open);
        setOpener(open ? focusedElement() : null);
    }
    return opener;
}

/**
 * Where the focus goes on open: the element the caller named, else wherever
 * a child already put it (autoFocus, or a focus call in the child's own
 * effect, which runs before this one), else the first interactive element
 * (or the panel itself if there is none).
 */
function focusInitial(panel: HTMLElement, initialFocus: React.RefObject<HTMLElement | null> | undefined): void {
    const named = initialFocus?.current;
    if (named) {
        named.focus();
        return;
    }
    if (panel.contains(document.activeElement)) return;
    (panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? panel).focus();
}

/** Place the focus on open, and give it back to the opener on close. */
function useDialogFocus(
    open: boolean,
    panelRef: React.RefObject<HTMLDivElement | null>,
    initialFocus: React.RefObject<HTMLElement | null> | undefined,
): void {
    const opener = useOpener(open);
    useEffect(() => {
        if (!open) return undefined;
        if (panelRef.current) focusInitial(panelRef.current, initialFocus);
        return () => {
            opener?.focus?.();
        };
    }, [open, opener, panelRef, initialFocus]);
}

export default function Modal({
    open,
    onClose,
    title,
    description,
    headerActions,
    footer,
    size = 'md',
    placement = 'center',
    variant = 'panel',
    role = 'dialog',
    zIndex,
    disableBackdropClose = false,
    disableEscapeClose = false,
    initialFocus,
    children,
    className = '',
    labelledBy,
    label,
    'data-testid': testId,
}: ModalProps) {
    const panelRef = useRef<HTMLDivElement | null>(null);
    const internalLabelId = useId();
    const titleId = labelledBy ?? (title != null ? internalLabelId : undefined);
    const entry = useStackEntry(open, zIndex, disableEscapeClose ? null : onClose);
    useDialogFocus(open, panelRef, initialFocus);

    // Minimal focus trap: keep Tab/Shift+Tab inside the panel.
    const onPanelKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== 'Tab') return;
        const panel = panelRef.current;
        if (!panel) return;
        const items = panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
        if (items.length === 0) {
            e.preventDefault();
            return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && active === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && active === last) {
            e.preventDefault();
            first.focus();
        }
    }, []);

    if (!open) return null;
    if (typeof document === 'undefined') return null;

    const onBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (disableBackdropClose) return;
        // Only close on direct clicks of the backdrop itself.
        if (e.target === e.currentTarget) onClose();
    };

    // Inline only when it differs from the class, so a lone dialog that asked
    // for no level renders exactly as it always has.
    const level = stackLevel(entry);

    return createPortal(
        <ParentDialog.Provider value={entry}>
            <div
                role="presentation"
                onMouseDown={onBackdropClick}
                className={OVERLAY[placement] ?? OVERLAY.center}
                style={zIndex == null && level === DEFAULT_Z_INDEX ? undefined : { zIndex: level }}
            >
                <div
                    ref={panelRef}
                    role={role}
                    aria-modal="true"
                    aria-labelledby={titleId}
                    aria-label={titleId == null ? label : undefined}
                    data-testid={testId}
                    tabIndex={-1}
                    onKeyDown={onPanelKeyDown}
                    className={
                        `relative w-full ${SIZE[size]} ${PANEL_CHROME[variant]} outline-none ` +
                        `flex flex-col ${PANEL_SHAPE[placement] ?? PANEL_SHAPE.center} ` +
                        className
                    }
                >
                    {(title != null || description != null || headerActions != null) && (
                        <header className="flex items-start justify-between gap-3 px-5 py-4 border-b border-[var(--border-subtle)]">
                            <div className="min-w-0">
                                {title != null && (
                                    <h2 id={titleId} className="text-base font-semibold">{title}</h2>
                                )}
                                {description != null && (
                                    <p className="text-xs text-[var(--text-tertiary)] mt-0.5">{description}</p>
                                )}
                            </div>
                            {headerActions != null && (
                                <div className="flex-shrink-0">{headerActions}</div>
                            )}
                        </header>
                    )}
                    <div className={BODY_CHROME[variant]}>{children}</div>
                    {footer != null && (
                        <footer className="px-5 py-3 border-t border-[var(--border-subtle)] flex items-center justify-end gap-2">
                            {footer}
                        </footer>
                    )}
                </div>
            </div>
        </ParentDialog.Provider>,
        document.body,
    );
}
