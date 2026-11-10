import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import React from 'react';
import { renderWithClient } from '@/test/render';
import TeamsSetupGuide from './TeamsSetupGuide';

const fetchMock = vi.fn();
const answer = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
    headers: new Headers({ 'content-type': 'application/json' }),
});

const REQUIREMENTS = {
    tenantMode: 'single',
    redirectUris: { signIn: 'https://flow.example/auth/callback/microsoft', connect: 'https://flow.example/api/integrations/microsoft/callback' },
    delegated: [
        { name: 'Calendars.ReadWrite', kind: 'delegated', option: 'A', role: 'required', adminConsent: false, purpose: 'calendar' },
        { name: 'OnlineMeetingRecording.Read.All', kind: 'delegated', option: 'A', role: 'required', adminConsent: true, purpose: 'recordings' },
        { name: 'Mail.Read', kind: 'delegated', option: 'A', role: 'requested', adminConsent: false, purpose: 'mail' },
    ],
    application: [
        { name: 'OnlineMeetings.Read.All', kind: 'application', option: 'B', role: 'required', adminConsent: true, purpose: 'meetings' },
    ],
};

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});

describe('TeamsSetupGuide', () => {
    it('explains both options, what is not supported, and who does each step', async () => {
        fetchMock.mockResolvedValue(answer(REQUIREMENTS));
        renderWithClient(<TeamsSetupGuide />);
        expect(screen.getByText('Set up Teams meeting notes')).toBeTruthy();
        const a = screen.getByTestId('teams-setup-option-a');
        expect(within(a).getByText('Per organiser (delegated permissions)')).toBeTruthy();
        expect(within(a).getByText(/Grant admin consent\. Use the admin consent link below/)).toBeTruthy();
        expect(within(a).getByText('Microsoft Entra administrator')).toBeTruthy();
        expect(within(a).getByText('Microsoft Teams administrator')).toBeTruthy();
        expect(within(a).getByText('Each organiser')).toBeTruthy();
        const b = screen.getByTestId('teams-setup-option-b');
        expect(within(b).getByText('Organisation-wide (application permissions)')).toBeTruthy();
        expect(within(b).getByText(/Create a Teams application access policy/)).toBeTruthy();
        expect(screen.getByText('Not supported')).toBeTruthy();
        const docs = screen.getByRole('link', { name: /Read the full setup guide/ });
        expect(docs.getAttribute('href')).toBe('https://docs.beeflow.ai/integrations/teams-meeting-notes');
        expect(docs.getAttribute('rel')).toContain('noopener');
    });

    it('lists the permissions from the server with role, purpose and admin-consent mark, and both redirect URIs', async () => {
        fetchMock.mockResolvedValue(answer(REQUIREMENTS));
        renderWithClient(<TeamsSetupGuide />);
        const recordings = (await screen.findByText('OnlineMeetingRecording.Read.All')).closest('li') as HTMLElement;
        expect(within(recordings).getByText('Required')).toBeTruthy();
        expect(within(recordings).getByText('Meeting recordings')).toBeTruthy();
        expect(within(recordings).getByText('needs admin consent')).toBeTruthy();
        const calendar = screen.getByText('Calendars.ReadWrite').closest('li') as HTMLElement;
        expect(within(calendar).queryByText('needs admin consent')).toBeNull();
        expect(within(screen.getByText('Mail.Read').closest('li') as HTMLElement).getByText('Asked for by Bee Flow')).toBeTruthy();
        expect(within(screen.getByTestId('teams-setup-option-b')).getByText('OnlineMeetings.Read.All')).toBeTruthy();
        expect(screen.getByText('https://flow.example/auth/callback/microsoft')).toBeTruthy();
        expect(screen.getByText('https://flow.example/api/integrations/microsoft/callback')).toBeTruthy();
        const [url] = fetchMock.mock.calls[0] as [string];
        expect(String(url)).toMatch(/\/api\/teams-setup\/requirements$/);
    });

    it('without requirements (refused) the steps still show, without permission lists', async () => {
        fetchMock.mockResolvedValue(answer({ error: 'no' }, 403));
        renderWithClient(<TeamsSetupGuide />);
        expect(screen.getByText('Set up Teams meeting notes')).toBeTruthy();
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
        expect(screen.queryByText('Delegated permissions')).toBeNull();
        expect(screen.queryByText('Redirect URIs (Web)')).toBeNull();
    });
});
