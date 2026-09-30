/**
 * The password sheet on useForm: the two mistakes it names while you type,
 * the button that stays off until the three fields agree, and a refusal that
 * stays in the sheet instead of closing it.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { ApiError } from '@/core/api/client';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { PasswordSheet } from './PasswordSheet';

jest.setTimeout(30_000);

const mockMutateAsync = jest.fn();
jest.mock('../hooks/mutations', () => ({
    useChangePassword: () => ({ mutateAsync: mockMutateAsync }),
}));

async function draw() {
    const onClose = jest.fn();
    await renderWithProviders(
        <ToastProvider>
            <PasswordSheet visible onClose={onClose} />
        </ToastProvider>,
    );
    return { onClose };
}

async function type(label: string, text: string) {
    await fireEvent.changeText(screen.getByLabelText(label), text);
}

const submitButton = () => screen.getByRole('button', { name: 'Update password' });

beforeEach(() => mockMutateAsync.mockReset());

it('names a short password and a repeat that differs, and keeps the button off', async () => {
    await draw();
    await type('Current password', 'old secret');
    await type('New password', 'short');
    expect(screen.getByText('Too short — eight characters minimum.')).toBeTruthy();
    await type('Confirm new password', 'shorter');
    expect(screen.getByText('These do not match.')).toBeTruthy();

    await fireEvent.press(submitButton());
    expect(mockMutateAsync).not.toHaveBeenCalled();
});

it('changes the password, says so and closes', async () => {
    mockMutateAsync.mockResolvedValueOnce(undefined);
    const { onClose } = await draw();
    await type('Current password', 'old secret');
    await type('New password', 'long enough');
    await type('Confirm new password', 'long enough');

    await fireEvent.press(submitButton());
    expect(mockMutateAsync).toHaveBeenCalledWith({ current: 'old secret', next: 'long enough' });
    expect(await screen.findByText('Password changed successfully.')).toBeTruthy();
    expect(onClose).toHaveBeenCalled();
});

it('keeps a refusal in the sheet', async () => {
    mockMutateAsync.mockRejectedValueOnce(new ApiError('Current password is wrong', { status: 400 }));
    const { onClose } = await draw();
    await type('Current password', 'wrong');
    await type('New password', 'long enough');
    await type('Confirm new password', 'long enough');

    await fireEvent.press(submitButton());
    expect(await screen.findByText('Current password is wrong')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
});
