import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthSession } from './useAuthSession';

const fetchMock = vi.fn();

const json = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
    headers: new Headers({ 'content-type': 'application/json' }),
});

/** The three boot reads; my-permissions answers `perms`. */
function serve(perms: Record<string, unknown>) {
    fetchMock.mockImplementation(async (url: string) => {
        const path = new URL(String(url), 'http://x').pathname;
        if (path.endsWith('/auth/setup-status')) return json({ deploymentMode: 'self-hosted' });
        if (path.endsWith('/auth/user')) return json({ authenticated: true, user: { id: 'u1', orgRole: 'member', organizationId: 'orgA' } });
        if (path.endsWith('/auth/my-permissions')) return json(perms);
        return json({}, 404);
    });
}

function setters() {
    return {
        setDeploymentMode: vi.fn(), setOrgLogo: vi.fn(), setEncryptionState: vi.fn(), setNoOrganization: vi.fn(),
        setPendingApproval: vi.fn(), setMfaSetupRequired: vi.fn(), setNcOnboardingState: vi.fn(), setNcOrgName: vi.fn(),
        setPendingNcBinding: vi.fn(), setUser: vi.fn(), setIsAuthenticated: vi.fn(), setBootstrapDiagnostics: vi.fn(),
        setServerAvailable: vi.fn(), setIsLoading: vi.fn(),
    };
}

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('useAuthSession', () => {
    // The admin screens show their organisation-admin sections on the server's
    // strict answer, which also counts an admin group of the home organisation.
    it('carries the server answer on whether the viewer administers their home organisation', async () => {
        serve({ permissions: [], isHomeOrgAdmin: true });
        const s = setters();
        renderHook(() => useAuthSession(s));
        await waitFor(() => expect(s.setUser).toHaveBeenCalled());
        expect(s.setUser.mock.calls.at(-1)?.[0]).toMatchObject({ id: 'u1', isHomeOrgAdmin: true });
    });

    it('counts nobody as one when the answer does not say so', async () => {
        serve({ permissions: [] });
        const s = setters();
        renderHook(() => useAuthSession(s));
        await waitFor(() => expect(s.setUser).toHaveBeenCalled());
        expect(s.setUser.mock.calls.at(-1)?.[0]).toMatchObject({ isHomeOrgAdmin: false });
    });

    // The admin dashboard names the organisation an organisation admin works on.
    it('carries the home organisation and its name, and null when the answer has none', async () => {
        serve({ permissions: [], homeOrganization: { id: 'orgA', name: 'Example Org' } });
        const s = setters();
        renderHook(() => useAuthSession(s));
        await waitFor(() => expect(s.setUser).toHaveBeenCalled());
        expect(s.setUser.mock.calls.at(-1)?.[0]).toMatchObject({ homeOrganization: { id: 'orgA', name: 'Example Org' } });

        serve({ permissions: [] });
        const other = setters();
        renderHook(() => useAuthSession(other));
        await waitFor(() => expect(other.setUser).toHaveBeenCalled());
        expect(other.setUser.mock.calls.at(-1)?.[0]).toMatchObject({ homeOrganization: null });
    });
});
