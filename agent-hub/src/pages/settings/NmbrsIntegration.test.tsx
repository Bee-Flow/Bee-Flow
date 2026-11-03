// Settings → NMBRS. Pinned: a saved SOAP connection shows the SOAP retirement
// date with the way over; switching to REST asks for the subscription key and
// the Nmbrs app and saves them in one request, keeping the SOAP fields; a REST
// connection shows the redirect address to register and a connect button.
// The network is the global fetch, stubbed per case.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '@/test/queryWrapper';
import NMBRSIntegration from './NmbrsIntegration';

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
let statusBody: Record<string, unknown> = {};

beforeEach(() => {
    calls = [];
    statusBody = { mode: 'rest', configured: true, connected: false, needsReauth: false, redirectUri: 'https://app.example/api/integrations/nmbrs/callback' };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        const body = String(url).endsWith('/api/integrations/nmbrs/status') ? statusBody : { success: true };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
});
afterEach(() => { vi.unstubAllGlobals(); });

async function renderCard(props: Partial<React.ComponentProps<typeof NMBRSIntegration>> = {}) {
    const user = userEvent.setup();
    render(withQueryClient(<NMBRSIntegration onSaved={vi.fn()} last {...props} />));
    await user.click(screen.getByRole('button', { name: /^NMBRS/ }));
    return user;
}

describe('NMBRSIntegration', () => {
    it('warns a saved SOAP connection that Nmbrs retires SOAP, with the way to REST', async () => {
        await renderCard({ hasNmbrsConfig: true, apiMode: 'soap', subdomain: 'acme', email: 'me@acme.nl' });
        expect(screen.getByRole('button', { name: /^NMBRS/ })).toHaveTextContent(/SOAP ends/);
        expect(screen.getByRole('status')).toHaveTextContent(/retires the SOAP API/);
        expect(screen.getByRole('status')).toHaveTextContent(/Switch this connection to the REST API/);
    });

    it('switches a SOAP connection to REST: the app settings go in one save, the SOAP fields stay', async () => {
        const user = await renderCard({ hasNmbrsConfig: true, apiMode: 'soap', subdomain: 'acme', email: 'me@acme.nl' });
        await user.selectOptions(screen.getByRole('combobox', { name: 'API' }), 'rest');
        await user.type(screen.getByLabelText('Subscription key'), 'sub-key-0123456789');
        await user.type(screen.getByLabelText('Client ID'), 'client-id');
        await user.type(screen.getByPlaceholderText('Client secret'), 'client-secret-value');
        await user.click(screen.getByRole('button', { name: /save/i }));
        await waitFor(() => expect(calls.some((c) => c.url.endsWith('/ai/user-settings'))).toBe(true));
        const save = calls.find((c) => c.url.endsWith('/ai/user-settings'))!;
        expect(JSON.parse(String(save.init?.body))).toEqual({
            nmbrsApiMode: 'rest', nmbrsEnv: 'production', nmbrsSubdomain: 'acme', nmbrsEmail: 'me@acme.nl',
            nmbrsSubscriptionKey: 'sub-key-0123456789', nmbrsClientId: 'client-id', nmbrsClientSecret: 'client-secret-value',
        });
    });

    it('refuses a first REST save without the app settings', async () => {
        const user = await renderCard({ apiMode: 'soap' });
        await user.selectOptions(screen.getByRole('combobox', { name: 'API' }), 'rest');
        await user.type(screen.getByLabelText('Subscription key'), 'sub-key-0123456789');
        await user.click(screen.getByRole('button', { name: /save/i }));
        expect(await screen.findByText(/Enter the subscription key, client ID and client secret/)).toBeInTheDocument();
        expect(calls.some((c) => c.url.endsWith('/ai/user-settings'))).toBe(false);
    });

    it('a saved REST connection shows the redirect address and a connect button', async () => {
        await renderCard({ hasNmbrsConfig: true, hasNmbrsSubscriptionKey: true, hasNmbrsClient: true, apiMode: 'rest' });
        expect(screen.getByRole('button', { name: /^NMBRS/ })).not.toHaveTextContent(/SOAP ends/);
        expect(await screen.findByText(/https:\/\/app\.example\/api\/integrations\/nmbrs\/callback/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Connect with NMBRS' })).toBeInTheDocument();
        expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
});
