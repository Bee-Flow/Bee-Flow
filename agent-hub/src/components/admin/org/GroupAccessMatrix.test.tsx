// The Access matrix and group-scoped betas (Meeting Notes). On cloud the
// subscription decides which betas reach all members, so ordinary beta rows
// are read-only and every group inherits them. A group-scoped beta is the
// exception: "All members" is a real toggle for it, and a group can hold it
// while All members does not.

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GroupAccessMatrix from './GroupAccessMatrix';
import { renderWithClient } from '@/test/render';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('@/utils/helpers', () => ({ API_BASE: '', authFetch: fetchMock }));
vi.mock('@/config/integrationIcons', () => ({ getIntegrationIcon: () => null }));

const respond = (status: number, body: unknown) => ({
    ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body,
});

type Put = { url: string; body: { granted: string[] } };
let puts: Put[];
let everyone: string[];
let extra: Record<string, unknown>;

const CALENDARS = [
    { id: 'google-calendar', kind: 'integration', name: 'Calendar', category: 'Google Workspace' },
    { id: 'ms-calendar', kind: 'integration', name: 'Calendar', category: 'Microsoft 365' },
];

beforeEach(() => {
    puts = [];
    everyone = ['webpages'];
    extra = {};
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
        if ((init.method || 'GET') === 'PUT') {
            puts.push({ url: String(url), body: JSON.parse(String(init.body)) });
            return respond(200, { success: true });
        }
        return respond(200, {
            orgId: 'org1',
            mode: 'cloud',
            betaGoverned: true,
            capabilities: [
                { id: 'meeting_notes', kind: 'beta', name: 'Meeting Notes', category: 'Beta', groupScoped: true },
                { id: 'webpages', kind: 'beta', name: 'Webpages', category: 'Beta', groupScoped: false },
            ],
            ceiling: ['meeting_notes', 'webpages'],
            everyone,
            groups: [{ id: 'finance', name: 'Finance', granted: [] }],
            ...extra,
        });
    });
});

const toggleOf = (name: string) => screen.getByRole('switch', { name });

it('on a group, a group-scoped beta can be granted while an ordinary beta stays inherited', async () => {
    const user = userEvent.setup();
    renderWithClient(<GroupAccessMatrix heading={undefined} subtitle={undefined} />);
    await user.click(await screen.findByRole('button', { name: /Finance/ }));

    expect(toggleOf('Webpages')).toBeDisabled();
    expect(toggleOf('Webpages')).toBeChecked();
    const meeting = toggleOf('Meeting Notes');
    expect(meeting).not.toBeDisabled();
    expect(meeting).not.toBeChecked();

    await user.click(meeting);
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 });
    expect(puts[0].url).toBe('/auth/groups/finance/access');
    expect(puts[0].body.granted).toEqual(['meeting_notes']);
});

it('on All members, the group-scoped beta is a real toggle even when the subscription governs betas', async () => {
    const user = userEvent.setup();
    renderWithClient(<GroupAccessMatrix heading={undefined} subtitle={undefined} />);
    await screen.findByTitle('Meeting Notes');

    expect(toggleOf('Webpages')).toBeDisabled();
    const meeting = toggleOf('Meeting Notes');
    expect(meeting).not.toBeDisabled();

    await user.click(meeting);
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 });
    expect(puts[0].url).toBe('/auth/me/org-access');
    expect(puts[0].body.granted).toEqual(expect.arrayContaining(['webpages', 'meeting_notes']));
});

it('a group inherits the group-scoped beta once All members has it', async () => {
    everyone = ['webpages', 'meeting_notes'];
    const user = userEvent.setup();
    renderWithClient(<GroupAccessMatrix heading={undefined} subtitle={undefined} />);
    await user.click(await screen.findByRole('button', { name: /Finance/ }));

    const meeting = toggleOf('Meeting Notes');
    expect(meeting).toBeChecked();
    expect(meeting).toBeDisabled();
});

