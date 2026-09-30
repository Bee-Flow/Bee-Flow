/**
 * The bell moved out of the UI kit into this feature; what it announces and
 * shows must not have moved with it. The count arrives through getUnreadCount,
 * mocked here so the test is about the rendering, not the network.
 */

import { screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { NotificationBell } from './NotificationBell';
import { getUnreadCount } from '../api/endpoints';

jest.mock('../api/endpoints', () => ({
    ...jest.requireActual('../api/endpoints'),
    getUnreadCount: jest.fn(),
}));

const unread = getUnreadCount as jest.MockedFunction<typeof getUnreadCount>;

jest.setTimeout(30_000);

describe('NotificationBell', () => {
    it('announces and badges the unread count', async () => {
        unread.mockResolvedValue(3);
        await renderWithProviders(<NotificationBell />);
        await waitFor(() => expect(screen.getByLabelText('Notifications, 3 unread')).toBeTruthy());
        expect(screen.getByText('3')).toBeTruthy();
    });

    it('caps the badge at 99+', async () => {
        unread.mockResolvedValue(250);
        await renderWithProviders(<NotificationBell />);
        await waitFor(() => expect(screen.getByText('99+')).toBeTruthy());
    });

    it('shows a plain bell with no badge when nothing is unread', async () => {
        unread.mockResolvedValue(0);
        await renderWithProviders(<NotificationBell />);
        await waitFor(() => expect(unread).toHaveBeenCalled());
        expect(screen.getByLabelText('Notifications')).toBeTruthy();
        expect(screen.queryByText('0')).toBeNull();
    });
});
