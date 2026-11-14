import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import useUserActions from './useUserActions';
import type { AdminUser } from './types';

const USER = { id: 'u1', username: 'ann', displayName: 'Ann', avatar: '/a.png', avatarType: 'image' } as AdminUser;

function setup(status: number) {
    const fetchMock = vi.fn(async () => new Response(status === 200 ? '{}' : '{"error":"no"}', { status }));
    vi.stubGlobal('fetch', fetchMock);
    const setMessage = vi.fn();
    const { result } = renderHook(() => useUserActions({
        loadData: async () => {}, setMessage, askConfirm: vi.fn(), t: ((_k: string, fb?: string) => fb ?? _k) as never,
    }));
    act(() => result.current.openEditUser(USER));
    return { result, setMessage, fetchMock };
}

describe('useUserActions avatar removal', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('clears the avatar when the server removed it', async () => {
        const { result, setMessage, fetchMock } = setup(200);
        await act(() => result.current.handleAvatarRemove());
        expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/auth/users/u1/avatar');
        expect(result.current.userData.avatar).toBe('');
        expect(setMessage).not.toHaveBeenCalled();
    });

    it('keeps the avatar and says so when the server refused', async () => {
        const { result, setMessage } = setup(500);
        await act(() => result.current.handleAvatarRemove());
        expect(result.current.userData.avatar).toBe('/a.png');
        expect(setMessage).toHaveBeenCalledWith({ type: 'error', text: 'Remove failed' });
    });
});
