/**
 * The keyboard's Next on a new task's name moves on to the prompt and keeps
 * the keyboard up, instead of closing it one field into the form.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';
import { TextInput } from 'react-native';

import { renderScreen } from '@/shared/testing/renderWithProviders';

import { TaskSheet } from './TaskSheet';

jest.setTimeout(60_000);

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

/** The mocked TextInput shares one `focus` across instances; `this` says which field. */
const focus = (TextInput as unknown as { prototype: { focus: jest.Mock } }).prototype.focus;
const focusedFields = () => focus.mock.contexts.map((field) => (field as { props: { accessibilityLabel?: string } }).props.accessibilityLabel);

describe('TaskSheet', () => {
    it('moves from the name to the prompt on Next', async () => {
        focus.mockClear();
        await renderScreen(<TaskSheet visible onClose={jest.fn()} />);
        const name = screen.getByLabelText('Name');
        expect(name.props.submitBehavior).toBe('submit');
        await fireEvent(name, 'submitEditing');
        expect(focusedFields()).toEqual(['What should it do?']);
    });
});
