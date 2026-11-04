import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryWrapper } from '@/test/queryWrapper';
import { useMeetingSourcesQuery } from './meetingNotesConnections';

const fetchMock = vi.fn();

const json = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
    headers: new Headers({ 'content-type': 'application/json' }),
});

function serve(answers: { talk?: unknown; gmeet?: unknown; teams?: unknown }) {
    fetchMock.mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.includes('/api/talk-notes-settings/user/me')) return json(answers.talk ?? {});
        if (u.includes('/api/gmeet-notes-settings/user/me')) return json(answers.gmeet ?? {});
        if (u.includes('/api/teams-notes-settings/user/me')) return answers.teams === undefined ? json({ error: 'nope' }, 404) : json(answers.teams);
        return json({ error: 'unexpected' }, 404);
    });
}

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});

describe('useMeetingSourcesQuery', () => {
    it('counts a Teams-only account as having an Upcoming source', async () => {
        serve({
            talk: { nextcloudConnected: false },
            gmeet: { connection: { googleConnected: false } },
            teams: { connection: { microsoftConnected: true, teamsScopesGranted: true } },
        });
        const { result } = renderHook(() => useMeetingSourcesQuery(), { wrapper: queryWrapper() });
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current).toMatchObject({ talk: false, gmeet: false, teams: true });
    });

    it('does not count Microsoft without the Teams scopes, nor a refused Teams probe', async () => {
        serve({ teams: { connection: { microsoftConnected: true, teamsScopesGranted: false } } });
        const first = renderHook(() => useMeetingSourcesQuery(), { wrapper: queryWrapper() });
        await waitFor(() => expect(first.result.current.loading).toBe(false));
        expect(first.result.current.teams).toBe(false);

        serve({ talk: { nextcloudConnected: true } });
        const second = renderHook(() => useMeetingSourcesQuery(), { wrapper: queryWrapper() });
        await waitFor(() => expect(second.result.current.loading).toBe(false));
        expect(second.result.current).toMatchObject({ talk: true, gmeet: false, teams: false });
    });
});
