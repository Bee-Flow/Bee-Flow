import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

import { authFetch } from '../utils/helpers';
import useProjectStream from './useProjectStream';

afterEach(() => { vi.useRealTimers(); });

describe('useProjectStream: degraded polling', () => {
    it('tells the caller after each successful poll, so it can re-read what the activity feed does not log', async () => {
        vi.useFakeTimers();
        authFetch.mockImplementation(async (url) => {
            if (url.includes('/activity')) return { ok: true, status: 200, json: async () => ({ items: [] }) };
            throw new Error('no sse here');
        });
        const onPoll = vi.fn();
        renderHook(() => useProjectStream({ projectId: 'p1', onEvent: vi.fn(), onPoll }));
        await vi.advanceTimersByTimeAsync(30_000);
        const first = onPoll.mock.calls.length;
        expect(first).toBeGreaterThanOrEqual(1);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(onPoll.mock.calls.length).toBeGreaterThan(first);
    });
});
