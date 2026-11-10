import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryWrapper } from '@/test/queryWrapper';
import {
    isDiagnosticsRateLimited, useCreateTeamsConsentLink, useRunMyTeamsDiagnostics, useTeamsOrgOverview, useTeamsRequirements,
} from './teamsSetup';

const fetchMock = vi.fn();

const answer = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
    headers: new Headers({ 'content-type': 'application/json' }),
});

const REPORT = { level: 'user', ranAt: '2026-11-10T10:00:00.000Z', overall: 'pass', checks: [] };

/** The URL and method of the one call made. */
function onlyCall(): { url: string; method: string } {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    return { url: String(url), method: String(init?.method || 'GET') };
}

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});

describe('useTeamsRequirements', () => {
    it('reads GET /api/teams-setup/requirements', async () => {
        fetchMock.mockResolvedValue(answer({ tenantMode: 'single', redirectUris: { signIn: 'a', connect: 'b' }, delegated: [], application: [] }));
        const { result } = renderHook(() => useTeamsRequirements(), { wrapper: queryWrapper() });
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        const call = onlyCall();
        expect(call.method).toBe('GET');
        expect(call.url).toMatch(/\/api\/teams-setup\/requirements$/);
        expect(result.current.data?.tenantMode).toBe('single');
    });

    it('errors once, without retrying, when Meeting Notes is not licensed', async () => {
        fetchMock.mockResolvedValue(answer({ error: 'Feature not licensed' }, 403));
        const { result } = renderHook(() => useTeamsRequirements(), { wrapper: queryWrapper() });
        await waitFor(() => expect(result.current.isError).toBe(true));
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not ask when disabled', () => {
        renderHook(() => useTeamsRequirements(false), { wrapper: queryWrapper() });
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('useRunMyTeamsDiagnostics', () => {
    it('POSTs /api/teams-setup/me/diagnostics without a body and returns the report', async () => {
        fetchMock.mockResolvedValue(answer(REPORT));
        const { result } = renderHook(() => useRunMyTeamsDiagnostics(), { wrapper: queryWrapper() });
        let report: unknown;
        await act(async () => { report = await result.current.mutateAsync(); });
        const call = onlyCall();
        expect(call.method).toBe('POST');
        expect(call.url).toMatch(/\/api\/teams-setup\/me\/diagnostics$/);
        expect((fetchMock.mock.calls[0][1] as RequestInit).body).toBeUndefined();
        expect(report).toEqual(REPORT);
    });

    it('a 429 is recognisable as the rate limit and is not retried', async () => {
        fetchMock.mockResolvedValue(answer({ error: 'Wait a few seconds before you test again', code: 'diagnostics_rate_limited' }, 429));
        const { result } = renderHook(() => useRunMyTeamsDiagnostics(), { wrapper: queryWrapper() });
        let caught: unknown;
        await act(async () => { await result.current.mutateAsync().catch((e: unknown) => { caught = e; }); });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(isDiagnosticsRateLimited(caught)).toBe(true);
        expect(isDiagnosticsRateLimited(new Error('other'))).toBe(false);
    });

    it('an answer without checks is an error, not an empty report', async () => {
        fetchMock.mockResolvedValue(answer({ ok: true }));
        const { result } = renderHook(() => useRunMyTeamsDiagnostics(), { wrapper: queryWrapper() });
        await act(async () => { await result.current.mutateAsync().catch(() => undefined); });
        await waitFor(() => expect(result.current.isError).toBe(true));
    });
});

describe('useTeamsOrgOverview', () => {
    it('reads GET /api/teams-setup/org/overview with the window, and no organisation in the request', async () => {
        fetchMock.mockResolvedValue(answer({
            windowDays: 14, generatedAt: '2026-11-10T10:00:00.000Z', truncated: false,
            settings: { autoImport: null, autoRecordConfig: null }, checks: [],
            totals: { members: 0, connected: 0, missingPermissions: 0, needsReauth: 0, skipped: 0, failedImports: 0 }, members: [],
        }));
        const { result } = renderHook(() => useTeamsOrgOverview(14), { wrapper: queryWrapper() });
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        const call = onlyCall();
        expect(call.method).toBe('GET');
        expect(call.url).toMatch(/\/api\/teams-setup\/org\/overview\?days=14$/);
        expect(call.url).not.toMatch(/org(Id)?=/i);
    });

    it('an unreadable answer is an error', async () => {
        fetchMock.mockResolvedValue(answer({ members: 'nope' }));
        const { result } = renderHook(() => useTeamsOrgOverview(7), { wrapper: queryWrapper() });
        await waitFor(() => expect(result.current.isError).toBe(true));
    });
});

describe('useCreateTeamsConsentLink', () => {
    it('POSTs /api/teams-setup/org/consent-link and returns the answer', async () => {
        fetchMock.mockResolvedValue(answer({ available: false, reason: 'tenant_unknown' }));
        const { result } = renderHook(() => useCreateTeamsConsentLink(), { wrapper: queryWrapper() });
        let link: unknown;
        await act(async () => { link = await result.current.mutateAsync(); });
        const call = onlyCall();
        expect(call.method).toBe('POST');
        expect(call.url).toMatch(/\/api\/teams-setup\/org\/consent-link$/);
        expect(link).toEqual({ available: false, reason: 'tenant_unknown' });
    });
});
