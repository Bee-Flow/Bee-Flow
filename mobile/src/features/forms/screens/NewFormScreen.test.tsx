/**
 * "New form" says a refused create inline through describeError — a plan
 * limit reads as one, and the client's "HTTP 402" placeholder never reaches
 * the screen. Nothing is opened until a form exists.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { ApiError, api } from '@/core/api/client';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { NewFormScreen } from './NewFormScreen';

jest.setTimeout(60_000);

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
    useRouter: () => ({ push: jest.fn(), replace: mockReplace, back: jest.fn(), navigate: jest.fn() }),
    Stack: { Screen: () => null },
}));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

describe('NewFormScreen', () => {
    it('says a refused create in describeError’s words', async () => {
        (api.post as jest.Mock).mockRejectedValueOnce(new ApiError('HTTP 402', { status: 402 }));
        await renderScreen(<NewFormScreen />);
        await fireEvent.changeText(screen.getByTestId('new-form-name'), 'Feedback');
        await fireEvent.press(screen.getByTestId('new-form-create'));
        expect(await screen.findByText('Your organisation has used its allowance for this period.')).toBeTruthy();
        expect(screen.queryByText('HTTP 402')).toBeNull();
        expect(mockReplace).not.toHaveBeenCalled();
    });
});