// Settings → Organisation → Integrations titles the page itself (h2 plus the
// selected "Integration access" tab), so the matrix there drops its own heading
// rather than repeat it; Access & Permissions keeps the default heading.
it('shows its "Access & Permissions" heading by default', async () => {
    renderWithClient(<GroupAccessMatrix heading={undefined} subtitle={undefined} />);
    expect(await screen.findByRole('heading', { level: 2, name: 'Access & Permissions' })).toBeInTheDocument();
});

it('with hideHeading, drops the heading but keeps the intro line and the save status', async () => {
    const user = userEvent.setup();
    renderWithClient(<GroupAccessMatrix heading={undefined} subtitle="Give an integration to a group." hideHeading />);
    await screen.findByTitle('Meeting Notes');

    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    expect(screen.getByText('Give an integration to a group.')).toBeInTheDocument();

    await user.click(toggleOf('Meeting Notes'));
    expect(await screen.findByText('Saved', {}, { timeout: 2000 })).toBeInTheDocument();
});

it('marks the chosen scope as current and titles the list with it', async () => {
    const user = userEvent.setup();
    renderWithClient(<GroupAccessMatrix heading={undefined} subtitle={undefined} />);
    const all = await screen.findByRole('button', { name: /All members/ });
    expect(all).toHaveAttribute('aria-current', 'true');

    await user.click(screen.getByRole('button', { name: /Finance/ }));
    expect(screen.getByRole('button', { name: /Finance/ })).toHaveAttribute('aria-current', 'true');
    expect(all).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('heading', { level: 3, name: 'Finance' })).toBeInTheDocument();
});

describe('integrations', () => {
    const withCalendars = (more: Record<string, unknown> = {}) => {
        extra = { capabilities: CALENDARS, ceiling: CALENDARS.map(c => c.id), everyone: [], ...more };
    };

    it('come under a sub-heading per provider, so the two Calendar rows are told apart', async () => {
        withCalendars({ serverConfigured: { 'google-calendar': { serverConfigured: true }, 'ms-calendar': { serverConfigured: true } } });
        renderWithClient(<GroupAccessMatrix heading={undefined} subtitle={undefined} />);
        const google = await screen.findByRole('group', { name: 'Google Workspace' });
        const microsoft = screen.getByRole('group', { name: 'Microsoft 365' });
        expect(within(google).getByRole('switch', { name: 'Calendar' })).toBeInTheDocument();
        expect(within(microsoft).getByRole('switch', { name: 'Calendar' })).toBeInTheDocument();
        expect(screen.queryByTestId('access-availability-unknown')).toBeNull();
    });

    it('marks an integration the server cannot serve', async () => {
        withCalendars({ serverConfigured: { 'google-calendar': { serverConfigured: true }, 'ms-calendar': { serverConfigured: false, reason: 'not_configured' } } });
        renderWithClient(<GroupAccessMatrix heading={undefined} subtitle={undefined} />);
        const microsoft = await screen.findByRole('group', { name: 'Microsoft 365' });
        expect(within(microsoft).getByTestId('capability-not-set-up')).toBeInTheDocument();
        expect(within(screen.getByRole('group', { name: 'Google Workspace' })).queryByTestId('capability-not-set-up')).toBeNull();
    });

    it('when availability could not be read, an organisation admin gets the note and no integration toggle (fails closed)', async () => {
        withCalendars();
        renderWithClient(<GroupAccessMatrix heading={undefined} subtitle={undefined} />);
        expect(await screen.findByTestId('access-availability-unknown')).toHaveTextContent('Could not check whether this is available for this organisation');
        for (const toggle of screen.getAllByRole('switch', { name: 'Calendar' })) expect(toggle).toBeDisabled();
    });

    it('when availability could not be read, a platform admin gets the note and keeps the toggles (fails open)', async () => {
        withCalendars();
        renderWithClient(<GroupAccessMatrix heading={undefined} subtitle={undefined} platformAdmin />);
        expect(await screen.findByTestId('access-availability-unknown')).toBeInTheDocument();
        for (const toggle of screen.getAllByRole('switch', { name: 'Calendar' })) expect(toggle).not.toBeDisabled();
    });
});
