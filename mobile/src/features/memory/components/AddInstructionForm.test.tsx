/**
 * A standing instruction that could not be saved is said inline through
 * describeError, never as the client's "HTTP 500" placeholder.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { ApiError, api } from '@/core/api/client';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { AddInstructionForm } from './AddInstructionForm';

jest.setTimeout(60_000);

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

describe('AddInstructionForm', () => {
    it('says a failed save in describeError’s words', async () => {
        (api.post as jest.Mock).mockRejectedValueOnce(new ApiError('HTTP 500', { status: 500 }));
        const onClose = jest.fn();
        await renderScreen(<AddInstructionForm onClose={onClose} />);
        await fireEvent.changeText(screen.getByLabelText('Always remember'), 'Answer in Dutch.');
        await fireEvent.press(screen.getByLabelText('Save'));
        expect(await screen.findByText('This is not something you did. Try again in a moment.')).toBeTruthy();
        expect(screen.queryByText('HTTP 500')).toBeNull();
        expect(onClose).not.toHaveBeenCalled();
    });
});
