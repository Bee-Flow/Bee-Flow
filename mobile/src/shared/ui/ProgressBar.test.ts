/**
 * The number the progress bar draws with.
 *
 * `progressPercent` came from features/recording, where it was computed inline
 * and clamped only on one side. The boundaries that matter are the two ends
 * and the floor, and all three are the kind of thing that is wrong by one and
 * never noticed.
 */

import { progressPercent } from './ProgressBar';

describe('progressPercent', () => {
    it('reports whole per cent across the range', () => {
        expect(progressPercent(0.5)).toEqual({ percent: 50, width: '50%' });
        expect(progressPercent(0.637)).toEqual({ percent: 64, width: '64%' });
        expect(progressPercent(1)).toEqual({ percent: 100, width: '100%' });
    });

    it('holds a barely-started bar at a visible 2%, while still reporting the truth', () => {
        // The width and the announced value part company here on purpose. A
        // bar drawn 0.4% wide is indistinguishable from an empty one, and an
        // upload that has genuinely started must not look stalled — but
        // TalkBack should still say "zero per cent", not "two".
        expect(progressPercent(0)).toEqual({ percent: 0, width: '2%' });
        expect(progressPercent(0.004)).toEqual({ percent: 0, width: '2%' });
        expect(progressPercent(0.01)).toEqual({ percent: 1, width: '2%' });
        expect(progressPercent(0.02)).toEqual({ percent: 2, width: '2%' });
        expect(progressPercent(0.03)).toEqual({ percent: 3, width: '3%' });
    });

    it('clamps rather than trusts, at both ends', () => {
        // A byte counter that overshoots its own content-length is the usual
        // source of these, and `width: '104%'` on a bar inside an
        // overflow-hidden track is invisible right up until the day the track
        // stops hiding overflow.
        expect(progressPercent(1.04)).toEqual({ percent: 100, width: '100%' });
        expect(progressPercent(-0.5)).toEqual({ percent: 0, width: '2%' });
    });

    it('treats a NaN as no progress instead of rendering NaN%', () => {
        // Division by a zero total is how this arrives.
        expect(progressPercent(Number.NaN)).toEqual({ percent: 0, width: '2%' });
        expect(progressPercent(Number.POSITIVE_INFINITY)).toEqual({ percent: 0, width: '2%' });
    });
});
