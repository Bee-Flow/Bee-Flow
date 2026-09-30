/**
 * The access hooks against a stubbed session: the entitlement and licence
 * queries run only for a signed-in user, the permission hooks mount none, and
 * a gate locks only once the answer has landed.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import React, { type ReactNode } from 'react';

import { useAuth } from '@/core/auth/AuthProvider';
import type { AuthStage, PermissionsResponse, User } from '@/core/auth/types';

import { fetchEntitlements, fetchLicenseInfo } from './api';
import {
    sourceOf,
    useAccess,
    useCan,
    useGate,
    useHasAnyPermission,
    useHasLicenseFeature,
    useHasPermission,
    useIsOrgAdmin,
    useIsSuperAdmin,
} from './hooks';
import type { Entitlements } from './model/types';

jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: jest.fn() }));
jest.mock('./api', () => ({ fetchEntitlements: jest.fn(), fetchLicenseInfo: jest.fn() }));

const auth = useAuth as jest.Mock;
const entitlements = fetchEntitlements as jest.MockedFunction<typeof fetchEntitlements>;
const licence = fetchLicenseInfo as jest.MockedFunction<typeof fetchLicenseInfo>;

const ADA: User = { id: 'u1', displayName: 'Ada', isAdmin: false, role: 'user', provider: 'local', orgRole: 'member' };

const DATA: Entitlements = {
    mode: 'cloud',
    tier: 'enterprise',
    superAdmin: false,
    degraded: false,
    ceiling: { core: ['automations', 'app_studio'], beta: [], integration: [] },
    effective: { core: ['automations'], beta: [], integration: [] },
    reasons: {},
    registry: [{ id: 'app_studio', kind: 'core', licenseFeature: 'apps' }],
};

function session(stage: AuthStage, permissions: string[] | null, extra: Partial<PermissionsResponse> = {}) {
    const user = 'user' in stage ? stage.user : null;
    const perms = permissions && { permissions, groups: [], organizations: [], allowedAgentTypes: [], ...extra };
    auth.mockReturnValue({ stage, user, permissions: perms });
}

function wrapper() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    return function Providers({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    };
}

/** An entitlements answer the test lets through when it is ready to look at the wait. */
function heldEntitlements(): () => Promise<void> {
    let release: (value: Entitlements) => void = () => undefined;
    entitlements.mockReturnValueOnce(new Promise<Entitlements>((resolve) => (release = resolve)));
    return async () => {
        await act(async () => release(DATA));
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    entitlements.mockResolvedValue(DATA);
    licence.mockResolvedValue({ tier: 'enterprise', source: 'license_key', features: ['automations'], serverOverride: false });
});

describe('useAccess', () => {
    it('fetches the entitlements and licence for a signed-in user, once each', async () => {
        const release = heldEntitlements();
        session({ kind: 'signed-in', user: ADA }, ['use_apps']);
        const { result } = await renderHook(() => ({ access: useAccess(), can: useCan('automations') }), {
            wrapper: wrapper(),
        });
        expect(result.current.access.entitlementsState).toBe('loading');
        expect(result.current.can).toBe(false);
        await release();
        await waitFor(() => expect(result.current.access.entitlementsState).toBe('ready'));
        await waitFor(() => expect(result.current.access.licenseState).toBe('ready'));
        expect(result.current.can).toBe(true);
        expect(result.current.access.tier).toBe('enterprise');
        expect(entitlements).toHaveBeenCalledTimes(1);
        expect(licence).toHaveBeenCalledTimes(1);
    });

    it('hands back the same snapshot until an answer changes, so gated rows do not re-render', async () => {
        const release = heldEntitlements();
        session({ kind: 'signed-in', user: ADA }, ['use_apps']);
        const { result, rerender } = await renderHook(() => useAccess(), { wrapper: wrapper() });
        await release();
        await waitFor(() => expect(result.current.licenseState).toBe('ready'));
        await waitFor(() => expect(result.current.entitlementsState).toBe('ready'));
        const first = result.current;
        await rerender({});
        expect(result.current).toBe(first);
    });

    it('asks nothing of the server before the signed-in stage', async () => {
        session({ kind: 'pending-approval', user: ADA }, null);
        const { result } = await renderHook(() => useAccess(), { wrapper: wrapper() });
        expect(result.current.hasUser).toBe(true);
        expect(result.current.entitlementsState).toBe('loading');
        expect(entitlements).not.toHaveBeenCalled();
        expect(licence).not.toHaveBeenCalled();
    });

    it('reads a degraded resolver as unavailable, and a failed fetch too', async () => {
        entitlements.mockResolvedValueOnce({ ...DATA, degraded: true });
        licence.mockRejectedValueOnce(new Error('offline'));
        session({ kind: 'signed-in', user: ADA }, []);
        const { result } = await renderHook(() => useAccess(), { wrapper: wrapper() });
        await waitFor(() => expect(result.current.entitlementsState).toBe('unavailable'));
        await waitFor(() => expect(result.current.licenseState).toBe('unavailable'));
        expect(result.current.entitlements).toBeNull();
    });
});

