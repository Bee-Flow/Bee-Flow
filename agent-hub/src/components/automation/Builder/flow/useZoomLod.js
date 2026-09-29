import { useStore } from '@xyflow/react';
import { useContext } from 'react';
import { PresenterContext } from './PresenterContext';

/**
 * Level of detail for a step card, by canvas zoom (builder redesign, 1g).
 *
 *   far   < 45%  — shape, family colour, type label, status. Nothing to read.
 *   mid   45–80% — plus the name and the step number.
 *   near  > 80%  — the full card: kicker, name, summary line, badges.
 *
 * Why a BUCKET and not the zoom itself: `useViewport()` (what edges.jsx uses)
 * re-renders its caller on every pan frame, because x and y are part of the
 * viewport. Selecting the bucket from React Flow's store instead means the
 * selector's RESULT only changes when the zoom crosses 45% or 80% — panning
 * changes `transform[0]`/`[1]`, the bucket stays the same string, and
 * zustand's Object.is comparison skips the render. Across a whole zoom sweep
 * a card re-renders exactly twice.
 *
 * Presenter mode (flow/presenterMode.js) shifts both breaks down — text
 * appears at 30% and the full card at 55% — so a projector at the back of a
 * room shows names where a laptop would show shapes. The flag comes from
 * PresenterContext; the card's box stays 240×72 at every level, so nothing
 * about the layout changes when the mode flips.
 *
 * Read once, in StepNodeBase. The per-type node files never see it.
 */
export const LOD_FAR = 'far';
export const LOD_MID = 'mid';
export const LOD_NEAR = 'near';

/** Zoom factors (1 = 100%) at which the level flips. */
export const LOD_BREAKS = Object.freeze({ far: 0.45, mid: 0.80 });

/** The same breaks for a projector: names at 30%, the whole card at 55%. */
export const PRESENTER_LOD_BREAKS = Object.freeze({ far: 0.30, mid: 0.55 });

export function lodForZoom(zoom, breaks = LOD_BREAKS) {
    const z = Number.isFinite(zoom) ? zoom : 1;
    if (z < breaks.far) return LOD_FAR;
    if (z < breaks.mid) return LOD_MID;
    return LOD_NEAR;
}

// One stable selector function per mode, so the store subscription is not
// re-created on every render of every card.
const selectLod = (s) => lodForZoom(s?.transform?.[2]);
const selectPresenterLod = (s) => lodForZoom(s?.transform?.[2], PRESENTER_LOD_BREAKS);

export function useZoomLod() {
    const presenter = useContext(PresenterContext);
    return useStore(presenter ? selectPresenterLod : selectLod);
}
