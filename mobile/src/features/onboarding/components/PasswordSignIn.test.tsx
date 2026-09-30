/**
 * The keyboard's own keys on the sign-in form: Next on the name moves to the
 * password and keeps the keyboard up; Go on the password signs in.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';
import { TextInput } from 'react-native';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { PasswordSignIn } from './PasswordSignIn';

const mockAuth = { signIn: jest.fn(async () => undefined), clearError: jest.fn(), busy: false, error: null };
jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: () => mockAuth }));

/** The mocked TextInput shares one `focus` across instances; `this` says which field. */
const focus = (TextInput as unknown as { prototype: { focus: jest.Mock } }).prototype.focus;
const focusedFields = () => focus.mock.contexts.map((field) => (field as { props: { accessibilityLabel?: string } }).props.accessibilityLabel);

beforeEach(() => {
    focus.mockClear();
    mockAuth.signIn.mockClear();
});

describe('PasswordSignIn', () => {
    it('moves from the name to the password on Next, without signing in', async () => {
        await renderWithProviders(<PasswordSignIn value={{ username: 'tom', password: '' }} onChange={jest.fn()} onForgot={jest.fn()} />);
        const name = screen.getByLabelText('Email or username');
        expect(name.props.returnKeyType).toBe('next');
        // 'submit' keeps the keyboard up on the way to the next field.
        expect(name.props.submitBehavior).toBe('submit');
        await fireEvent(name, 'submitEditing');
        expect(focusedFields()).toEqual(['Password']);
        expect(mockAuth.signIn).not.toHaveBeenCalled();
    });

    it('signs in on the password’s Go', async () => {
        await renderWithProviders(<PasswordSignIn value={{ username: ' tom ', password: 'secret' }} onChange={jest.fn()} onForgot={jest.fn()} />);
        await fireEvent(screen.getByLabelText('Password'), 'submitEditing');
        expect(mockAuth.signIn).toHaveBeenCalledWith('tom', 'secret');
    });
});
