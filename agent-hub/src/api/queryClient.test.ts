import { describe, it, expect } from 'vitest';
import { ApiError } from './client';
import { RefusedError } from './mutate';
import { queryClient, retryUnlessRefused } from './queryClient';

describe('retryUnlessRefused', () => {
    it.each([400, 401, 403, 404, 409, 422])('does not retry a %i: the answer will not change', (status) => {
        expect(retryUnlessRefused(0, new ApiError('refused', { status }))).toBe(false);
    });

    it.each([408, 429, 500, 502, 503])('retries a %i twice, then stops', (status) => {
        const error = new ApiError('try again', { status });
        expect(retryUnlessRefused(0, error)).toBe(true);
        expect(retryUnlessRefused(1, error)).toBe(true);
        expect(retryUnlessRefused(2, error)).toBe(false);
    });

    it('reads the status of any error that carries one, not only of ApiError', () => {
        expect(retryUnlessRefused(0, new RefusedError('gone', { status: 404 }))).toBe(false);
        expect(retryUnlessRefused(0, Object.assign(new Error('gone'), { status: 404 }))).toBe(false);
    });

    it('retries an error without a numeric status (a network failure, a plain throw)', () => {
        expect(retryUnlessRefused(0, new TypeError('Failed to fetch'))).toBe(true);
        expect(retryUnlessRefused(1, new Error('HTTP 404'))).toBe(true);
        expect(retryUnlessRefused(0, Object.assign(new Error('odd'), { status: '404' }))).toBe(true);
        expect(retryUnlessRefused(0, null)).toBe(true);
        expect(retryUnlessRefused(2, new Error('offline'))).toBe(false);
    });
});

describe('queryClient', () => {
    it('uses the rule as the default for every query and never retries a mutation', () => {
        const defaults = queryClient.getDefaultOptions();
        expect(defaults.queries?.retry).toBe(retryUnlessRefused);
        expect(defaults.mutations?.retry).toBe(false);
    });
});
