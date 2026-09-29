/**
 * The vocabulary every playbook stage speaks — one place, so a phase cannot
 * drift from its neighbours.
 *
 * Measured before this existed (2026-09-17): four content widths (560 /
 * full-bleed / 780 / 980), four outer paddings, four header-tile recipes, four
 * card radii, six card paddings and two primary-button treatments across eight
 * phases of one film. On a projector that reads as five screens from four
 * products, which is exactly what the owner asked to be rid of.
 *
 * Numbers, not opinions: every value here was one of the ones already in use —
 * the majority spelling wins, and the exceptions become `full` or `wide`.
 */

/** The content column. Two real ones; `wide` is the design grid, `full` the builders. */
export const WIDTH = Object.freeze({ narrow: 560, default: 780, wide: 980, full: null });

/** Outer padding of a stage, normal and presenter. */
export function stagePadding(presenter) {
    return presenter ? '32px 32px' : '24px';
}

/**
 * The type scale. Stages used to carry ~40 inline `presenter ? a : b` literals,
 * which is how DesignStage ended up scaling its title and leaving every word
 * inside its wireframes at 11px — unreadable from a conference floor, on the
 * one phase whose entire content is what is being read.
 */
export function stageType(presenter) {
    return presenter
        ? { title: 22, hero: 20, card: 17, body: 14, meta: 13, micro: 12 }
        : { title: 18, hero: 16, card: 14, body: 12, meta: 11, micro: 11 };
}

/** A stage's own card: one radius, one border, one elevation, one padding pair. */
export function heroCard(presenter) {
    return {
        background: 'var(--bg-card)',
        border: '1px solid var(--border-default)',
        borderRadius: 16,
        boxShadow: 'var(--shadow-md)',
        padding: presenter ? 28 : 22,
    };
}

/** Anything nested inside a stage card, or a repeated row. */
export function panelCard(presenter) {
    return {
        background: 'var(--bg-card)',
        border: '1px solid var(--border-default)',
        borderRadius: 12,
        padding: presenter ? 16 : 12,
    };
}

/**
 * One button geometry. Two heights and two radii used to sit side by side
 * INSIDE one finding row, and roughly half the run page's interactive elements
 * had no focus ring at all — there is no global `:focus-visible` baseline in
 * this app, so every button has to opt in.
 */
export const STAGE_BUTTON = 'inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-xs font-semibold disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';
export const STAGE_BUTTON_GHOST = Object.freeze({
    color: 'var(--text-secondary)',
    border: '1px solid var(--border-default)',
    background: 'var(--bg-card)',
    outlineColor: 'var(--accent-primary)',
});

/**
 * `ready` and `running` are the same half-second to a person, and were painted
 * three different ways: static text, a spinning line, a centred spinner.
 */
export function isBusy(status) {
    return status === 'running' || status === 'ready';
}
