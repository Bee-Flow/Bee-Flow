import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithClient } from '@/test/render';
import TeamsRequirementsCard from './TeamsRequirementsCard';

const fetchMock = vi.fn();
const answer = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
    headers: new Headers({ 'content-type': 'application/json' }),
});

const REQUIREMENTS = {
    tenantMode: 'single',
    redirectUris: { signIn: 'https://flow.example/auth/callback/microsoft', connect: 'https://flow.example/api/integrations/microsoft/callback' },
    delegated: [],
    application: [],
};

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});

describe('TeamsRequirementsCard', () => {
    it('says what a member needs in Bee Flow: the plan, Meeting Notes access and no admin role', () => {
        fetchMock.mockResolvedValue(answer(REQUIREMENTS));
        renderWithClient(<TeamsRequirementsCard />);
        expect(screen.getByRole('heading', { name: 'What a member needs' })).toBeTruthy();
        const beeflow = screen.getByTestId('teams-needs-beeflow');
        expect(within(beeflow).getByText('In Bee Flow')).toBeTruthy();
        expect(within(beeflow).getByText(/A plan that includes Meeting Notes\./)).toBeTruthy();
        expect(within(beeflow).getByText(/Every member has it, unless you limited Meeting Notes to certain groups under Admin, Access\./)).toBeTruthy();
        expect(within(beeflow).getByText(/No admin role\./)).toBeTruthy();
    });

    it('says what a member needs in Microsoft 365: account and licence, organiser, recording, OneDrive', () => {
        fetchMock.mockResolvedValue(answer(REQUIREMENTS));
        renderWithClient(<TeamsRequirementsCard />);
        const microsoft = screen.getByTestId('teams-needs-microsoft');
        expect(within(microsoft).getByText('In Microsoft 365')).toBeTruthy();
        expect(within(microsoft).getByText(/A work or school account with a Teams licence\. Personal Microsoft accounts do not work\./)).toBeTruthy();
        expect(within(microsoft).getByText(/only for its organiser, not for the people invited/)).toBeTruthy();
        expect(within(microsoft).getByText(/The meeting was recorded, and the Teams meeting policy lets the member record\./)).toBeTruthy();
        expect(within(microsoft).getByText(/Teams saves the recording in the organiser's OneDrive\./)).toBeTruthy();
    });

    it('says a connection is needed and which licences are not', () => {
        fetchMock.mockResolvedValue(answer(REQUIREMENTS));
        renderWithClient(<TeamsRequirementsCard />);
        expect(screen.getByText(/Either the member connects their own Microsoft 365 account, or the organisation connects for everyone\./)).toBeTruthy();
        expect(screen.getByText(/Not needed: Teams Premium or Microsoft 365 Copilot\./)).toBeTruthy();
    });

    it('ticks the plan once the server answers behind the Meeting Notes licence', async () => {
        fetchMock.mockResolvedValue(answer(REQUIREMENTS));
        renderWithClient(<TeamsRequirementsCard />);
        expect(await screen.findByText('Your organisation has this')).toBeTruthy();
    });

    it('does not claim the plan when the server refuses', async () => {
        fetchMock.mockResolvedValue(answer({ error: 'not licensed' }, 403));
        renderWithClient(<TeamsRequirementsCard />);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
        expect(screen.getByText(/A plan that includes Meeting Notes\./)).toBeTruthy();
        expect(screen.queryByText('Your organisation has this')).toBeNull();
    });
});
