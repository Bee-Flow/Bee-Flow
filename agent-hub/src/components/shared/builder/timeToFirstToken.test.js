import { describe, it, expect, beforeEach } from 'vitest';
import {
    HISTORY_SIZE, expectation, medianOf, modelKeyFor, readHistory, recordTtft,
} from './timeToFirstToken';
import scopedStorage from '../../../utils/scopedStorage';

/**
 * The learned time-to-first-token: where a sample is filed, how many are kept,
 * and what the card may claim from them. Pure functions over scopedStorage,
 * so the tests run against jsdom's localStorage with a user registered — the
 * wrapper reads and writes nothing without one.
 */
describe('timeToFirstToken', () => {
    beforeEach(() => {
        localStorage.clear();
        scopedStorage.setCurrentUser('u-ttft');
    });

    describe('modelKeyFor', () => {
        it('prefers the model the server named', () => {
            expect(modelKeyFor({ modelId: 'qwen3-27b', tier: 'fast' }, 'thinking')).toBe('qwen3-27b');
        });
        it('falls back to the turn tier, then the selected tier, then fast', () => {
            expect(modelKeyFor({ modelId: null, tier: 'thinking' }, 'fast')).toBe('tier:thinking');
            expect(modelKeyFor({ tier: null }, 'thinking')).toBe('tier:thinking');
            expect(modelKeyFor(null, 'thinking')).toBe('tier:thinking');
            expect(modelKeyFor(null, null)).toBe('tier:fast');
        });
    });

    describe('medianOf', () => {
        it('is null for nothing, the middle for odd, the mean of the two middles for even', () => {
            expect(medianOf([])).toBeNull();
            expect(medianOf(null)).toBeNull();
            expect(medianOf([5])).toBe(5);
            expect(medianOf([9, 1, 3])).toBe(3);
            expect(medianOf([4, 1, 3, 2])).toBe(2.5);
        });
        it('ignores entries that are not numbers', () => {
            expect(medianOf([3, NaN, 'x', 1, null])).toBe(2);
        });
        it('shrugs off one cold start — the reason it is a median', () => {
            // First turn after the model was paged in: 3x the rest.
            expect(medianOf([190000, 62000, 58000, 61000, 60000])).toBe(61000);
        });
    });

    describe('recordTtft / readHistory', () => {
        it('keeps the last five, oldest first', () => {
            for (const ms of [1000, 2000, 3000, 4000, 5000, 6000, 7000]) recordTtft('tier:fast', ms);
            const h = readHistory('tier:fast');
            expect(h).toHaveLength(HISTORY_SIZE);
            expect(h).toEqual([3000, 4000, 5000, 6000, 7000]);
        });
        it('rounds, returns the stored list, and refuses a non-duration', () => {
            expect(recordTtft('m', 1234.6)).toEqual([1235]);
            expect(recordTtft('m', 0)).toEqual([1235]);
            expect(recordTtft('m', -5)).toEqual([1235]);
            expect(recordTtft('m', NaN)).toEqual([1235]);
            expect(readHistory('m')).toEqual([1235]);
        });
        it('files different models apart', () => {
            recordTtft('a', 100);
            recordTtft('b', 200);
            expect(readHistory('a')).toEqual([100]);
            expect(readHistory('b')).toEqual([200]);
        });
        it('reads an empty history for an unknown key and for a corrupt value', () => {
            expect(readHistory('never')).toEqual([]);
            scopedStorage.setJSON('builderTtft:bad', { not: 'a list' });
            expect(readHistory('bad')).toEqual([]);
            scopedStorage.setJSON('builderTtft:mixed', [10, 'x', -1, 20]);
            expect(readHistory('mixed')).toEqual([10, 20]);
        });
        it('is inert without a registered user — nothing leaks across accounts', () => {
            scopedStorage.setCurrentUser(null);
            expect(recordTtft('m', 500)).toEqual([]);
            expect(readHistory('m')).toEqual([]);
        });
    });

    describe('expectation', () => {
        it('is indeterminate without a median', () => {
            expect(expectation({ medianMs: null, elapsedMs: 5000 })).toEqual({ mode: 'indeterminate' });
            expect(expectation({ medianMs: 0, elapsedMs: 5000 })).toEqual({ mode: 'indeterminate' });
        });
        it('fills towards the median and never reaches the end', () => {
            expect(expectation({ medianMs: 100000, elapsedMs: 50000 })).toEqual({ mode: 'determinate', fraction: 0.5, over: false, medianMs: 100000 });
            expect(expectation({ medianMs: 100000, elapsedMs: 100000 }).fraction).toBe(0.96);
            expect(expectation({ medianMs: 100000, elapsedMs: 300000 }).fraction).toBe(0.96);
        });
        it('flags a wait that has outrun the median by a quarter', () => {
            expect(expectation({ medianMs: 100000, elapsedMs: 125000 }).over).toBe(false);
            expect(expectation({ medianMs: 100000, elapsedMs: 125001 }).over).toBe(true);
        });
        it('treats a missing or negative elapsed as zero', () => {
            expect(expectation({ medianMs: 100000 }).fraction).toBe(0);
            expect(expectation({ medianMs: 100000, elapsedMs: -5 }).fraction).toBe(0);
        });
    });
});
