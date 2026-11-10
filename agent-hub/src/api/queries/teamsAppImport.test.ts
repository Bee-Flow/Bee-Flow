import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryWrapper } from '@/test/queryWrapper';
import { appImportErrorCode, useRunTeamsAppImportDiagnostics, useSaveTeamsAppImport, useTeamsAppImport } from './teamsAppImport';

const fetchMock = vi.fn();

const answer = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
    headers: new Headers({ 'content-type': 'application/json' }),
});

const STATE = {
    settings: { enabled: false, coverage: 'selected', selectedUserIds: [], tenantId: null, enabledAt: null, enabledBy: null, updatedAt: null },
    availability: { reason: 'ok', tenantId: '11111111-2222-3333-4444-555555555555', source: 'directory_binding' },
    counts: { eligible: 2, covered: 0, withoutIdentity: 1, otherTenant: 0, withoutAccess: 0, notSelected: 1 },
};
const REPORT = { level: 'org_app', ranAt: '2026-11-10T10:00:00.000Z', overall: 'warn', checks: [] };

/** The URL, method and parsed body of the one call made. */
function onlyCall(): { url: string; method: string; body: unknown } {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    return { url: String(url), method: String(init?.method || 'GET'), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) };
}

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});

describe('useTeamsAppImport', () => {
    it('reads GET /api/teams-setup/org/app-import, with no organisation in the request', async () => {
        fetchMock.mockResolvedValue(answer(STATE));
        const { result } = renderHook(() => useTeamsAppImport(), { wrapper: queryWrapper() });
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        const call = onlyCall();
        expect(call.method).toBe('GET');
        expect(call.url).toMatch(/\/api\/teams-setup\/org\/app-import$/);
        expect(result.current.data?.availability.reason).toBe('ok');
    });

    it('an unreadable answer is an error, not a default state', async () => {
        fetchMock.mockResolvedValue(answer({ settings: {} }));
        const { result } = renderHook(() => useTeamsAppImport(), { wrapper: queryWrapper() });
        await waitFor(() => expect(result.current.isError).toBe(true));
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not ask when disabled', () => {
        renderHook(() => useTeamsAppImport(false), { wrapper: queryWrapper() });
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('useSaveTeamsAppImport', () => {
    it('PUTs exactly enabled, coverage and selectedUserIds', async () => {
        fetchMock.mockResolvedValue(answer({ ...STATE, settings: { ...STATE.settings, enabled: true, selectedUserIds: ['u1'] } }));
        const { result } = renderHook(() => useSaveTeamsAppImport(), { wrapper: queryWrapper() });
        let saved: unknown;
        await act(async () => {
            saved = await result.current.mutateAsync({ enabled: true, coverage: 'selected', selectedUserIds: ['u1'], extra: 'x' } as never);
        });
        const call = onlyCall();
        expect(call.method).toBe('PUT');
        expect(call.url).toMatch(/\/api\/teams-setup\/org\/app-import$/);
        expect(call.body).toEqual({ enabled: true, coverage: 'selected', selectedUserIds: ['u1'] });
        expect((saved as typeof STATE).settings.enabled).toBe(true);
    });

    it('a refusal carries its code and is not retried', async () => {
        fetchMock.mockResolvedValue(answer({ error: '2 selected users are not members', code: 'not_a_member' }, 400));
        const { result } = renderHook(() => useSaveTeamsAppImport(), { wrapper: queryWrapper() });
        let caught: unknown;
        await act(async () => {
            await result.current.mutateAsync({ enabled: true, coverage: 'selected', selectedUserIds: ['x'] }).catch((e: unknown) => { caught = e; });
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(appImportErrorCode(caught)).toBe('not_a_member');
        expect(appImportErrorCode(new Error('other'))).toBeNull();
    });
});

describe('useRunTeamsAppImportDiagnostics', () => {
    it('POSTs /api/teams-setup/org/app-import/diagnostics with the probe member', async () => {
        fetchMock.mockResolvedValue(answer(REPORT));
        const { result } = renderHook(() => useRunTeamsAppImportDiagnostics(), { wrapper: queryWrapper() });
        let report: unknown;
        await act(async () => { report = await result.current.mutateAsync({ probeUserId: 'u2' }); });
        const call = onlyCall();
        expect(call.method).toBe('POST');
        expect(call.url).toMatch(/\/api\/teams-setup\/org\/app-import\/diagnostics$/);
        expect(call.body).toEqual({ probeUserId: 'u2' });
        expect(report).toEqual(REPORT);
    });

    it('sends an empty body when no probe member is chosen', async () => {
        fetchMock.mockResolvedValue(answer(REPORT));
        const { result } = renderHook(() => useRunTeamsAppImportDiagnostics(), { wrapper: queryWrapper() });
        await act(async () => { await result.current.mutateAsync({}); });
        expect(onlyCall().body).toEqual({});
    });

    it('an answer without checks is an error', async () => {
        fetchMock.mockResolvedValue(answer({ ok: true }));
        const { result } = renderHook(() => useRunTeamsAppImportDiagnostics(), { wrapper: queryWrapper() });
        await act(async () => { await result.current.mutateAsync({}).catch(() => undefined); });
        await waitFor(() => expect(result.current.isError).toBe(true));
    });
});
