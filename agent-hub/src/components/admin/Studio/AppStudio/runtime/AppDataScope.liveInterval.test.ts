import { describe, it, expect } from 'vitest';
import { liveIntervalMs } from './AppDataScope';
import { MIN_REFRESH_MS } from './useAppDataSource';

describe('liveIntervalMs', () => {
    it('polls the values below the floor at the floor', () => {
        for (const s of [2, 5, 10]) expect(liveIntervalMs(s)).toBe(MIN_REFRESH_MS);
    });

    it('keeps values at or above the floor exactly', () => {
        expect(liveIntervalMs(15)).toBe(15_000);
        expect(liveIntervalMs(30)).toBe(30_000);
    });
});
