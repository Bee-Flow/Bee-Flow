import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { renderWithClient } from '@/test/render';
import TeamsConsentLinkCard from './TeamsConsentLinkCard';

const fetchMock = vi.fn();
const answer = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
    headers: new Headers({ 'content-type': 'application/json' }),
});

const URL_ = 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0/adminconsent?client_id=fixture-client&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default&redirect_uri=https%3A%2F%2Fflow.example%2Fapi%2Fintegrations%2Fmicrosoft%2Fcallback&state=fixture-state';
const AVAILABLE = {
    available: true, url: URL_, tenantId: '11111111-2222-3333-4444-555555555555', tenantSource: 'configured',
    redirectUri: 'https://flow.example/api/integrations/microsoft/callback', expiresAt: '2026-11-10T10:30:00.000Z',
    permissions: { delegated: [], application: [] },
};

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});

describe('TeamsConsentLinkCard', () => {
    it('makes the link on request, then offers to open and copy it', async () => {
        fetchMock.mockResolvedValue(answer(AVAILABLE));
        const user = userEvent.setup();
        renderWithClient(<TeamsConsentLinkCard />);
        expect(fetchMock).not.toHaveBeenCalled();
        await user.click(screen.getByRole('button', { name: 'Make the link' }));
        const open = await screen.findByRole('link', { name: 'Open' });
        expect(open.getAttribute('href')).toBe(URL_);
        expect(open.getAttribute('target')).toBe('_blank');
        expect(open.getAttribute('rel')).toContain('noopener');
        expect((screen.getByRole('textbox', { name: 'Admin consent link' }) as HTMLInputElement).value).toBe(URL_);
        expect(screen.queryByRole('button', { name: 'Make the link' })).toBeNull();
        expect(screen.getByText(`Bee Flow records the answer if it comes back before ${new Date(AVAILABLE.expiresAt).toLocaleTimeString()}. The approval itself counts at any time.`)).toBeTruthy();

        await user.click(screen.getByRole('button', { name: 'Copy link' }));
        expect(await navigator.clipboard.readText()).toBe(URL_);
        expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(String(url)).toMatch(/\/api\/teams-setup\/org\/consent-link$/);
        expect(init.method).toBe('POST');
    });

    it('no link: says why and what to do', async () => {
        fetchMock.mockResolvedValue(answer({ available: false, reason: 'tenant_unknown' }));
        const user = userEvent.setup();
        renderWithClient(<TeamsConsentLinkCard />);
        await user.click(screen.getByRole('button', { name: 'Make the link' }));
        expect(await screen.findByText('No link can be made yet.')).toBeTruthy();
        expect(screen.getByText('Bee Flow does not know which Microsoft tenant to ask.')).toBeTruthy();
        expect(screen.getByText(/Sign in to Bee Flow with Microsoft once/)).toBeTruthy();
        expect(screen.getByText('The Bee Flow platform administrator must fix this')).toBeTruthy();
        expect(screen.queryByRole('link', { name: 'Open' })).toBeNull();
    });

    it('no app registration: names the platform administrator', async () => {
        fetchMock.mockResolvedValue(answer({ available: false, reason: 'app_not_configured' }));
        const user = userEvent.setup();
        renderWithClient(<TeamsConsentLinkCard />);
        await user.click(screen.getByRole('button', { name: 'Make the link' }));
        expect(await screen.findByText('No Microsoft app registration is configured in Bee Flow.')).toBeTruthy();
        expect(screen.getByText(/Ask the platform administrator to set up the Microsoft app registration/)).toBeTruthy();
    });

    it('a refused request shows the server message', async () => {
        fetchMock.mockResolvedValue(answer({ error: 'Only organisation admins can do this', code: 'not_org_admin' }, 403));
        const user = userEvent.setup();
        renderWithClient(<TeamsConsentLinkCard />);
        await user.click(screen.getByRole('button', { name: 'Make the link' }));
        expect((await screen.findByRole('alert')).textContent).toBe('Only organisation admins can do this');
    });
});
