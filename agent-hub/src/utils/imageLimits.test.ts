import { describe, it, expect } from 'vitest';
import { EMPTY_IMAGE_LIMITS_INPUT, imageLimitsToInput, limitedWindows, parseImageLimitsInput, toImageQuota } from './imageLimits';

describe('image limits in the admin forms', () => {
    it('shows stored windows as text and the rest as not set', () => {
        expect(imageLimitsToInput({ day: 5, month: 0 })).toEqual({ hour: '', day: '5', week: '', month: '0' });
        expect(imageLimitsToInput(null)).toEqual(EMPTY_IMAGE_LIMITS_INPUT);
        expect(imageLimitsToInput({ hour: 2.5, day: -1, week: 'x' })).toEqual(EMPTY_IMAGE_LIMITS_INPUT);
    });

    it('sends null when no window is set', () => {
        expect(parseImageLimitsInput({ hour: '', day: ' ', week: '', month: '' })).toBeNull();
    });

    it('sends only the set windows, 0 included', () => {
        expect(parseImageLimitsInput({ hour: '', day: '5', week: '0', month: ' 100 ' })).toEqual({ day: 5, week: 0, month: 100 });
    });

    it('refuses what is not a whole number from 0 to a million', () => {
        expect(parseImageLimitsInput({ ...EMPTY_IMAGE_LIMITS_INPUT, hour: '1.5' })).toBeUndefined();
        expect(parseImageLimitsInput({ ...EMPTY_IMAGE_LIMITS_INPUT, day: '-1' })).toBeUndefined();
        expect(parseImageLimitsInput({ ...EMPTY_IMAGE_LIMITS_INPUT, week: 'ten' })).toBeUndefined();
        expect(parseImageLimitsInput({ ...EMPTY_IMAGE_LIMITS_INPUT, month: '1000001' })).toBeUndefined();
    });
});

describe('the image quota of the composer', () => {
    it('lists only the windows with a real limit, shortest first', () => {
        const quota = toImageQuota({ limits: { month: 50, day: 5, hour: 0 }, used: { hour: 1, day: 3, week: 4, month: 12 } });
        expect(limitedWindows(quota)).toEqual([
            { window: 'day', limit: 5, used: 3 },
            { window: 'month', limit: 50, used: 12 },
        ]);
    });

    it('is null for an answer without limits', () => {
        expect(toImageQuota(null)).toBeNull();
        expect(toImageQuota({ limits: {}, used: {} })).toBeNull();
        expect(toImageQuota('nope')).toBeNull();
    });
});
