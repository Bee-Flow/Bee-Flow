/**
 * Self-help: the documentation opens its public site, and "What changed
 * recently" opens the release notes this app draws itself — not the same
 * documentation homepage a second time.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { SelfHelpGroup } from './SelfHelpGroup';

const mockPush = jest.fn();
jest.mock('expo-router', () => jest.requireActual('@/shared/testing/screenMocks').expoRouter(() => mockPush));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'opened' })) }));

beforeEach(() => jest.clearAllMocks());

describe('SelfHelpGroup', () => {
    it('opens the documentation in the in-app browser, returning to this screen', async () => {
        await renderWithProviders(<SelfHelpGroup />);
        await fireEvent.press(screen.getByText('Documentation'));
        expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith('https://docs.beeflow.ai/', { createTask: false });
    });

    it('opens the native release notes for what changed recently', async () => {
        await renderWithProviders(<SelfHelpGroup />);
        await fireEvent.press(screen.getByText('What changed recently'));
        expect(mockPush).toHaveBeenCalledWith('/settings/about');
        expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
    });
});
