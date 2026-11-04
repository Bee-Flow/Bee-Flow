import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryWrapper } from '@/test/queryWrapper';
import { useMeetingTagCountsQuery, useTranscriptionsQuery } from './meetingLibrary';

const fetchMock = vi.fn();

const json = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
    headers: new Headers({ 'content-type': 'application/json' }),
});

const notes = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `n${i + 1}`, title: `Meeting ${i + 1}`, tags: [10, 40, 55, 60, 65, 70, 75].includes(i + 1) ? ['client-x'] : [], status: 'done' }));

/** Pages like routes/transcriptions/notes.js (default 50, at most 100, offset); /tags counts over every note like tags.js. */
function serve(all: ReturnType<typeof notes>) {
    fetchMock.mockImplementation(async (url: string) => {
        const u = new URL(String(url), 'http://x');
        if (u.pathname.endsWith('/api/transcriptions/tags')) {
            return json([{ tag: 'client-x', count: all.filter(n => n.tags.includes('client-x')).length }]);
        }
        const limit = Math.min(Number(u.searchParams.get('limit') ?? 50), 100);
        const offset = Number(u.searchParams.get('offset') ?? 0);
        return json({ transcriptions: all.slice(offset, offset + limit) });
    });
}

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});

describe('useTranscriptionsQuery', () => {
    it('holds every readable note, so a tag chip count matches the rows its filter shows', async () => {
        serve(notes(230));
        const list = renderHook(() => useTranscriptionsQuery(), { wrapper: queryWrapper() });
        const tags = renderHook(() => useMeetingTagCountsQuery(0), { wrapper: queryWrapper() });
        await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
        await waitFor(() => expect(tags.result.current.isSuccess).toBe(true));
        const rows = (list.result.current.data ?? []) as { id: string; tags: string[] }[];
        expect(rows).toHaveLength(230);
        expect(rows.map(n => n.id)).toContain('n171');
        const chip = tags.result.current.data?.find(t => t.tag === 'client-x');
        expect(chip?.count).toBe(7);
        expect(rows.filter(n => n.tags.includes('client-x'))).toHaveLength(chip?.count ?? -1);
    });

    it('errors when a page fails, instead of passing a partial list off as the whole', async () => {
        fetchMock.mockResolvedValueOnce(json({ transcriptions: notes(100) })).mockResolvedValue(json({ error: 'boom' }, 500));
        const { result } = renderHook(() => useTranscriptionsQuery(), { wrapper: queryWrapper() });
        await waitFor(() => expect(result.current.isError).toBe(true));
    });
});
