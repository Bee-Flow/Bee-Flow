import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useUserManagementData from './useUserManagementData';

const fetchMock = vi.fn();

const json = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
    headers: new Headers({ 'content-type': 'application/json' }),
});

const ROWS: Record<string, unknown> = {
    '/auth/users': [{ id: 'u1', username: 'jan', organizationId: 'org-a' }],
    '/auth/groups': [{ id: 'g1', name: 'Finance', organizationId: 'org-a' }],
    '/auth/roles': [{ id: 'reader', name: 'Reader', permissions: [] }],
    '/auth/permissions': [{ id: 'manage_users', name: 'Manage users' }],
    '/auth/organizations': [{ id: 'org-a', name: 'Org A' }],
};

/** The path and query of every request the hook sent, sorted. */
function requested(): string[] {
    return fetchMock.mock.calls.map(([url]) => {
        const u = new URL(String(url), 'http://x');
        return `${u.pathname}${u.search}`;
    }).sort();
}

beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => {
        const path = new URL(String(url), 'http://x').pathname;
        return path in ROWS ? json(ROWS[path]) : json({ error: 'not found' }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('useUserManagementData', () => {
    it('without options asks the unscoped lists and the role table', async () => {
        const { result } = renderHook(() => useUserManagementData());
        await waitFor(() => expect(result.current.roles).toHaveLength(1));
        expect(requested()).toEqual([
            '/auth/groups', '/auth/organizations', '/auth/permissions', '/auth/roles', '/auth/users',
        ]);
    });

    it('for a platform admin asks the admin-scoped lists and the role table', async () => {
        const currentUser = { id: 'root', role: 'admin', permissions: [] };
        const { result } = renderHook(() => useUserManagementData({ currentUser }));
        await waitFor(() => expect(result.current.roles).toHaveLength(1));
        expect(requested()).toEqual([
            '/auth/groups?scope=admin', '/auth/organizations?scope=admin', '/auth/permissions', '/auth/roles', '/auth/users?scope=admin',
        ]);
        expect(result.current.users.map(u => u.id)).toEqual(['u1']);
    });

    it('for an organisation admin never asks the role table and leaves roles empty', async () => {
        // 'all' is not a platform layer: it does not open the role table either.
        const currentUser = { id: 'me', role: 'user', isAdmin: false, permissions: ['all', 'manage_users'] };
        const { result } = renderHook(() => useUserManagementData({ currentUser }));
        await waitFor(() => expect(result.current.organizations).toHaveLength(1));
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(requested()).toEqual([
            '/auth/groups?scope=admin', '/auth/organizations?scope=admin', '/auth/permissions', '/auth/users?scope=admin',
        ]);
        expect(result.current.roles).toEqual([]);
        expect(result.current.users.map(u => u.id)).toEqual(['u1']);
        expect(result.current.groups.map(g => g.id)).toEqual(['g1']);
    });

    it('a refused admin-scoped list leaves that list empty and the others filled', async () => {
        fetchMock.mockImplementation(async (url: string) => {
            const path = new URL(String(url), 'http://x').pathname;
            if (path === '/auth/users') return json({ error: 'Organization admin access required', code: 'org_admin_required' }, 403);
            return path in ROWS ? json(ROWS[path]) : json({ error: 'not found' }, 404);
        });
        const { result } = renderHook(() => useUserManagementData({ currentUser: { id: 'me', role: 'user' } }));
        await waitFor(() => expect(result.current.groups).toHaveLength(1));
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.users).toEqual([]);
        expect(result.current.message).toBeNull();
        expect(result.current.notOrgAdmin).toBe(true);
    });

    it('a user list that loads, or an unscoped one, is not a refusal', async () => {
        const scoped = renderHook(() => useUserManagementData({ currentUser: { id: 'me', role: 'user' } }));
        await waitFor(() => expect(scoped.result.current.users).toHaveLength(1));
        expect(scoped.result.current.notOrgAdmin).toBe(false);

        fetchMock.mockImplementation(async () => json({ error: 'Permission required to view users' }, 403));
        const unscoped = renderHook(() => useUserManagementData());
        await waitFor(() => expect(requested().filter(u => u === '/auth/users')).toHaveLength(1));
        await waitFor(() => expect(unscoped.result.current.loading).toBe(false));
        expect(unscoped.result.current.notOrgAdmin).toBe(false);
    });
});
