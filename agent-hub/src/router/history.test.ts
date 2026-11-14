import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getLocation, navigate, refreshLocation, subscribeLocation, useLocation } from './history';

beforeEach(() => window.history.replaceState(null, '', '/app'));

describe('the history store', () => {
    it('pushes a new address and publishes it', () => {
        const { result } = renderHook(() => useLocation());
        expect(result.current.pathname).toBe('/app');
        act(() => navigate('/app/settings?x=1', { state: { page: 'settings' } }));
        expect(result.current).toMatchObject({ pathname: '/app/settings', search: '?x=1', state: { page: 'settings' } });
        expect(window.history.state).toEqual({ page: 'settings' });
    });

    it('does not write the same address twice, but still publishes a fresh location', () => {
        const push = vi.spyOn(window.history, 'pushState');
        const { result } = renderHook(() => useLocation());
        const before = result.current;
        act(() => navigate('/app'));
        expect(push).not.toHaveBeenCalled();
        expect(result.current).not.toBe(before);
        act(() => navigate('/app#section'));
        expect(push).not.toHaveBeenCalled();
        push.mockRestore();
    });

    it('replaces when asked, even at the same address, so the state is rewritten', () => {
        const push = vi.spyOn(window.history, 'pushState');
        navigate('/app', { replace: true, state: { page: 'agents', mark: 1 } });
        expect(push).not.toHaveBeenCalled();
        expect(window.history.state).toEqual({ page: 'agents', mark: 1 });
        push.mockRestore();
    });

    it('follows Back and Forward through popstate', async () => {
        const { result } = renderHook(() => useLocation());
        act(() => navigate('/app/cowork'));
        const moved = () => new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }));
        await act(async () => { const p = moved(); window.history.back(); await p; });
        expect(result.current.pathname).toBe('/app');
        await act(async () => { const p = moved(); window.history.forward(); await p; });
        expect(result.current.pathname).toBe('/app/cowork');
    });

    it('reads the browser while nobody listens, and the published address once someone does', () => {
        window.history.replaceState(null, '', '/app/a');
        expect(getLocation().pathname).toBe('/app/a');
        const listener = vi.fn();
        const unsubscribe = subscribeLocation(listener);
        window.history.replaceState(null, '', '/app/b');
        expect(getLocation().pathname).toBe('/app/a');
        refreshLocation();
        expect(listener).toHaveBeenCalledTimes(1);
        expect(getLocation().pathname).toBe('/app/b');
        unsubscribe();
    });
});
