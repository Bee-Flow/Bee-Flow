// Settings → 2BA. Pinned: a first password save needs the client and the
// account and sends them in one request; the test shows the 2BA company and
// condition database; a saved "Sign in with 2BA" connection shows the redirect
// address and the sign-in button. The network is the global fetch, stubbed per case.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '@/test/queryWrapper';
import TwobaIntegration from './TwobaIntegration';

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
let statusBody: Record<string, unknown> = {};
let testBody: Record<string, unknown> = {};

beforeEach(() => {
    calls = [];
    statusBody = { mode: 'authorization_code', configured: true, connected: false, needsReauth: false, redirectUri: 'https://app.example/api/integrations/twoba/callback' };
    testBody = { ok: true, companyName: 'Example Company BV', databaseName: 'Main' };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        const u = String(url);
        const body = u.endsWith('/api/integrations/twoba/status') ? statusBody : u.endsWith('/ai/twoba/test') ? testBody : { success: true };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
});
afterEach(() => { vi.unstubAllGlobals(); });

async function renderCard(props: Partial<React.ComponentProps<typeof TwobaIntegration>> = {}) {
    const user = userEvent.setup();
    render(withQueryClient(<TwobaIntegration onSaved={vi.fn()} last {...props} />));
    await user.click(screen.getByRole('button', { name: /^2BA/ }));
    return user;
}

const bodyOf = (path: string) => JSON.parse(String(calls.find((c) => c.url.endsWith(path))?.init?.body));

describe('TwobaIntegration', () => {
    it('refuses a first password save without the account', async () => {
        const user = await renderCard();
        await user.type(screen.getByLabelText('Client id'), 'client-1');
        await user.type(screen.getByLabelText('Client secret'), 'secret-1');
        await user.click(screen.getByRole('button', { name: /save/i }));
        expect(await screen.findByText(/Enter the client id, the client secret, the user name and the password/)).toBeInTheDocument();
        expect(calls.some((c) => c.url.endsWith('/ai/user-settings'))).toBe(false);
    });

    it('saves the client and the 2BA account in one request', async () => {
        const user = await renderCard();
        await user.type(screen.getByLabelText('Client id'), 'client-1');
        await user.type(screen.getByLabelText('Client secret'), 'secret-1');
        await user.type(screen.getByLabelText('2BA user name'), 'buyer');
        await user.type(screen.getByLabelText('Password'), 'pass word');
        await user.click(screen.getByRole('button', { name: /save/i }));
        await waitFor(() => expect(calls.some((c) => c.url.endsWith('/ai/user-settings'))).toBe(true));
        expect(bodyOf('/ai/user-settings')).toEqual({
            twobaAuthMode: 'password', twobaClientId: 'client-1', twobaClientSecret: 'secret-1', twobaUsername: 'buyer', twobaPassword: 'pass word',
        });
    });

    it('the test shows the 2BA company and the condition database', async () => {
        const user = await renderCard({ hasTwobaConfig: true, authMode: 'password', username: 'buyer' });
        await user.click(screen.getByRole('button', { name: 'Test connection' }));
        expect(await screen.findByText('Connected as Example Company BV, condition database Main.')).toBeInTheDocument();
        expect(bodyOf('/ai/twoba/test')).toEqual({ twobaAuthMode: 'password' });
    });

    it('a saved "Sign in with 2BA" connection shows the redirect address and the sign-in button, no password fields', async () => {
        await renderCard({ hasTwobaConfig: true, authMode: 'authorization_code' });
        expect(await screen.findByText(/https:\/\/app\.example\/api\/integrations\/twoba\/callback/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Sign in with 2BA' })).toBeInTheDocument();
        expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    });
});
