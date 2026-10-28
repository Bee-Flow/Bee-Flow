import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('@/utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async () => ({ ok: true, json: async () => ({ url: 'https://accounts.example/x' }) })),
}));

import useServiceEmailActions from './useServiceEmailActions';

const post = (data: object, origin: string) =>
    window.dispatchEvent(new MessageEvent('message', { data, origin }));

describe('useServiceEmailActions connect popup message', () => {
    let props: any;
    beforeEach(() => {
        props = {
            setConnectingServiceEmail: vi.fn(), setHasServiceEmail: vi.fn(),
            setServiceEmailAddress: vi.fn(), load: vi.fn(), setSavingServiceEmail: vi.fn(),
            setShowTestEmail: vi.fn(), serviceEmailDisplayName: '', setMessage: vi.fn(),
        };
        vi.spyOn(window, 'open').mockReturnValue({ closed: false } as Window);
    });
    afterEach(() => vi.restoreAllMocks());

    const start = async () => {
        const { result } = renderHook(() => useServiceEmailActions(props));
        await act(async () => { await result.current.startServiceEmailConnect(); });
    };

    it('ignores a forged message from a foreign origin', async () => {
        await start();
        act(() => post({ type: 'service-email-oauth', ok: true, message: 'ops@evil.example' }, 'https://evil.example'));
        expect(props.setHasServiceEmail).not.toHaveBeenCalled();
        expect(props.setServiceEmailAddress).not.toHaveBeenCalled();
    });

    it('accepts the callback from the app origin and does not trust the address in it', async () => {
        await start();
        act(() => post({ type: 'service-email-oauth', ok: true, message: 'ops@evil.example' }, window.location.origin));
        expect(props.setHasServiceEmail).toHaveBeenCalledWith(true);
        expect(props.setServiceEmailAddress).not.toHaveBeenCalled();
        expect(props.load).toHaveBeenCalled();
    });
});
