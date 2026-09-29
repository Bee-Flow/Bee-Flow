import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/transcriptionsApi', () => ({ listTranscriptionTags: vi.fn() }));

import useMeetingTags from './useMeetingTags';
import { listTranscriptionTags } from '../lib/transcriptionsApi';

/**
 * The chip vocabulary. The server counts over every note the caller may read;
 * the loaded rows are a PAGE of 50, so they are only the fallback — but they
 * must BE the fallback, or an org whose tags endpoint is not deployed yet
 * (the route is mounted with this track) loses its filters entirely.
 */

const ROWS = [
    { id: 'a', tags: ['dataweging', 'knltb'] },
    { id: 'b', tags: ['dataweging'] },
    { id: 'c', tags: [] },
    { id: 'd', tags: 'not-an-array' },
    { id: 'e' },
];

describe('useMeetingTags', () => {
    // Block body on purpose: an arrow that RETURNS the mock hands Vitest what
    // it treats as a cleanup function, so it calls the mock once more after
    // the test — and that stray call's rejected promise is nobody's, which
    // fails the test with the error the hook itself caught.
    beforeEach(() => { listTranscriptionTags.mockReset(); });

    it('uses the server vocabulary once it answers', async () => {
        listTranscriptionTags.mockResolvedValue([
            { tag: 'dataweging', count: 41 },
            { tag: 'spelersmonitor', count: '3' },
        ]);
        const { result } = renderHook(() => useMeetingTags(ROWS));
        await waitFor(() => expect(result.current.fromServer).toBe(true));
        expect(result.current.tags).toEqual([
            { tag: 'dataweging', count: 41 },
            { tag: 'spelersmonitor', count: 3 },
        ]);
    });

    it('falls back to the loaded rows when the endpoint fails — never an empty filter row', async () => {
        listTranscriptionTags.mockRejectedValue(Object.assign(new Error('HTTP 404'), { status: 404 }));
        const { result } = renderHook(() => useMeetingTags(ROWS));
        await waitFor(() => expect(result.current.tags.length).toBeGreaterThan(0));
        expect(result.current.fromServer).toBe(false);
        expect(result.current.tags).toEqual([
            { tag: 'dataweging', count: 2 },
            { tag: 'knltb', count: 1 },
        ]);
    });

    it('a row with a non-array or missing tags value counts as no tags', async () => {
        listTranscriptionTags.mockRejectedValue(new Error('offline'));
        const { result } = renderHook(() => useMeetingTags([{ id: 'x', tags: { a: 1 } }, { id: 'y' }]));
        await waitFor(() => expect(result.current.fromServer).toBe(false));
        expect(result.current.tags).toEqual([]);
    });

    it('drops empty and non-string tags the server may hand back', async () => {
        listTranscriptionTags.mockResolvedValue([
            { tag: 'ok', count: 2 },
            { tag: '', count: 5 },
            { tag: 7, count: 5 },
            null,
        ]);
        const { result } = renderHook(() => useMeetingTags([]));
        await waitFor(() => expect(result.current.fromServer).toBe(true));
        expect(result.current.tags).toEqual([{ tag: 'ok', count: 2 }]);
    });

    it('re-asks the server when the page bumps the refresh key (a tag was added)', async () => {
        listTranscriptionTags.mockResolvedValue([{ tag: 'one', count: 1 }]);
        const { result, rerender } = renderHook(({ key }) => useMeetingTags([], key), {
            initialProps: { key: 0 },
        });
        await waitFor(() => expect(result.current.fromServer).toBe(true));
        expect(listTranscriptionTags).toHaveBeenCalledTimes(1);

        listTranscriptionTags.mockResolvedValue([{ tag: 'one', count: 1 }, { tag: 'two', count: 1 }]);
        rerender({ key: 1 });
        await waitFor(() => expect(result.current.tags.length).toBe(2));
        expect(listTranscriptionTags).toHaveBeenCalledTimes(2);
    });
});
