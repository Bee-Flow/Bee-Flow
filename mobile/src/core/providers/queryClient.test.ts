/**
 * The query client's retry rule is a product decision, not a default: a 4xx
 * is a settled answer (plan limit, not entitled, gone) and retrying it only
 * delays the message; a 5xx or a network failure gets two more tries.
 */

import { ApiError, OfflineError } from '@/core/api/client';

import { createQueryClient } from './queryClient';

const retry = createQueryClient().getDefaultOptions().queries?.retry as (n: number, e: unknown) => boolean;

describe('createQueryClient', () => {
    it('never retries a 4xx', () => {
        expect(retry(0, new ApiError('HTTP 402', { status: 402 }))).toBe(false);
        expect(retry(0, new ApiError('HTTP 404', { status: 404 }))).toBe(false);
    });

    it('retries a 5xx or a transport failure twice', () => {
        const boom = new ApiError('HTTP 503', { status: 503 });
        expect([0, 1, 2].map((n) => retry(n, boom))).toEqual([true, true, false]);
        expect(retry(1, new OfflineError())).toBe(true);
    });

    it('never retries a write, and refetches on focus and reconnect', () => {
        const options = createQueryClient().getDefaultOptions();
        expect(options.mutations?.retry).toBe(false);
        expect(options.queries?.refetchOnWindowFocus).toBe(true);
        expect(options.queries?.refetchOnReconnect).toBe(true);
        expect(options.queries?.staleTime).toBe(30_000);
    });

    it('runs reads and writes while offline, so the offline error is shown instead of a pause', () => {
        const options = createQueryClient().getDefaultOptions();
        expect(options.queries?.networkMode).toBe('always');
        expect(options.mutations?.networkMode).toBe('always');
    });
});
