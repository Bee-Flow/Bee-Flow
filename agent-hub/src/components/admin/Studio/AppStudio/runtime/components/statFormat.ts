/**
 * How the stat tile writes its value and its delta (AppStat.tsx), with the app's `format` and
 * the tile's `formatOptions` (schema 3).
 *
 * Without either the context is null and both are what the tile always showed: displayValue
 * for the value, toLocaleString() for the delta's magnitude. Only a finite NUMBER is formatted:
 * a text value ("€ 12k", "3 open") is the author's own wording and is shown as it is.
 */

import { formatNumber } from '../appFormat';
import { displayValue } from '../uiBits';
import type { FormatContext } from '../appFormat';

/** The kind a numeric stat value is written as: an amount with a currency, a percentage with a scale, else a number. */
function statKind(ctx: FormatContext): 'currency' | 'percent' | 'number' {
    if (ctx.options.currency) return 'currency';
    if (ctx.options.percentScale) return 'percent';
    return 'number';
}

/** The tile's value as text. */
export function statValueText(value: unknown, ctx: FormatContext | null): string {
    if (!ctx || typeof value !== 'number' || !Number.isFinite(value)) return displayValue(value);
    return formatNumber(value, statKind(ctx), ctx);
}

/** The delta's magnitude as text (the chip adds its arrow and, for deltaFormat 'percent', the %). */
export function statDeltaText(magnitude: number, ctx: FormatContext | null): string {
    return ctx ? formatNumber(magnitude, 'number', ctx) : magnitude.toLocaleString();
}
