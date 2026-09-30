/**
 * A server-minted address, opened from a project: its native screen, the web
 * page only where the web draws it on a phone, and otherwise a toast — never
 * a Custom Tab that costs a sign-in and then bounces to the chat.
 */

import { act, renderHook, screen } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import React, { type ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ThemeProvider } from '@/core/theme/ThemeProvider';
import { TEST_METRICS } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { useOpenLink } from './useOpenLink';

const mockRouter = { push: jest.fn(), navigate: jest.fn(), dismissTo: jest.fn(), canDismiss: () => false };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'opened' })) }));
jest.mock('@/core/api/server', () => ({ ...jest.requireActual('@/core/api/server'), getServerUrl: () => 'https://ai.acme.example' }));

const wrapper = ({ children }: { children: ReactNode }) => (
    <SafeAreaProvider initialMetrics={TEST_METRICS}>
        <ThemeProvider>
            <ToastProvider>{children}</ToastProvider>
        </ThemeProvider>
    </SafeAreaProvider>
);

async function open(path: string) {
    const { result } = await renderHook(() => useOpenLink(), { wrapper });
    await act(async () => result.current(path));
}

beforeEach(() => jest.clearAllMocks());

describe('useOpenLink', () => {
    it('opens a native screen', async () => {
        await open('/app/studio/datatables/d1');
        expect(mockRouter.push).toHaveBeenCalledWith('/datatables/d1');
        expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
    });

    it('opens the nearest native screen for an address the table can only approximate', async () => {
        // The Studio hub is a tab root: switched to, never stacked.
        await open('/app/studio/rota/r1');
        expect(mockRouter.navigate).toHaveBeenCalledWith('/studio');
        expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
    });

    it('opens an agent chat link in the app, not in a browser tab that is not signed in', async () => {
        // A short id the phone cannot resolve: the nearest list, the Agents screen.
        await open('/app/a/abc123');
        expect(mockRouter.push).toHaveBeenCalledWith('/agents');
        expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
    });

    it('says where an address opens when neither side can show it on a phone', async () => {
        await open('/app/billing');
        expect(mockRouter.push).not.toHaveBeenCalled();
        expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
        expect(await screen.findByText('This isn’t on the phone. Open it in Bee Flow on a computer.')).toBeTruthy();
    });
});
