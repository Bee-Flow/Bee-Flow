/**
 * A lapsed routine credential names its provider as the product it is and
 * leads to the phone's own Integrations screen. It used to print the slug
 * ("Reconnect google from Settings → Connections on the web app").
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { renderScreen } from '@/shared/testing/renderWithProviders';

import { NotificationRowBody } from './NotificationRowBody';
import { presentationFor, type AppNotification } from '../model/types';

const mockPush = jest.fn();
jest.mock('expo-router', () => jest.requireActual('@/shared/testing/screenMocks').expoRouter(() => mockPush));

const notification = (message: string): AppNotification => ({
    id: 'n1',
    task_id: null,
    category: 'urgent',
    title: 'Reconnect Google',
    message,
    link: null,
    read: false,
    created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
});

const render = (message: string) =>
    renderScreen(<NotificationRowBody notification={notification(message)} expanded={false} presentation={presentationFor('urgent')} />);

beforeEach(() => mockPush.mockClear());

describe('NotificationRowBody', () => {
    it('names the connector and opens the phone’s Integrations screen', async () => {
        await render('routine_reauth:google\n\nYour Google access has expired or been revoked.');
        expect(screen.getByText('Connect Google Workspace again to restart this routine.')).toBeTruthy();
        expect(screen.queryByText(/\bgoogle\b/)).toBeNull();
        expect(screen.queryByText(/routine_?reauth/)).toBeNull();
        await fireEvent.press(screen.getByTestId('notification-reauth'));
        expect(mockPush).toHaveBeenCalledWith('/integrations');
    });

    it('humanises a provider that is not one of the phone’s connectors', async () => {
        await render('routine_reauth:nextcloud\n\nYour Nextcloud access has expired or been revoked.');
        expect(screen.getByText('Connect Nextcloud again to restart this routine.')).toBeTruthy();
    });

    it('says nothing about reconnecting on an ordinary notification', async () => {
        await render('Your export is ready.');
        expect(screen.queryByTestId('notification-reauth')).toBeNull();
        expect(screen.getByText('5m ago')).toBeTruthy();
    });
});
