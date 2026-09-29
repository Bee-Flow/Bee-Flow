/**
 * The Privacy Shield's two colour families, in one place: what the shield DID
 * (outcomes) and where data WENT (regions).
 *
 * No new theme tokens. The round-3 artboards were drawn from the app's own
 * palette — their "replaced" teal is exactly --type-loop and their "inside
 * Europe" teal exactly --type-trigger in the light set — so each colour here
 * points at an existing token that already has a tuned value in every theme.
 *
 * Tailwind only generates classes it can SEE in the source, so every class is
 * written out in full below; never build one with string concatenation.
 * `fill` values are raw `var(--x)` strings for SVG attributes, which cost no
 * inline style objects.
 *
 * ── Fill colours are not text colours ─────────────────────────────────────
 * --type-loop, --kind-app, --type-trigger and --kind-skill are tuned as FILLS
 * (swatches, bars, pins); as the colour of small text they fall under 4.5:1
 * in the light and the high-contrast themes. The *_TEXT maps below mix each
 * one a quarter of the way toward the theme's own ink: still the family's
 * hue, readable in every theme, no new token.
 */

import type { Outcome } from './activity/outcomes';

export type Region = 'local' | 'eu' | 'outside' | 'via_network' | 'unknown';

/** Region display order: your own server first, then outward. */
export const REGION_ORDER: Region[] = ['local', 'eu', 'outside', 'via_network', 'unknown'];

export const OUTCOME_FILL: Record<Outcome, string> = {
    replaced: 'var(--type-loop)',
    stopped: 'var(--kind-app)',
    tool: 'var(--warning)',
    passed: 'var(--error)',
    clean: 'var(--bg-tertiary)',
    unchecked: 'var(--text-muted)',
    other: 'var(--text-tertiary)',
};

/** Solid swatch (dots, bar segments). */
export const OUTCOME_BG: Record<Outcome, string> = {
    replaced: 'bg-[var(--type-loop)]',
    stopped: 'bg-[var(--kind-app)]',
    tool: 'bg-[var(--warning)]',
    passed: 'bg-[var(--error)]',
    clean: 'bg-[var(--bg-tertiary)]',
    unchecked: 'bg-[var(--text-muted)]',
    other: 'bg-[var(--text-tertiary)]',
};

/** Coloured numbers in running text. `clean`, `unchecked` and `other` stay neutral. */
export const OUTCOME_TEXT: Record<Outcome, string> = {
    replaced: 'text-[color-mix(in_srgb,var(--type-loop)_75%,var(--text-primary))]',
    stopped: 'text-[color-mix(in_srgb,var(--kind-app)_75%,var(--text-primary))]',
    tool: 'text-[var(--warning-ink)]',
    passed: 'text-[var(--error-ink)]',
    clean: 'text-[var(--text-secondary)]',
    unchecked: 'text-[var(--text-secondary)]',
    other: 'text-[var(--text-secondary)]',
};

export const REGION_FILL: Record<Region, string> = {
    local: 'var(--success-ink)',
    eu: 'var(--type-trigger)',
    outside: 'var(--kind-skill)',
    via_network: 'var(--text-secondary)',
    unknown: 'var(--text-tertiary)',
};

export const REGION_BG: Record<Region, string> = {
    local: 'bg-[var(--success-ink)]',
    eu: 'bg-[var(--type-trigger)]',
    outside: 'bg-[var(--kind-skill)]',
    via_network: 'bg-[var(--text-secondary)]',
    unknown: 'bg-[var(--text-tertiary)]',
};

export const REGION_TEXT: Record<Region, string> = {
    local: 'text-[var(--success-ink)]',
    eu: 'text-[color-mix(in_srgb,var(--type-trigger)_75%,var(--text-primary))]',
    outside: 'text-[color-mix(in_srgb,var(--kind-skill)_75%,var(--text-primary))]',
    via_network: 'text-[var(--text-secondary)]',
    unknown: 'text-[var(--text-tertiary)]',
};

/** The same text colours as raw values, for SVG `<text fill>` (the host names beside the pins). */
export const REGION_TEXT_FILL: Record<Region, string> = {
    local: 'var(--success-ink)',
    eu: 'color-mix(in srgb, var(--type-trigger) 75%, var(--text-primary))',
    outside: 'color-mix(in srgb, var(--kind-skill) 75%, var(--text-primary))',
    via_network: 'var(--text-secondary)',
    unknown: 'var(--text-tertiary)',
};

/** A location state from the server (`location_state`) → its region; anything unrecognised is unknown. */
export function regionOf(state: string | null | undefined): Region {
    return (REGION_ORDER as string[]).includes(String(state)) ? (state as Region) : 'unknown';
}
