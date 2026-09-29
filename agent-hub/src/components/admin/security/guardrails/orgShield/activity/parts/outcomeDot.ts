/**
 * The small square that names an outcome's colour in a legend, a tooltip or
 * a log row.
 *
 * "No personal data" is drawn in the quietest neutral of the palette, which
 * in a dark theme sits almost on the card's own colour; a hairline ring keeps
 * that square visible in every theme without changing the shared palette.
 */

import type { Outcome } from '../outcomes';
import { OUTCOME_BG } from '../../shieldPalette';

const QUIET: Outcome[] = ['clean'];

export function outcomeDot(outcome: Outcome): string {
    const ring = QUIET.includes(outcome) ? ' ring-1 ring-inset ring-[var(--border-default)]' : '';
    return `h-2 w-2 shrink-0 rounded-sm ${OUTCOME_BG[outcome]}${ring}`;
}

/** Whether an outcome's bar segment needs an outline to stay visible (see above). */
export const needsOutline = (outcome: Outcome): boolean => QUIET.includes(outcome);
