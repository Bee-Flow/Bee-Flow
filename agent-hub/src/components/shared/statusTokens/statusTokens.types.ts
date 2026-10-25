import type { LucideIcon } from 'lucide-react';

export const STATUS_KEYS = [
    'success',
    'error',
    'running',
    'queued',
    'paused',
    'cancelled',
    'awaiting_approval',
    'awaiting_form',
    'skipped',
    'nothing_to_do',
    'handled_error',
    'pinned',
    'edited',
    'warning',
    'info',
    'idle',
] as const;

export type StatusKey = typeof STATUS_KEYS[number];

export interface StatusToken {
    solid: string;
    subtle: string;
    badge: string;
    /**
     * The raw custom property behind this row, for the surfaces that paint
     * with inline styles instead of Tailwind classes — the builder canvas
     * draws a card's border, its status ring, its pulse and its minimap
     * swatch from this one.
     *
     * RAW, never the `-ink` step: the ink is the darker (or, on the dark
     * themes, lighter) variant that keeps a WORD legible against the page,
     * while a 1.5px border is the colour itself. It is the same token
     * `subtle` and `badge` tint from — the invariant the test checks.
     *
     * `null` on the neutral rows. A canvas has no grey chrome to offer: a
     * neutral state keeps the card's ordinary border, which is exactly what
     * "this state makes no claim" looks like there.
     */
    cssVar: string | null;
    icon: LucideIcon;
    spin: boolean;
    /** i18n key — translate with `statusLabel(t, token)`, never render raw. */
    labelKey: string;
    /** English fallback, passed as t()'s second argument. */
    labelEn: string;
}

/**
 * What a skip MEANS, per reason code.
 *
 *   configured  the step never ran because someone switched it off. A
 *               configuration fact. Grey, always: colouring it would put
 *               every automation that has one disabled node permanently on
 *               amber, and a warning that is always on is not a warning.
 *   no_work     the step ran and had nothing to do — an empty summary, a
 *               source list that did not resolve, a column that is not
 *               there. An OUTCOME, and the one the run view should show in
 *               amber: it used to pass as a green success with an empty
 *               result, which is how an automation could report "done" for
 *               weeks while writing nothing.
 *   pinned      not a skip at all in the UI — the step was replaced by
 *               frozen data and gets its own status. Listed so this table
 *               covers every code the runner can emit.
 *
 * These are the codes `server/core/automationRunner/*` sets as
 * `skippedReason`; execCollections.js calls them "the stable code tests and
 * run-history facets match on", which is exactly what makes them safe to key
 * a colour off. The runner's English sentence on `output.skipped` is NOT
 * consulted — a colour decided by parsing prose breaks the first time the
 * sentence is reworded or translated.
 */
export type SkipGroup = 'configured' | 'no_work' | 'pinned';

/** A recorded run-step row, as much of it as this module reads. */
export interface RunStepLike {
    status?: string | null;
    /** The runner's code. Not persisted yet — see skipGroupOfStep. */
    skippedReason?: string | null;
    output?: unknown;
}
