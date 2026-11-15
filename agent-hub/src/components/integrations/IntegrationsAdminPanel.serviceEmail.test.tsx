import { screen, waitFor } from '@testing-library/react';
import { renderWithClient as render } from '@/test/render';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import IntegrationsAdminPanel from './IntegrationsAdminPanel';
import { Toaster } from '@/components/shared/Toast';
import { authFetch } from '../../utils/helpers';
import { asMock, partial } from '@/test/mocks';

vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../../hooks/useTranslation', () => import('@/test/useTranslationMock'));
const enterprise = vi.hoisted(() => ({ on: true }));
vi.mock('../licensing/LicenseContext', () => ({
    useLicenseContext: () => ({ hasFeature: () => true, hasTier: () => enterprise.on }),
}));

const OAUTH_START = '/ai/config/service-email/oauth/start';
const json = (body: unknown, ok = true) => Promise.resolve({ ok, json: async () => body });

beforeEach(() => {
    enterprise.on = true;
    asMock(authFetch).mockReset();
    asMock(authFetch).mockImplementation((url: string) => {
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
    // A section's message is said as a toast.
    render(<><Toaster /><IntegrationsAdminPanel activeSection="email" /></>);
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
        vi.spyOn(window, 'open').mockReturnValue(partial<Window>({ closed: false }));

        const btn = await openEmailSection();
        await userEvent.click(btn);

        await waitFor(() => expect(setIntervalSpy.mock.calls.filter(([, ms]) => ms === 800)).toHaveLength(1));
        expect(screen.queryByText(/popup was blocked/i)).not.toBeInTheDocument();
        expect(btn).toBeDisabled();
    });
});

describe('IntegrationsAdminPanel — section navigation', () => {
    it('lists the Platform services sections in a named navigation and marks the one from the URL', async () => {
        render(<IntegrationsAdminPanel activeSection="email" />);
        const nav = await screen.findByRole('navigation', { name: 'Platform services' });
        expect(nav).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Email' })).toHaveAttribute('aria-current', 'page');
        expect(screen.getByRole('button', { name: 'Defaults for new organisations' })).not.toHaveAttribute('aria-current');
        // The feature switches moved to Licence & features, the search provider to AI configuration.
        expect(screen.queryByRole('button', { name: 'Features' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Search' })).not.toBeInTheDocument();
    });

    it('navigates to admin/integrations/<id> when a section is clicked', async () => {
        const onNavigate = vi.fn();
        render(<IntegrationsAdminPanel activeSection="defaults" onNavigate={onNavigate} />);
        await userEvent.click(await screen.findByRole('button', { name: 'Email' }));
        expect(onNavigate).toHaveBeenCalledWith('admin/integrations/email');
    });

    it('offers only the sections a mount names, without the section column (the dashboard\'s Platform services)', async () => {
        render(<IntegrationsAdminPanel sections={['defaults', 'email']} activeSection="features" />);
        // A section it does not offer (Features moved to Licence & features) opens its first one.
        expect(await screen.findByRole('button', { name: 'Turn all on' })).toBeInTheDocument();
        expect(screen.queryByRole('navigation', { name: 'Platform services' })).not.toBeInTheDocument();
    });

    it('still renders the search provider for a mount that names it', async () => {
        render(<IntegrationsAdminPanel sections={['search']} activeSection="search" />);
        expect((await screen.findAllByText('Search Provider')).length).toBeGreaterThan(0);
    });
});

describe('IntegrationsAdminPanel — connected apps', () => {
    it('keeps the Google Maps key on Community, without the Enterprise apps', async () => {
        enterprise.on = false;
        render(<IntegrationsAdminPanel sections={['connected-apps']} activeSection="connected-apps" />);
        expect(await screen.findByText('Google Maps')).toBeInTheDocument();
        expect(screen.queryByText(/LinkedIn/)).not.toBeInTheDocument();
        expect(screen.queryByText(/Withings/)).not.toBeInTheDocument();
    });

    it('drops the Azure OpenAI embedding model (now under Search & retrieval)', async () => {
        render(<IntegrationsAdminPanel sections={['connected-apps']} activeSection="connected-apps" />);
        expect(await screen.findByText('Google Maps')).toBeInTheDocument();
        expect(screen.getByText(/Document Intelligence/, { selector: 'h4 *, h4' })).toBeInTheDocument();
        expect(screen.queryByText(/Azure OpenAI Embeddings/)).not.toBeInTheDocument();
    });

    it('says a failed Maps key save instead of swallowing it', async () => {
        asMock(authFetch).mockImplementation((url: string, init?: RequestInit) => {
            const u = String(url);
            if (u.includes('/ai/config') && init?.method === 'POST') return Promise.resolve({ ok: false, status: 400, json: async () => ({ error: 'bad key' }) });
            if (u.includes('/auth/default-integrations')) return json({ defaults: null });
            if (u.includes('/mcp/servers')) return json({ servers: [] });
            return json({});
        });
        const user = userEvent.setup();
        render(<><Toaster /><IntegrationsAdminPanel sections={['connected-apps']} activeSection="connected-apps" /></>);
        await user.type(await screen.findByLabelText('Google Maps API key'), 'k-123');
        await user.click(screen.getAllByRole('button', { name: /Save/ })[0]);
        expect(await screen.findByText('Could not save the Google Maps key')).toBeInTheDocument();
    });
});
