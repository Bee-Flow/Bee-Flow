import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import IntegrationsAdminPanel from './IntegrationsAdminPanel';
import { authFetch } from '../../utils/helpers';

vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../../hooks/useTranslation', () => ({
    useTranslation: () => ({ t: (_key, fallback) => fallback ?? _key }),
}));
vi.mock('../licensing/LicenseContext', () => ({
    useLicenseContext: () => ({ hasFeature: () => true, hasTier: () => true }),
}));
// Heavy siblings rendered by other sections — not under test here.
vi.mock('./FeatureKillSwitches', () => ({ default: () => null }));

const OAUTH_START = '/ai/config/service-email/oauth/start';
const json = (body, ok = true) => Promise.resolve({ ok, json: async () => body });

beforeEach(() => {
    authFetch.mockReset();
    authFetch.mockImplementation((url) => {
        const u = String(url);
        if (u.includes(OAUTH_START)) return json({ url: 'https://accounts.google.com/o/oauth2/auth?x=1' });
        if (u.includes('/auth/default-integrations')) return json({ defaults: null });
        if (u.includes('/auth/organizations')) return json([]);
        if (u.includes('/ai/config')) return json({});
        if (u.includes('/mcp/servers')) return json({ servers: [] });
        return json({});
    });
});

afterEach(() => {
    vi.restoreAllMocks();
});

const openEmailSection = async () => {
    render(<IntegrationsAdminPanel activeSection="email" />);
    return screen.findByRole('button', { name: /connect google account/i });
};

describe('IntegrationsAdminPanel — service email OAuth', () => {
    // Regression: window.open returns null when a popup blocker is active (it
    // does not throw). The watchdog's only exit was `popup && popup.closed`,
    // unreachable for a null popup, so an 800ms interval and a window
    // `message` listener survived for the life of the tab — and the spinner
    // never cleared, permanently disabling the button with no explanation.
    it('clears the spinner, explains, and starts no watchdog when the popup is blocked', async () => {
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
        const addListenerSpy = vi.spyOn(window, 'addEventListener');
        vi.spyOn(window, 'open').mockReturnValue(null);

        const btn = await openEmailSection();
        await userEvent.click(btn);

        await waitFor(() => expect(screen.getByText(/popup was blocked/i)).toBeInTheDocument());
        expect(btn).not.toBeDisabled();
        expect(setIntervalSpy.mock.calls.filter(([, ms]) => ms === 800)).toHaveLength(0);
        expect(addListenerSpy.mock.calls.filter(([type]) => type === 'message')).toHaveLength(0);
    });

    it('installs the watchdog and keeps the spinner while a real popup is open', async () => {
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
        vi.spyOn(window, 'open').mockReturnValue({ closed: false });

        const btn = await openEmailSection();
        await userEvent.click(btn);

        await waitFor(() => expect(setIntervalSpy.mock.calls.filter(([, ms]) => ms === 800)).toHaveLength(1));
        expect(screen.queryByText(/popup was blocked/i)).not.toBeInTheDocument();
        expect(btn).toBeDisabled();
    });
});
