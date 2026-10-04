// The Access matrix and group-scoped betas (Meeting Notes). On cloud the
// subscription decides which betas reach all members, so ordinary beta rows
// are read-only and every group inherits them. A group-scoped beta is the
// exception: "All members" is a real toggle for it, and a group can hold it
// while All members does not.

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import GroupAccessMatrix from './GroupAccessMatrix';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../../utils/helpers', () => ({ API_BASE: '', authFetch: fetchMock }));
vi.mock('../../../config/integrationIcons', () => ({ getIntegrationIcon: () => null }));

const respond = (status: number, body: unknown) => ({
    ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body,
});

type Put = { url: string; body: { granted: string[] } };
let puts: Put[];
let everyone: string[];

beforeEach(() => {
    puts = [];
    everyone = ['webpages'];
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
        });
    });
});

const toggleOf = (name: string) => {
    const card = screen.getByTitle(name).closest('.rounded-xl') as HTMLElement;
    return within(card).getByRole('checkbox');
};

it('on a group, a group-scoped beta can be granted while an ordinary beta stays inherited', async () => {
    const user = userEvent.setup();
    render(<GroupAccessMatrix heading={undefined} subtitle={undefined} />);
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
    render(<GroupAccessMatrix heading={undefined} subtitle={undefined} />);
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
    render(<GroupAccessMatrix heading={undefined} subtitle={undefined} />);
    await user.click(await screen.findByRole('button', { name: /Finance/ }));

    const meeting = toggleOf('Meeting Notes');
    expect(meeting).toBeChecked();
    expect(meeting).toBeDisabled();
});
