import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { DEFAULT_SHOTS, getActiveShots, setActiveShots, shotFor } from './buildChoreography';
import {
    PRESENTER_KEY, PRESENTER_LOD_BREAKS, readPresenter, writePresenter, presenterLod, presenterShots, applyPresenterShots,
} from './presenterMode';
import { LOD_FAR, LOD_MID, LOD_NEAR } from './useZoomLod';
import scopedStorage from '../../../../utils/scopedStorage';

/**
 * Presenter mode's three levers — the LOD breaks, the shot floors and the
 * per-user switch — each pinned on its own, plus the seam into the
 * choreography: `applyPresenterShots(true)` is what makes `shotFor` frame
 * with the 0.95 floor, and `false` gives the defaults back.
 */
const card = (col) => ({ x: col * 320, y: 0, width: 240, height: 72 });
const VIEW = { width: 1100, height: 750 };

describe('presenterLod — text appears earlier on a projector', () => {
    it('flips at 30% and 55% instead of 45% and 80%', () => {
        expect(PRESENTER_LOD_BREAKS).toEqual({ far: 0.30, mid: 0.55 });
        expect(presenterLod(0.29)).toBe(LOD_FAR);
        expect(presenterLod(0.30)).toBe(LOD_MID);
        expect(presenterLod(0.54)).toBe(LOD_MID);
        expect(presenterLod(0.55)).toBe(LOD_NEAR);
        expect(presenterLod(1)).toBe(LOD_NEAR);
    });

    it('treats a missing zoom as 100%, like the default bucket does', () => {
        expect(presenterLod(undefined)).toBe(LOD_NEAR);
        expect(presenterLod(NaN)).toBe(LOD_NEAR);
    });
});

describe('presenterShots — the same recipes with higher floors', () => {
    it('raises push to 0.95 and wide to 0.55 and keeps everything else', () => {
        const shots = presenterShots();
        expect(shots.push.minZoom).toBe(0.95);
        expect(shots.wide.minZoom).toBe(0.55);
        expect(shots.push).toMatchObject({ padding: DEFAULT_SHOTS.push.padding, maxZoom: 1, duration: DEFAULT_SHOTS.push.duration });
        expect(shots.wide).toMatchObject({ padding: DEFAULT_SHOTS.wide.padding, maxZoom: 1, duration: DEFAULT_SHOTS.wide.duration });
        // The defaults themselves are untouched.
        expect(DEFAULT_SHOTS.push.minZoom).toBe(0.85);
        expect(DEFAULT_SHOTS.wide.minZoom).toBe(0.2);
    });

    it('is frozen, like the defaults', () => {
        expect(Object.isFrozen(presenterShots())).toBe(true);
        expect(Object.isFrozen(presenterShots().push)).toBe(true);
    });
});

describe('applyPresenterShots — the seam into the choreography', () => {
    afterEach(() => { setActiveShots(null); });

    it('makes shotFor frame a push on the 0.95 floor, and hands the 0.85 floor back when off', () => {
        // Three cards + ghost: a 1200 px frame in 1100 px cannot reach 1.0, so
        // the zoom sits on whichever floor is active.
        const rects = [card(0), card(1), card(2)];
        const ghostRect = card(3);
        expect(shotFor({ kind: 'push', rects, ghostRect, viewport: VIEW }).zoom).toBe(0.85);

        applyPresenterShots(true);
        expect(getActiveShots().push.minZoom).toBe(0.95);
        expect(shotFor({ kind: 'push', rects, ghostRect, viewport: VIEW }).zoom).toBe(0.95);
        expect(shotFor({ kind: 'push', rects, ghostRect, viewport: VIEW }).duration).toBe(DEFAULT_SHOTS.push.duration);

        applyPresenterShots(false);
        expect(getActiveShots()).toBe(DEFAULT_SHOTS);
        expect(shotFor({ kind: 'push', rects, ghostRect, viewport: VIEW }).zoom).toBe(0.85);
    });

    it('refuses a half recipe and falls back to the defaults', () => {
        setActiveShots({ push: { minZoom: 0.5 } });
        expect(getActiveShots()).toBe(DEFAULT_SHOTS);
    });
});

describe('readPresenter / writePresenter — a per-user switch that never throws', () => {
    beforeEach(() => {
        scopedStorage.setCurrentUser('u-presenter');
        try { localStorage.clear(); } catch { /* jsdom */ }
    });
    afterEach(() => {
        vi.restoreAllMocks();
        scopedStorage.setCurrentUser(null);
    });

    it('is off until written, then round-trips through the user-scoped key', () => {
        expect(readPresenter()).toBe(false);
        writePresenter(true);
        expect(readPresenter()).toBe(true);
        expect(localStorage.getItem(`beeflow:u-presenter:${PRESENTER_KEY}`)).toBe('1');
        writePresenter(false);
        expect(readPresenter()).toBe(false);
    });

    it('a storage that throws costs nothing: write is swallowed, read is off', () => {
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
        expect(() => writePresenter(true)).not.toThrow();
        expect(readPresenter()).toBe(false);
    });

    it('with no signed-in user there is nothing to remember, and nothing breaks', () => {
        scopedStorage.setCurrentUser(null);
        expect(() => writePresenter(true)).not.toThrow();
        expect(readPresenter()).toBe(false);
    });
});
