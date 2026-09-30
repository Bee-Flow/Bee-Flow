import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { AppStudioSoonScreen } from './AppStudioSoonScreen';

const mockOpenRoute = jest.fn();
jest.mock('@/shared/navigation', () => ({ openRoute: (...args: unknown[]) => mockOpenRoute(...args) }));

jest.setTimeout(30_000);

describe('AppStudioSoonScreen', () => {
    beforeEach(() => mockOpenRoute.mockClear());

    it('says App Studio is coming soon and opens the apps directory', async () => {
        await renderWithProviders(<AppStudioSoonScreen />);
        expect(screen.getByText('App Studio is coming soon')).toBeTruthy();
        await fireEvent.press(screen.getByRole('button', { name: 'Open your apps' }));
        expect(mockOpenRoute).toHaveBeenCalledWith(expect.anything(), '/apps');
    });

    it('offers to run the app a link pointed at', async () => {
        await renderWithProviders(<AppStudioSoonScreen appId="app 1" />);
        await fireEvent.press(screen.getByRole('button', { name: 'Open this app' }));
        expect(mockOpenRoute).toHaveBeenCalledWith(expect.anything(), '/apps/app%201?draft=1');
    });
});
