/**
 * The boot probe and a /auth/user that is not a session: what the connector
 * sign-in answered decides the screen, so the hook has to hand it on. A
 * session carries the server's answer on organisation administration.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthSession } from './useAuthSession';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function setters() {
    return {
        setDeploymentMode: vi.fn(),
        setOrgLogo: vi.fn(),
        setEncryptionState: vi.fn(),
        setNoOrganization: vi.fn(),
        setPendingApproval: vi.fn(),
        setMfaSetupRequired: vi.fn(),
        setNcOnboardingState: vi.fn(),
        setNcOrgName: vi.fn(),
        setPendingNcBinding: vi.fn(),
        setUser: vi.fn(),
        setIsAuthenticated: vi.fn(),
        setBootstrapDiagnostics: vi.fn(),
        setSignInRefusal: vi.fn(),
        setServerAvailable: vi.fn(),
        setIsLoading: vi.fn(),
    };
}

/** Answer each boot call by the last part of its address. */
function serve(routes: Record<string, () => Response>) {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const hit = Object.keys(routes).find((suffix) => url.endsWith(suffix));
        calls.push(url);
        return hit ? routes[hit]() : json(404, {});
    }));
    return calls;
}

async function boot(routes: Record<string, () => Response>) {
    const calls = serve(routes);
    const s = setters();
    renderHook(() => useAuthSession(s));
    await waitFor(() => expect(s.setIsLoading).toHaveBeenCalledWith(false));
    return { s, calls };
}

/** A member session of orgA whose my-permissions answers `perms`. */
const memberSession = (perms: Record<string, unknown>) => ({
    '/auth/setup-status': () => json(200, { deploymentMode: 'self-hosted' }),
    '/auth/user': () => json(200, { authenticated: true, user: { id: 'u1', orgRole: 'member', organizationId: 'orgA' } }),
    '/auth/my-permissions': () => json(200, perms),
});

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('useAuthSession at boot', () => {
    it('403 NC_ONBOARDING_PENDING on /auth/user is the pending state, without asking the connector why', async () => {
        const pending = () => json(403, { error: 'Setup in progress', code: 'NC_ONBOARDING_PENDING' });
        const { s, calls } = await boot({
            '/auth/setup-status': pending,
            '/auth/user': pending,
            '/auth/my-permissions': pending,
        });
        expect(s.setNcOnboardingState).toHaveBeenCalledWith('pending');
        expect(s.setIsAuthenticated).not.toHaveBeenCalled();
        expect(s.setSignInRefusal).not.toHaveBeenCalled();
        expect(s.setServerAvailable).toHaveBeenCalledWith(true);
        expect(calls.some((u) => u.endsWith('/setup/diagnostics'))).toBe(false);
    });

    it('another refusal is handed on with its sentence, and the connector is asked for its state', async () => {
        const { s, calls } = await boot({
            '/auth/setup-status': () => json(200, {}),
            '/auth/user': () => json(403, { error: 'Ask your Bee Flow administrator to invite you.' }),
            '/auth/my-permissions': () => json(403, {}),
            '/setup/diagnostics': () => json(200, { state: 'ready' }),
        });
        expect(s.setSignInRefusal).toHaveBeenCalledWith({ status: 403, code: null, message: 'Ask your Bee Flow administrator to invite you.' });
        expect(s.setNcOnboardingState).not.toHaveBeenCalled();
        expect(s.setIsAuthenticated).not.toHaveBeenCalled();
        expect(s.setBootstrapDiagnostics).toHaveBeenCalledWith({ state: 'ready' });
        expect(calls.some((u) => u.endsWith('/setup/diagnostics'))).toBe(true);
    });

    it('a 502 before the connector has its key keeps asking for diagnostics (the e-mail verification screen)', async () => {
        const { s } = await boot({
            '/auth/setup-status': () => json(502, { error: 'Tenant key not configured' }),
            '/auth/user': () => json(502, { error: 'Tenant key not configured' }),
            '/auth/my-permissions': () => json(502, {}),
            '/setup/diagnostics': () => json(200, { state: 'awaiting_email_verification' }),
        });
        expect(s.setSignInRefusal).toHaveBeenCalledWith({ status: 502, code: null, message: null });
        expect(s.setBootstrapDiagnostics).toHaveBeenCalledWith({ state: 'awaiting_email_verification' });
    });

    it('a session is applied as before', async () => {
        const { s } = await boot({
            '/auth/setup-status': () => json(200, { deploymentMode: 'self-hosted' }),
            '/auth/user': () => json(200, { authenticated: true, user: { id: 'u1' }, ncOnboardingPending: true }),
            '/auth/my-permissions': () => json(200, { permissions: ['all'] }),
        });
        expect(s.setIsAuthenticated).toHaveBeenCalledWith(true);
        expect(s.setNcOnboardingState).toHaveBeenCalledWith('pending');
        expect(s.setSignInRefusal).not.toHaveBeenCalled();
        expect(s.setDeploymentMode).toHaveBeenCalledWith('self-hosted');
    });
});

describe('useAuthSession and the home organisation', () => {
    // The admin screens show their organisation-admin sections on the server's
    // strict answer, which also counts an admin group of the home organisation.
    it('carries the server answer on whether the viewer administers their home organisation', async () => {
        const { s } = await boot(memberSession({ permissions: [], isHomeOrgAdmin: true }));
        expect(s.setUser.mock.calls.at(-1)?.[0]).toMatchObject({ id: 'u1', isHomeOrgAdmin: true });
    });

    it('counts nobody as one when the answer does not say so', async () => {
        const { s } = await boot(memberSession({ permissions: [] }));
        expect(s.setUser.mock.calls.at(-1)?.[0]).toMatchObject({ isHomeOrgAdmin: false });
    });
});
