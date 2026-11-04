import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryWrapper } from '@/test/queryWrapper';
import { useOrgNotesSettingsQuery } from './meetingNotesSettings';

const fetchMock = vi.fn();

const json = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
    headers: new Headers({ 'content-type': 'application/json' }),
});

interface Cfg { recordingFolder: string; defaultOwnerUserId: string | null }

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});

describe('useOrgNotesSettingsQuery', () => {
    it('returns the stored org settings', async () => {
        fetchMock.mockResolvedValue(json({ recordingFolder: '/Custom/Rec', defaultOwnerUserId: 'u-owner' }));
        const { result } = renderHook(() => useOrgNotesSettingsQuery<Cfg>('talk', 'orgA'), { wrapper: queryWrapper() });
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(result.current.data).toEqual({ recordingFolder: '/Custom/Rec', defaultOwnerUserId: 'u-owner' });
        expect(String(fetchMock.mock.calls[0][0])).toContain('/api/talk-notes-settings/orgA');
    });

    it('errors on a 5xx instead of passing empty settings off as the org\'s (a save would wipe them)', async () => {
        fetchMock.mockResolvedValue(json({ error: 'config store unavailable' }, 503));
        const { result } = renderHook(() => useOrgNotesSettingsQuery<Cfg>('talk', 'orgA'), { wrapper: queryWrapper() });
        await waitFor(() => expect(result.current.isError).toBe(true));
        expect(result.current.data).toBeUndefined();
    });

    it('errors on a network failure', async () => {
        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
        const { result } = renderHook(() => useOrgNotesSettingsQuery<Cfg>('gmeet', 'orgA'), { wrapper: queryWrapper() });
        await waitFor(() => expect(result.current.isError).toBe(true));
        expect(result.current.data).toBeUndefined();
    });

    it('keeps the loaded settings when a refetch fails', async () => {
        fetchMock.mockResolvedValueOnce(json({ recordingFolder: '/Custom/Rec', defaultOwnerUserId: 'u-owner' }));
        const { result } = renderHook(() => useOrgNotesSettingsQuery<Cfg>('talk', 'orgA'), { wrapper: queryWrapper() });
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        fetchMock.mockResolvedValue(json({ error: 'bad gateway' }, 502));
        await result.current.refetch();
        await waitFor(() => expect(result.current.isError).toBe(true));
        expect(result.current.data).toEqual({ recordingFolder: '/Custom/Rec', defaultOwnerUserId: 'u-owner' });
    });
});
