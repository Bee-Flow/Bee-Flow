/**
 * The inbox, rendered against canned rows: grouped by age, a tap that opens
 * the translated route, a result that opens in place (marked read) with its
 * own way on, a link with no native screen that says so, and the All/Unread
 * filter asking the server the right thing.
 */

import { QueryClient } from '@tanstack/react-query';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { NotificationsScreen } from './NotificationsScreen';

jest.setTimeout(30_000);

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
    useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
    Stack: { Screen: () => null },
}));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('../background', () => ({ registerNotificationPolling: jest.fn(async () => true) }));

const TODAY = new Date().toISOString();
const ROWS = [
    {
        id: 'n1',
        task_id: null,
        category: 'ai_task',
        title: 'Invoice chaser finished',
        message: 'Sent 3 reminders',
        link: '/app/studio/automations/a1?view=runs',
        read: false,
        created_at: TODAY,
    },
    {
        id: 'n2',
        task_id: null,
        category: 'info',
        title: 'Time to practise',
        message: '',
        // Web-only: the Learning Center has no screen on the phone. (A data
        // table used to be the example; it now lands on the Studio hub.)
        link: '/app/settings/learning',
        read: true,
        created_at: TODAY,
    },
    {
        id: 'n3',
        task_id: null,
        category: 'heads_up',
        title: 'New user awaiting approval',
        message: 'Anna was created from Nextcloud and needs approval.',
        link: '/app/admin/security/users',
        read: true,
        created_at: TODAY,
    },
];

/** Mutations are kept forever here: a five-minute gc timer would outlive the run. */
const client = () =>
    new QueryClient({
        defaultOptions: {
            queries: { retry: false, gcTime: Infinity },
            mutations: { retry: false, gcTime: Infinity },
        },
    });

const renderInbox = () =>
    renderWithProviders(
        <ToastProvider>
            <NotificationsScreen />
        </ToastProvider>,
        { queryClient: client() },
    );

/** The server's side: a row marked read stays read on the next list. */
let readIds = new Set<string>();

beforeEach(() => {
    jest.clearAllMocks();
    readIds = new Set();
    (api.get as jest.Mock).mockImplementation(async () => ({
        notifications: ROWS.map((row) => (readIds.has(row.id) ? { ...row, read: true } : row)),
    }));
    (api.post as jest.Mock).mockImplementation(async (path: string) => {
        const id = /\/api\/notifications\/([^/]+)\/read$/.exec(path)?.[1];
        if (id) readIds.add(id);
        return { success: true };
    });
});

describe('NotificationsScreen', () => {
    it('groups the rows and counts the unread one', async () => {
        await renderInbox();
        expect(await screen.findByText('Invoice chaser finished')).toBeTruthy();
        expect(screen.getByText('TODAY')).toBeTruthy();
        expect(screen.getByText('1 unread')).toBeTruthy();
    });

    it('says when a link has no screen on the phone', async () => {
        await renderInbox();
        expect(await screen.findByText('Open the Learning Center in Bee Flow on a computer.')).toBeTruthy();
    });

    it('opens the translated route for a row that points somewhere', async () => {
        await renderInbox();
        await fireEvent.press(await screen.findByText('New user awaiting approval'));
        expect(mockPush).toHaveBeenCalledWith('/org/members?status=pending');
    });

    it('opens a result in place and marks it read; its own button goes to the automation', async () => {
        await renderInbox();
        expect(screen.queryByText('Open automation')).toBeNull();
        await fireEvent.press(await screen.findByText('Invoice chaser finished'));
        // "Tap to read the full result" means that: the row opens, the app stays here.
        expect(mockPush).not.toHaveBeenCalled();
        await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/notifications/n1/read'));
        expect(await screen.findByText('All caught up')).toBeTruthy();
        await fireEvent.press(await screen.findByText('Open automation'));
        expect(mockPush).toHaveBeenCalledWith('/automations/a1/runs');
    });

    it('asks the server for unread rows only when filtered', async () => {
        await renderInbox();
        await screen.findByText('Invoice chaser finished');
        await fireEvent.press(screen.getByText('Unread'));
        await waitFor(() =>
            expect(api.get).toHaveBeenCalledWith(
                '/api/notifications',
                expect.objectContaining({ query: { unread: 'true', limit: 50 } }),
            ),
        );
    });
});
