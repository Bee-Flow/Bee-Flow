/**
 * The few class recipes the Cowork home, its cards and its sheet share: pill buttons with a 44px target (one primary,
 * a quiet secondary, a link), a card surface and a section heading. Theme tokens only (./../shared/buttonClasses.ts
 * for the primary's fill and the focus ring), literal strings so Tailwind keeps them.
 */
import { FOCUS_RING, PRIMARY_TONE } from '../shared/buttonClasses';

const PILL = `inline-flex items-center justify-center gap-2 min-h-11 px-[18px] rounded-full text-[14px] font-semibold border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${FOCUS_RING}`;

/** The one primary action of a card or a form. */
export const PILL_PRIMARY = `${PILL} ${PRIMARY_TONE}`;

/** The secondary way out next to it. */
export const PILL_QUIET = `${PILL} bg-[var(--bg-card)] text-[var(--text-primary)] border-[var(--border-default)] enabled:hover:bg-[var(--bg-tertiary)] shadow-[var(--shadow-sm)]`;

/** A quiet text action ("Start from a template", "Show 3 more"). */
export const LINK_BUTTON = `inline-flex items-center gap-1.5 min-h-11 px-2 -ml-2 rounded-lg text-[14px] font-semibold text-[var(--text-primary)] underline-offset-4 hover:underline ${FOCUS_RING}`;

/** A raised surface: the composer, the confirmation, the lists. */
export const CARD = 'rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] shadow-[var(--shadow-card)]';

/** The small uppercase heading of a home section ("Needs you · 3", "Your tasks"). */
export const SECTION_HEADING = 'text-[13px] font-semibold uppercase tracking-[.06em] text-[var(--text-tertiary)]';

/** A field the confirmation card asks with (a day, a time). */
export const FIELD = 'min-h-11 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-primary)] px-2.5 text-[14px] font-semibold text-[var(--text-primary)] max-w-full';
