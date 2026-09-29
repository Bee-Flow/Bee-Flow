import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import useGoogleWorkspacePicker from './useGoogleWorkspacePicker';
import { authFetch } from '../utils/helpers';

// The connect flow goes through lib/googleOAuthPopup, which takes authFetch
// as an argument — mocking utils/helpers is the single network seam for it.
vi.mock('../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

const AUTH_URL = 'https://accounts.google.com/o/oauth2/auth?client_id=x';

const OPTIONS = {
    isOpen: false,               // keep the on-open loader quiet; we drive connect() directly
    onClose: () => {},
    onFilesSelected: () => {},
    apiBase: '',
    statusPath: '/api/integrations/gmail/status',
    listPath: '/api/integrations/gmail/messages',
    listKey: 'messages',
    loadErrorMessage: 'Failed to load messages',
    exportItem: async () => ({}),
};

let statusPayload;

beforeEach(() => {
    statusPayload = { connected: false, configured: true };
    authFetch.mockReset();
    authFetch.mockResolvedValue({ ok: true, json: async () => ({ url: AUTH_URL }) });
    globalThis.fetch = vi.fn(async (url) => {
        if (String(url).includes('/status')) return { ok: true, json: async () => statusPayload };
        return { ok: true, json: async () => ({ messages: [], nextPageToken: null }) };
    });
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('useGoogleWorkspacePicker — handleConnect', () => {
    // Regression: window.open returns null (it does not throw) when a popup
    // blocker is active. The old inline watchdog polled `popup?.closed`, which
    // is undefined forever for a null popup, so its 500ms interval ran for the
    // life of the tab and the user got no feedback at all — the click was a
    // silent no-op. lib/googleOAuthPopup guards this centrally.
    it('surfaces an error and starts no watchdog when the popup is blocked', async () => {
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
        vi.spyOn(window, 'open').mockReturnValue(null);

        const { result } = renderHook(() => useGoogleWorkspacePicker(OPTIONS));
        await act(async () => { await result.current.handleConnect(); });

        expect(window.open).toHaveBeenCalledWith(AUTH_URL, expect.any(String), expect.any(String));
        expect(setIntervalSpy).not.toHaveBeenCalled();
        expect(result.current.error).toMatch(/popup/i);
    });

    it('surfaces the server error when the auth-url call fails, without opening a popup', async () => {
        authFetch.mockResolvedValue({ ok: false, json: async () => ({ error: 'google_not_configured' }) });
        const open = vi.spyOn(window, 'open');

        const { result } = renderHook(() => useGoogleWorkspacePicker(OPTIONS));
        await act(async () => { await result.current.handleConnect(); });

        expect(open).not.toHaveBeenCalled();
        expect(result.current.error).toBe('google_not_configured');
    });

    it('re-checks status and loads items once the popup reports success', async () => {
        vi.spyOn(window, 'open').mockReturnValue({ closed: false });

        const { result } = renderHook(() => useGoogleWorkspacePicker(OPTIONS));
        await act(async () => {
            const pending = result.current.handleConnect();
            await waitFor(() => expect(window.open).toHaveBeenCalled());
            statusPayload = { connected: true, configured: true, user: 'a@b.nl' };
            window.dispatchEvent(new MessageEvent('message', {
                data: { type: 'google-callback', success: true },
                origin: window.location.origin,
            }));
            await pending;
        });

        await waitFor(() => expect(result.current.status.connected).toBe(true));
        expect(globalThis.fetch.mock.calls.some(([u]) => String(u).includes('/messages'))).toBe(true);
        expect(result.current.error).toBeNull();
    });
});
