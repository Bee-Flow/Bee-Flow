import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTIFICATION_EVENTS } from '../../api/queries/notificationPrefs';
import { makeFakeApi, reply } from '../../components/projects/workspace/workspaceTestApi';
import { withQueryClient } from '../../test/queryWrapper';
import NotificationsSection from './NotificationsSection';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    API_BASE: '',
    authFetch: fetchMock,
}));

const prefs = () => ({
    bell: Object.fromEntries(NOTIFICATION_EVENTS.map((e) => [e, true])),
    email: Object.fromEntries(NOTIFICATION_EVENTS.map((e) => [e, e !== 'removed'])),
});

function serve(put: unknown = (call: { body: { bell?: object; email?: object } }) => {
    const base = prefs();
    return { bell: { ...base.bell, ...call.body.bell }, email: { ...base.email, ...call.body.email } };
}) {
    const api = makeFakeApi({
        'GET /api/me/notification-prefs': prefs(),
        'PUT /api/me/notification-prefs': put,
    });
    fetchMock.mockImplementation(api.fetchImpl);
    return api;
}

beforeEach(() => { fetchMock.mockReset(); });

describe('NotificationsSection', () => {
    it('shows the eight events with a bell and an e-mail switch each', async () => {
        serve();
        render(withQueryClient(<NotificationsSection />));
        expect(await screen.findByTestId('notification-row-chat_mention')).toBeInTheDocument();
        for (const event of NOTIFICATION_EVENTS) expect(screen.getByTestId(`notification-row-${event}`)).toBeInTheDocument();
        expect(screen.getAllByRole('checkbox')).toHaveLength(16);
        expect(screen.getByRole('checkbox', { name: 'Removed from a project: E-mail' })).not.toBeChecked();
        expect(screen.getByRole('checkbox', { name: 'Removed from a project: Bell' })).toBeChecked();
    });

    it('PUTs only the switch that moved', async () => {
        const api = serve();
        const user = userEvent.setup();
        render(withQueryClient(<NotificationsSection />));
        await user.click(await screen.findByRole('checkbox', { name: 'Removed from a project: E-mail' }));
        await waitFor(() => expect(api.callsTo('PUT', '/api/me/notification-prefs')).toHaveLength(1));
        expect(api.callsTo('PUT', '/api/me/notification-prefs')[0].body).toEqual({ email: { removed: true } });
        expect(await screen.findByText(/Saved/)).toBeInTheDocument();
    });

    it('puts the switch back and says so when the server refuses', async () => {
        serve(reply(500, { error: 'boom' }));
        const user = userEvent.setup();
        render(withQueryClient(<NotificationsSection />));
        const box = await screen.findByRole('checkbox', { name: 'Mentioned in a team chat: Bell' });
        await user.click(box);
        expect(await screen.findByTestId('notification-prefs-save-error')).toBeInTheDocument();
        await waitFor(() => expect(box).toBeChecked());
    });
});
