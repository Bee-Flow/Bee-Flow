import { ROW_GAP } from './rowBands';

/**
 * Layout geometry the ghost slot and the camera reason about. The values are
 * `arrange.js DEFAULT_DIMS` (240×96), `dagreLayout.js DEFAULT_SPACING.ranksep`
 * (80) and `arrange.js DEFAULT_COLUMNS` (5), copied rather than imported
 * because `arrange.js` pulls in dagre and this module has to stay light
 * enough to run in a node test in milliseconds. Column pitch is card width +
 * rank gap; row pitch is card height + ROW_GAP.
 */
export const CARD_W = 240;

export const CARD_H = 96;

const RANK_SEP = 80;

export const COLUMNS = 5;

export const COL_PITCH = CARD_W + RANK_SEP; // 320

export const ROW_PITCH = CARD_H + ROW_GAP; // 366

/** On a row wrap the wide shot has to be readable before the camera pushes back in. */
export const WRAP_HOLD_MS = 900;

/** Shot recipes, mirroring the fitView options the hook used before this module existed. */
export const SHOTS = Object.freeze({
    push: Object.freeze({ padding: 0.15, minZoom: 0.85, maxZoom: 1, duration: 480 }),
    wide: Object.freeze({ padding: 0.12, minZoom: 0.2, maxZoom: 1, duration: 700 }),
});

/** The recipes as designed — presenterMode.js derives its projector set from these. */
export const DEFAULT_SHOTS = SHOTS;

/**
 * Below this zoom delta a `smooth` (zoom-out-then-in) interpolation looks like
 * a hiccup on a pan; above it a linear pan looks like the card slides under
 * the camera. Same threshold the hook applies to `setViewport`.
 */
export const LINEAR_ZOOM_DELTA = 0.05;

/** Reasons that earn a push-in: something new arrived next to the frontier. */
export const PUSH_REASONS = new Set<string | undefined>(['arrival']);

/**
 * A burst of at least this many cards closes on one wide shot (`burst_end`)
 * once its last card has departed. Two cards are a pair, not a chapter — the
 * push-ins already framed both.
 */
export const BURST_WIDE_MIN = 3;

/**
 * Chapter breaks: the whole shape changed or a chapter ended, so the audience
 * gets the wide shot. Nothing else moves the camera — an update on screen, a
 * refused call, a plain re-send are silent by design. `burst` is gone from
 * this list on purpose: a batch used to earn ONE wide shot at t≈0, while every
 * card was still invisible, and the camera then sat on an empty frame for the
 * whole reveal. A burst is now dealt card by card (each landing is an
 * `arrival`) and the wide shot comes at the END.
 */
export const WIDE_REASONS = new Set<string | undefined>(['wrap', 'burst_end', 'remove', 'replace', 'move', 'summarise', 'dry_run', 'finalize', 'end', 'resume']);
