import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LinkSignInProviders from './LinkSignInProviders';

const fetchMock = vi.fn();
const status = (body: object) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
};

function renderCard() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<QueryClientProvider client={qc}><LinkSignInProviders /></QueryClientProvider>);
}

describe('LinkSignInProviders', () => {
    afterEach(() => { window.history.replaceState({}, '', '/'); vi.restoreAllMocks(); vi.unstubAllGlobals(); fetchMock.mockReset(); });

    it('offers a link for each configured provider and starts the link flow', async () => {
        status({ isGoogleConfigured: true, isOAuthConfigured: false });
        const assign = vi.fn();
        vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign, search: '' } as Location);
        renderCard();
        const button = await screen.findByRole('button', { name: 'Link Google sign-in' });
        expect(screen.queryByRole('button', { name: /Nextcloud/ })).toBeNull();
        await userEvent.setup().click(button);
        expect(assign).toHaveBeenCalledWith(expect.stringMatching(/\/auth\/login\/google\?intent=link$/));
    });

    it('renders nothing when no linkable provider is configured', async () => {
        status({});
        const { container } = renderCard();
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
        expect(container).toBeEmptyDOMElement();
    });

    it('shows the outcome the link callback returned and clears it from the address', async () => {
        status({ isGoogleConfigured: true });
        window.history.replaceState({}, '', '/app/settings?linked=google');
        renderCard();
        expect(await screen.findByRole('status')).toHaveTextContent('Google sign-in is now linked to your account.');
        expect(window.location.search).toBe('');
    });

    it('explains a sign-in that is already linked to another account', async () => {
        status({ isGoogleConfigured: true });
        window.history.replaceState({}, '', '/app/settings?error=sso_identity_taken');
        renderCard();
        expect(await screen.findByRole('status')).toHaveTextContent('already linked to another account');
    });
});
