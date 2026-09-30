import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { ConnectorActions } from './ConnectorActions';
import type { ConnectorState } from '../model/connectorState';

jest.setTimeout(30_000);

const state = (over: Partial<ConnectorState> = {}): ConnectorState =>
    ({ connected: false, needsReauth: false, notConfigured: false, identity: null, ...over }) as ConnectorState;

describe('ConnectorActions', () => {
    it('says where an OAuth account is connected instead of opening a browser that cannot finish', async () => {
        const onConnect = jest.fn();
        await renderWithProviders(<ConnectorActions state={state()} busy={false} label="Google Workspace" connectsHere={false} onConnect={onConnect} onDisconnect={jest.fn()} />);
        expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
        expect(screen.getByTestId('connect-elsewhere').props.children).toMatch(/Connect Google Workspace from Bee Flow on a computer/);
    });

    it('says the same for a reconnect', async () => {
        await renderWithProviders(<ConnectorActions state={state({ connected: true, needsReauth: true })} busy={false} label="Microsoft 365" connectsHere={false} onConnect={jest.fn()} onDisconnect={jest.fn()} />);
        expect(screen.getByTestId('connect-elsewhere').props.children).toMatch(/Reconnect Microsoft 365/);
    });

    it('still disconnects a connected OAuth account from the phone', async () => {
        const onDisconnect = jest.fn();
        await renderWithProviders(<ConnectorActions state={state({ connected: true })} busy={false} label="Google Workspace" connectsHere={false} onConnect={jest.fn()} onDisconnect={onDisconnect} />);
        await fireEvent.press(screen.getByRole('button', { name: 'Disconnect' }));
        expect(onDisconnect).toHaveBeenCalled();
    });

    it('connects a token account here', async () => {
        const onConnect = jest.fn();
        await renderWithProviders(<ConnectorActions state={state()} busy={false} label="GitHub" connectsHere onConnect={onConnect} onDisconnect={jest.fn()} />);
        await fireEvent.press(screen.getByRole('button', { name: 'Connect' }));
        expect(onConnect).toHaveBeenCalled();
    });
});
