import { DEFAULT_SHOTS, setActiveShots } from './buildChoreography';
import { lodForZoom, PRESENTER_LOD_BREAKS } from './useZoomLod';

/**
 * Presenter mode — the automations canvas on a projector.
 *
 * Nothing about the graph changes (no layout re-run, the cards stay 240×72);
 * what changes is how early text appears and how tight the build's camera
 * frames:
 *
 *   - LOD breaks shift down (flow/useZoomLod.js reads PresenterContext):
 *     names at 30% instead of 45%, the whole card at 55% instead of 80%.
 *   - the build choreography's push-in floors rise (0.85 → 0.95) and its wide
 *     shot floor rises (0.2 → 0.55), via buildChoreography's active-shots
 *     setter — see the note there about which fits it reaches.
 *   - the stylesheet keys on `data-presenter="on"` (index.css) for the south
 *     bar, badges and the ghost caption; edges.jsx thickens the lines by 1px.
 *
 * The flag is a per-user preference: it survives a reload through
 * scopedStorage (which already swallows a refusing localStorage; the try/
 * catch here is belt to that brace — a demo must never fail on a storage
 * quirk). It is read once, on mount, by DiagramPane.
 */
// The flag itself is shared with the App Studio editor (shared/builder/presenterFlag).
export { PRESENTER_KEY, readPresenter, writePresenter } from '../../../shared/builder/presenterFlag';

export { PRESENTER_LOD_BREAKS };

/** The LOD bucket for `zoom` with the projector breaks. */
export function presenterLod(zoom) {
    return lodForZoom(zoom, PRESENTER_LOD_BREAKS);
}

/** The shot recipes with projector floors: push 0.95, wide 0.55. */
export function presenterShots(base = DEFAULT_SHOTS) {
    return Object.freeze({
        ...base,
        push: Object.freeze({ ...base.push, minZoom: 0.95 }),
        wide: Object.freeze({ ...base.wide, minZoom: 0.55 }),
    });
}

/** Swap the choreography's active recipes in (`true`) or back out (`false`). */
export function applyPresenterShots(on) {
    setActiveShots(on ? presenterShots() : null);
}
