/**
 * The button styles of the fill-in form, in one place so its main action, its
 * other actions and the picker for where the document is kept look like one
 * set: the same height, corners and focus ring.
 */
const BUTTON = 'inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3.5 text-sm font-medium '
    + 'disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] focus-visible:ring-offset-1';

/** The one action that moves the form on. */
export const FILL_PRIMARY = `${BUTTON} bg-[var(--accent-primary)] text-[var(--accent-primary-fg,#fff)] hover:opacity-90`;
/** Everything else in the footer. */
export const FILL_SECONDARY = `${BUTTON} border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)]`;
/** A quiet text action. */
export const FILL_LINK = 'rounded px-1 text-xs font-medium text-[var(--text-secondary)] underline underline-offset-2 hover:text-[var(--text-primary)] '
    + 'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] disabled:opacity-50';
/** A small button inside a panel of the form (the folder picker, the request to a colleague). */
export const FILL_SMALL = 'rounded-md px-2.5 py-1 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] disabled:opacity-50';