describe('the role and permission hooks', () => {
    it('mount no query and follow the server predicates', async () => {
        session({ kind: 'signed-in', user: ADA }, ['manage_users', 'manage_skills']);
        const { result } = await renderHook(
            () => ({
                orgAdmin: useIsOrgAdmin(),
                superAdmin: useIsSuperAdmin(),
                skills: useHasPermission('manage_skills'),
                any: useHasAnyPermission('admin_compliance', 'manage_skills'),
                compliance: useHasPermission('admin_compliance'),
            }),
            { wrapper: wrapper() },
        );
        // manage_users alone is not an org admin any more (the server's requireOrgAdmin).
        expect(result.current).toEqual({ orgAdmin: false, superAdmin: false, skills: true, any: true, compliance: false });
        expect(entitlements).not.toHaveBeenCalled();
    });

    it('an org_admin orgRole is an org admin; a super admin is both', async () => {
        session({ kind: 'signed-in', user: { ...ADA, orgRole: 'org_admin' } }, []);
        const org = await renderHook(() => [useIsOrgAdmin(), useIsSuperAdmin()], { wrapper: wrapper() });
        expect(org.result.current).toEqual([true, false]);
        session({ kind: 'signed-in', user: { ...ADA, isAdmin: true } }, null);
        const operator = await renderHook(() => [useIsOrgAdmin(), useIsSuperAdmin()], { wrapper: wrapper() });
        expect(operator.result.current).toEqual([true, true]);
    });
});

describe('useGate and useHasLicenseFeature', () => {
    it('hide while loading, then lock with the reason once the answer lands', async () => {
        const release = heldEntitlements();
        session({ kind: 'signed-in', user: ADA }, ['use_apps']);
        const { result } = await renderHook(
            () => ({ gate: useGate({ license: 'apps', lockOn: 'disable' }), licensed: useHasLicenseFeature('automations') }),
            { wrapper: wrapper() },
        );
        expect(result.current.gate).toEqual({ visible: false, locked: false, reason: 'pending' });
        await release();
        await waitFor(() => expect(result.current.gate.locked).toBe(true));
        expect(result.current.gate).toEqual({ visible: true, locked: true, reason: 'not_granted' });
        expect(result.current.licensed).toBe(true);
    });
});

describe('sourceOf', () => {
    it('keeps the last good answer beside a failed refetch', () => {
        expect(sourceOf({ data: 1, isPending: false })).toEqual({ state: 'ready', data: 1 });
        expect(sourceOf({ data: null, isPending: false })).toEqual({ state: 'unavailable', data: null });
        expect(sourceOf({ data: undefined, isPending: true })).toEqual({ state: 'loading', data: null });
    });
});
