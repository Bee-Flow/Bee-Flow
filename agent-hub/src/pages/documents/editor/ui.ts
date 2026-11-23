// Class names shared by the two document editors' chrome, on the Studio theme
// tokens (no inline style objects, no fixed colours).

export const TOOL_BUTTON = 'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium shrink-0 bg-[var(--bg-tertiary)] text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)] disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]';
// A tool that is switched off: quiet, outlined. Its own string, not TOOL_BUTTON plus overrides: two colour
// utilities on one element are ordered by Tailwind, not by the class list.
export const TOOL_BUTTON_OFF = 'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium shrink-0 bg-transparent border border-[var(--border-subtle)] text-[var(--text-tertiary)] hover:bg-[var(--item-hover-bg)] disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]';
export const TOOL_BUTTON_ACTIVE = 'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium shrink-0 bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]';
export const PRIMARY_BUTTON = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold shrink-0 bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent-primary)]';
export const ICON_BUTTON = 'p-1.5 rounded-lg shrink-0 text-[var(--text-tertiary)] hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)] disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]';
export const NOTICE = 'flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-xs shrink-0 border-b border-[var(--border-subtle)] text-[var(--text-primary)]';
export const LINK_BUTTON = 'underline shrink-0 hover:text-[var(--accent-primary)]';

/** Initials for an avatar: first and last word. */
export function initials(name: string | undefined): string {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] || '' : '')).toUpperCase();
}

/**
 * Where a side panel (history, comments, outline, the workspace tabs) sits. `beside`: next to the document.
 * `over`: over the document, from the right (the editor beside a chat is too narrow to share). `over-narrow`:
 * beside it, and over it below `sm`. The two overlay forms need a `relative` parent.
 */
export type PanelPlacement = 'beside' | 'over' | 'over-narrow';
const PANEL_EDGE = 'min-h-0 border-l border-[var(--border-subtle)]';
/** The frame of a side panel. */
export function panelFrame(placement: PanelPlacement): string {
    if (placement === 'over') return `${PANEL_EDGE} absolute inset-y-0 right-0 z-20 w-full max-w-80 bg-[var(--bg-primary)] shadow-xl`;
    if (placement === 'over-narrow') return `${PANEL_EDGE} max-sm:absolute max-sm:inset-0 max-sm:z-20 max-sm:w-full max-sm:bg-[var(--bg-primary)] w-80 max-w-full shrink-0`;
    return `${PANEL_EDGE} w-80 max-w-full shrink-0`;
}
