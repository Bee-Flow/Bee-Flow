import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryWrapper } from '@/test/queryWrapper';
import { useTeamsNotesOrgSettings } from './teamsMeetingNotes';

const fetchMock = vi.fn();

const answer = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
    headers: new Headers({ 'content-type': 'application/json' }),
});

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});

describe('useTeamsNotesOrgSettings', () => {
    it('returns the stored org settings', async () => {
        fetchMock.mockResolvedValue(answer({ autoImport: true, autoRecordConfig: null, language: 'en', lookbackHours: 72 }));
        const { result } = renderHook(() => useTeamsNotesOrgSettings('orgA'), { wrapper: queryWrapper() });
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(result.current.data?.lookbackHours).toBe(72);
    });

    it('errors on an empty answer instead of handing out defaults as the org\'s settings', async () => {
        fetchMock.mockResolvedValue({ ok: true, status: 204, json: async () => null, text: async () => '', headers: new Headers() });
        const { result } = renderHook(() => useTeamsNotesOrgSettings('orgA'), { wrapper: queryWrapper() });
        await waitFor(() => expect(result.current.isError).toBe(true));
        expect(result.current.data).toBeUndefined();
    });

    it('errors on a 5xx', async () => {
        fetchMock.mockResolvedValue(answer({ error: 'unavailable' }, 503));
        const { result } = renderHook(() => useTeamsNotesOrgSettings('orgA'), { wrapper: queryWrapper() });
        await waitFor(() => expect(result.current.isError).toBe(true));
        expect(result.current.data).toBeUndefined();
    });
});
