import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RequiredConnectionsBanner from './RequiredConnectionsBanner';
import { authFetch } from '../../utils/helpers';

/**
 * Where the banner sends someone who still has to connect a provider.
 *
 * The link read "Settings → Integrations" and pointed at /settings?tab=integrations:
 * not an /app path, so the router opened the app home, and even its /app form
 * would have opened Preferences (the settings router reads the pathname only).
 * Bring-your-own credentials live on the personal row the nav calls
 * Connections, at /app/settings/integrations.
 */

vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../../hooks/useTranslation', () => import('@/test/useTranslationParamsMock'));

const mockedFetch = vi.mocked(authFetch);

beforeEach(() => {
    mockedFetch.mockReset();
});

describe('RequiredConnectionsBanner', () => {
    it('links to Settings → Connections at its real address', async () => {
        mockedFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ requiresConnection: [{ provider: 'google' }] }),
        } as unknown as Response);
        render(<RequiredConnectionsBanner resourceType="agent" resourceId="a1" providers={['google']} />);
        const link = await screen.findByRole('link', { name: 'Settings → Connections' });
        expect(link).toHaveAttribute('href', '/app/settings/integrations');
        expect(screen.getByText(/Connect google in/)).toBeInTheDocument();
    });

    it('renders nothing when nothing has to be connected', async () => {
        mockedFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ requiresConnection: [] }),
        } as unknown as Response);
        const { container } = render(<RequiredConnectionsBanner resourceType="agent" resourceId="a1" providers={['google']} />);
        await vi.waitFor(() => expect(mockedFetch).toHaveBeenCalled());
        expect(container).toBeEmptyDOMElement();
    });
});
