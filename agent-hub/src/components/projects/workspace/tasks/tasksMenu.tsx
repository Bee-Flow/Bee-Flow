// The small recipes every Tasks menu and toolbar shares: the quiet toolbar
// button, the menu panel and its items, labels and separators. One place, so
// the New menu, Filter, Sort and the card menus all look the same.

import { Check } from 'lucide-react';
import React from 'react';
import AnchoredMenuJs from '../../../shared/AnchoredMenu';

/** The props of the shared AnchoredMenu that Tasks uses (it is plain JavaScript, so TypeScript cannot read them). */
export interface TaskMenuProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'role'> {
    open: boolean;
    onClose: () => void;
    anchorRef: React.RefObject<HTMLElement | null>;
    align?: 'stretch' | 'left' | 'right';
    width?: number | null;
    minWidth?: number;
    maxHeight?: number | null;
    role?: string;
}

/** The shared AnchoredMenu, typed: portal, outside click, Escape and the arrow-key menu pattern. */
export const AnchoredMenu = AnchoredMenuJs as unknown as React.ComponentType<TaskMenuProps>;

/** Borderless toolbar button: quieter than a SecondaryButton, darker while its menu is open. */
export const TOOLBAR_BUTTON_CLASS =
    'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-[12.5px] whitespace-nowrap text-[var(--text-secondary)] transition-colors '
    + 'hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)] aria-expanded:bg-[var(--bg-secondary)] aria-expanded:text-[var(--text-primary)] '
    + 'disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]';

/** Square icon-only button (needs an aria-label and a title). */
export const ICON_BUTTON_CLASS =
    'grid place-items-center w-7 h-7 rounded-md text-[var(--text-tertiary)] transition-colors hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)] '
    + 'aria-expanded:bg-[var(--bg-secondary)] aria-expanded:text-[var(--text-primary)] disabled:opacity-50 disabled:cursor-not-allowed '
    + 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]';

/** Classes for an AnchoredMenu panel (they override its default rounded-md / bg-primary). */
export const MENU_PANEL_CLASS = '!rounded-xl !bg-[var(--bg-card)] p-1';

/** One menu row, for menus that render their own <button role="menuitem"> instead of MenuItem. */
export const MENU_ITEM_CLASS = 'w-full flex items-center gap-2 h-8 px-2.5 rounded-lg text-left text-[13px] text-[var(--text-primary)] transition-colors '
    + 'hover:bg-[var(--item-hover-bg)] focus-visible:bg-[var(--item-hover-bg)] focus-visible:outline-none disabled:opacity-50 disabled:cursor-not-allowed';

/** The accent count on a toolbar button (the number of active filters). */
export function CountBadge({ count }: { count: number }) {
    return (
        <span className="min-w-4 h-4 px-1 rounded-full bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] text-[10px] font-semibold leading-none grid place-items-center tabular-nums">
            {count}
        </span>
    );
}

export function MenuLabel({ children }: { children: React.ReactNode }) {
    return <div className="px-2.5 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)]" role="presentation">{children}</div>;
}

export function MenuSeparator() {
    return <div className="my-1 border-t border-[var(--border-subtle)]" role="separator" />;
}

type MenuItemProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'role'> & {
    icon?: React.ReactNode;
    /** Shows a trailing check and marks the item as the current choice. */
    selected?: boolean;
    danger?: boolean;
};

/** One row of a menu: optional leading icon, label, and a check for the current choice. */
export function MenuItem({ icon, selected, danger, className = '', children, ...rest }: MenuItemProps) {
    return (
        <button type="button" role="menuitem" aria-current={selected ? 'true' : undefined} {...rest}
            className={`${MENU_ITEM_CLASS} ${danger ? '!text-[var(--error-ink)]' : ''} ${className}`.trim()}>
            {icon && <span className="flex-none grid place-items-center w-4 text-[var(--text-tertiary)]" aria-hidden="true">{icon}</span>}
            <span className="flex-1 min-w-0 truncate">{children}</span>
            {selected && <Check className="w-3.5 h-3.5 flex-none text-[var(--text-primary)]" aria-hidden="true" />}
        </button>
    );
}
