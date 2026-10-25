import type { FxState } from './useBuildChoreography.types';

/** How long a fresh/touched flag lives past its reveal delay — the reveal settles at ≈1.0 s. */
export const FLAG_TTL_MS = 1400;

/** Layout box of a card (arrange.js DEFAULT_DIMS); the ghost is placed on the same grid. */
export const CARD_W = 240;

export const CARD_H = 96;

export const GHOST_ID = '__ghost__';

export const GHOST_EDGE_ID = '__ghost_edge__';

/**
 * React Flow's own fit-on-mount is a programmatic move too, and it fires
 * onMoveStart with a null event a frame or two after the canvas mounts. Owning
 * the camera for this long after a mount keeps that from reading as the
 * presenter taking over before anything has happened.
 */
export const MOUNT_GRACE_MS = 1500;

/** Ownership outlasts a move by this much: d3 fires the last event a frame after the duration ends. */
export const OWN_SLACK_MS = 80;

/** The chapter-break shot; identical to the pure module's `wide` recipe. */
export const WIDE_SHOT = Object.freeze({ padding: 0.12, minZoom: 0.2, maxZoom: 1, duration: 700, interpolate: 'smooth' });

/** Today's follow-the-build fit, kept for the mount frame and reduced motion. */
export const MOUNT_SHOT = Object.freeze({ padding: 0.12, duration: 260, minZoom: 0.2, maxZoom: 1 });

export const CENTER_DURATION_MS = 300;

/** A resize is a drag of a splitter or a panel animating: wait for it to stop. */
export const RESIZE_SETTLE_MS = 220;

export const NO_NODES = Object.freeze([]);

/**
 * The flag state. `byId` and `edgeKeys` are Maps rebuilt on every change so
 * consumers can memo on their identity; `event` is what the camera effect
 * keys on — a new object per applied diff (and per queue advance), null when
 * a diff changed nothing.
 *
 * `pending` is the burst queue: every card after the head of the current
 * burst, with the instant its turn BEGINS. The flags alone cannot drive the
 * frontier or the camera — a card's reveal delay is a CSS `animation-delay`
 * nobody can observe from here — so the queue is what advances the frontier
 * one card at a time, cues a push-in per landing, and tells the ribbon flight
 * (useRibbonFlight) when each ghost departs. `head` is the burst's first card
 * with its departure instant (it is not in `pending`); `burst` its size.
 */
export const EMPTY: FxState = Object.freeze({
    byId: new Map(),
    edgeKeys: new Map(),
    frontierId: null,
    ghostHidden: false,
    pending: Object.freeze([]),
    head: null,
    burst: 0,
    event: null,
});

/**
 * The canvas the camera may use: its box, minus a strip along the left that
 * something is drawn OVER (the plan panel lives inside the canvas now). The
 * strip is refused when it would leave less than a card and a half to frame
 * in — a narrow canvas is better off framing behind the panel than not at all.
 */
export const MIN_FRAMEABLE_PX = 360;
