import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestQueryClient } from '@/test/render';
import { AdminOrgProvider, type AdminOrgChoice } from '@/components/admin/dashboard/useAdminOrg';
import { useDesignerIntegrationAccess, USER_ACCESS } from './useDesignerIntegrationAccess';

const asked: string[] = [];

beforeEach(() => {
    asked.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input), 'http://localhost').pathname;
        asked.push(path);
        return new Response(JSON.stringify({ orgId: 'x', homeOrg: false, degraded: false, integrations: { gmail: { serverConfigured: true, inCeiling: true, available: true } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
});

afterEach(() => { vi.unstubAllGlobals(); });

function choice(over: Partial<AdminOrgChoice> = {}): AdminOrgChoice {
    return {
        isPlatformAdmin: true, orgId: null, orgName: null, organizations: [], organizationsLoaded: true,
        pending: false, homeOrganization: { id: 'home', name: 'Home' }, setOrgId: () => {}, ...over,
    };
}

function wrapperFor(value: AdminOrgChoice | null) {
    const client = makeTestQueryClient();
    return ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
            {value ? <AdminOrgProvider value={value}>{children}</AdminOrgProvider> : children}
        </QueryClientProvider>
    );
}

describe('useDesignerIntegrationAccess', () => {
    it('outside the admin dashboard: the person editing decides, and nothing is asked', () => {
        const { result } = renderHook(() => useDesignerIntegrationAccess({ systemMode: false, agentOrgId: 'org-a' }), { wrapper: wrapperFor(null) });
        expect(result.current).toBe(USER_ACCESS);
        expect(asked).toEqual([]);
    });

    it("in the dashboard: the open agent's organisation decides", async () => {
        const { result } = renderHook(() => useDesignerIntegrationAccess({ systemMode: false, agentOrgId: 'org-a' }), { wrapper: wrapperFor(choice({ orgId: 'org-b' })) });
        expect(result.current.adminMode).toBe(true);
        await waitFor(() => expect(result.current.pending).toBe(false));
        expect(asked).toEqual([expect.stringContaining('/auth/organizations/org-a/integration-availability')]);
        expect(result.current.unknown).toBe(false);
    });

    it('a new agent: the chosen organisation, else the viewer\'s own', async () => {
        renderHook(() => useDesignerIntegrationAccess({ systemMode: false, agentOrgId: null }), { wrapper: wrapperFor(choice({ orgId: 'org-b' })) });
        renderHook(() => useDesignerIntegrationAccess({ systemMode: false, agentOrgId: null }), { wrapper: wrapperFor(choice({ isPlatformAdmin: false })) });
        await waitFor(() => expect(asked).toHaveLength(2));
        expect(asked.join(' ')).toContain('/organizations/org-b/');
        expect(asked.join(' ')).toContain('/organizations/home/');
    });

    it('system agents belong to no organisation: the person editing decides', () => {
        const { result } = renderHook(() => useDesignerIntegrationAccess({ systemMode: true, agentOrgId: null }), { wrapper: wrapperFor(choice({ orgId: 'org-b' })) });
        expect(result.current).toBe(USER_ACCESS);
        expect(asked).toEqual([]);
    });
});
