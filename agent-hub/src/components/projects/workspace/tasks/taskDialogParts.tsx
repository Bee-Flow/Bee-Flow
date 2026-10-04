// The small building blocks of the task dialogs: a popover that behaves inside a
// modal, the section heading of the document column, and the class recipes of
// the property sidebar. Shared by TaskDialog, its sections and the meeting dialog.

import React, { useEffect, useLayoutEffect, useRef, type ComponentType } from 'react';
import AnchoredMenuJs from '../../../shared/AnchoredMenu';
import { MENU_ITEM_CLASS, MENU_PANEL_CLASS } from './tasksMenu';

// The menu is untyped JavaScript: props are passed by name, as its other users do.
const AnchoredMenu = AnchoredMenuJs as unknown as ComponentType<Record<string, unknown>>;

export const MENU_ITEM = MENU_ITEM_CLASS;
export const MENU_LABEL = 'px-2.5 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)]';
export const MENU_SEARCH = 'w-full h-8 px-2.5 mb-1 rounded-lg bg-[var(--bg-secondary)] text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] border-0 outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-default)]';

export const ICON_BUTTON = 'grid place-items-center w-7 h-7 rounded-md text-[var(--text-tertiary)] hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50 disabled:pointer-events-none';

/** A quiet in-content action (the GhostButton recipe) as a plain class, for triggers that need a ref. */
export const GHOST_ACTION = 'inline-flex items-center gap-1.5 h-7 px-1.5 rounded-lg text-[12px] text-[var(--text-tertiary)] '
    + 'hover:text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)] aria-expanded:bg-[var(--bg-secondary)] aria-expanded:text-[var(--text-primary)] '
    + 'transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

/** Row actions: shown on hover or focus, always on touch screens. */
export const REVEAL = 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity';

/** A property value: reads as text, shows it is a control on hover and focus. Native selects drop their chrome. */
export const PROPERTY_CONTROL = 'h-8 w-full min-w-0 px-2 rounded-md border-0 bg-transparent text-[13px] text-[var(--text-primary)] appearance-none cursor-pointer '
    + 'hover:bg-[var(--item-hover-bg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)] transition-colors '
    + 'disabled:cursor-default disabled:hover:bg-transparent [&>option]:bg-[var(--bg-card)] [&>option]:text-[var(--text-primary)]';

/** The same control, one step smaller, for the inline pickers of a list row. */
export const INLINE_CONTROL = 'h-7 min-w-0 px-1.5 rounded-md border-0 bg-transparent text-[12px] text-[var(--text-secondary)] appearance-none cursor-pointer '
    + 'hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)] transition-colors '
    + 'disabled:opacity-50 disabled:cursor-default disabled:hover:bg-transparent [&>option]:bg-[var(--bg-card)] [&>option]:text-[var(--text-primary)]';

/** The 11px group label of a section in the document column, with a count and an optional action on the right. */
export function SectionHeader({ title, count, action, id }: { title: React.ReactNode; count?: React.ReactNode; action?: React.ReactNode; id?: string }) {
    return (
        <div className="flex items-center gap-2 min-h-7">
            <h3 id={id} className="m-0 flex-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)]">
                {title}
                {count != null && count !== '' && <span className="ml-1.5 font-normal tabular-nums">{count}</span>}
            </h3>
            {action}
        </div>
    );
}

/** A textarea that grows with what is typed, so a title or description never scrolls inside itself. */
export function useAutoGrow(value: string) {
    const ref = useRef<HTMLTextAreaElement>(null);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight}px`;
    }, [value]);
    return ref;
}

const FOCUSABLE = 'input:not([disabled]), button:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A picker hanging off a trigger, rendered by the shared AnchoredMenu. Inside a
 * modal the portal needs two things the menu does not do for a picker: Escape
 * closes only the picker (not the dialog under it), and Tab stays in the picker
 * and hands focus back to the trigger at either end instead of leaving the page.
 */
export function Popover({ open, onClose, anchorRef, label, width = 256, align = 'left', children, testId }: {
    open: boolean;
    onClose: () => void;
    anchorRef: React.RefObject<HTMLElement | null>;
    label: string;
    width?: number;
    align?: 'left' | 'right';
    children: React.ReactNode;
    testId?: string;
}) {
    const inner = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return undefined;
        const id = requestAnimationFrame(() => inner.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus());
        return () => cancelAnimationFrame(id);
    }, [open]);
    const close = () => { onClose(); anchorRef.current?.focus(); };
    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            e.stopPropagation();
            e.preventDefault();
            close();
        } else if (e.key === 'Tab') {
            const items = Array.from(inner.current?.querySelectorAll<HTMLElement>(FOCUSABLE) || []);
            const first = items[0];
            const last = items[items.length - 1];
            if (!items.length || (e.shiftKey && document.activeElement === first) || (!e.shiftKey && document.activeElement === last)) {
                e.preventDefault();
                close();
            }
        }
    };
    return (
        <AnchoredMenu open={open} onClose={onClose} anchorRef={anchorRef} align={align} width={width} role="dialog" aria-label={label}
            closeOnEscape={false} className={MENU_PANEL_CLASS} data-testid={testId}>
            <div ref={inner} onKeyDown={onKeyDown}>{children}</div>
        </AnchoredMenu>
    );
}
