import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { centreOn, DEFAULT_BOUNDS, isVisibleOn, MIN_HEIGHT, MIN_WIDTH, normaliseWindowState, restoreBounds, type DisplayLike } from './windowState.ts';

const laptop: DisplayLike = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
const external: DisplayLike = { workArea: { x: 1920, y: 0, width: 2560, height: 1440 } };

describe('isVisibleOn', () => {
    it('accepts a window on a display', () => {
        assert.equal(isVisibleOn({ x: 100, y: 100, width: 800, height: 600 }, [laptop]), true);
    });

    it('rejects a window on the monitor that went away', () => {
        assert.equal(isVisibleOn({ x: 2400, y: 200, width: 1200, height: 800 }, [laptop]), false);
        assert.equal(isVisibleOn({ x: 2400, y: 200, width: 1200, height: 800 }, [laptop, external]), true);
    });

    it('rejects a window with only a sliver on screen', () => {
        assert.equal(isVisibleOn({ x: 1900, y: 500, width: 800, height: 600 }, [laptop]), false);
    });

    it('rejects a window dragged above the top of the screen', () => {
        assert.equal(isVisibleOn({ x: 400, y: -900, width: 800, height: 600 }, [laptop]), false);
    });
});

describe('restoreBounds', () => {
    it('puts the window back where it was', () => {
        const bounds = restoreBounds({ x: 2100, y: 300, width: 1400, height: 900 }, [laptop, external], laptop);
        assert.deepEqual(bounds, { x: 2100, y: 300, width: 1400, height: 900 });
    });

    it('centres it on the primary display when the old position is gone', () => {
        const bounds = restoreBounds({ x: 2100, y: 300, width: 1400, height: 900 }, [laptop], laptop);
        assert.deepEqual(bounds, { x: 260, y: 90, width: 1400, height: 900 });
    });

    it('centres a first run', () => {
        const bounds = restoreBounds(null, [laptop], laptop);
        assert.equal(bounds.width, DEFAULT_BOUNDS.width);
        assert.equal(bounds.x, Math.round((1920 - DEFAULT_BOUNDS.width) / 2));
    });

    it('never produces a window too small to use', () => {
        const bounds = restoreBounds({ x: 10, y: 10, width: 20, height: 5 }, [laptop], laptop);
        assert.equal(bounds.width, MIN_WIDTH);
        assert.equal(bounds.height, MIN_HEIGHT);
    });

    it('never produces a window bigger than the display it is centred on', () => {
        const small: DisplayLike = { workArea: { x: 0, y: 0, width: 1024, height: 600 } };
        const bounds = restoreBounds({ x: 5000, y: 0, width: 2400, height: 1400 }, [small], small);
        assert.equal(bounds.width, 1024);
        assert.equal(bounds.height, 600);
    });

    it('survives a session with no display information', () => {
        const bounds = restoreBounds({ x: 10, y: 10, width: 900, height: 700 }, [], undefined);
        assert.equal(bounds.width, 900);
    });
});

describe('centreOn', () => {
    it('centres within the work area, not the whole screen', () => {
        const docked: DisplayLike = { workArea: { x: 0, y: 40, width: 1920, height: 1000 } };
        assert.deepEqual(centreOn(docked, 800, 600), { x: 560, y: 240, width: 800, height: 600 });
    });
});

describe('normaliseWindowState', () => {
    it('keeps only the numbers that are numbers', () => {
        assert.deepEqual(
            normaliseWindowState({ x: 10.4, y: '20', width: NaN, height: 700, maximised: true, fullScreen: 'yes' }),
            { x: 10, height: 700, maximised: true },
        );
    });

    it('returns an empty state for junk', () => {
        for (const junk of [null, undefined, 'x', 42, []]) {
            assert.deepEqual(normaliseWindowState(junk), {});
        }
    });
});
