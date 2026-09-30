/**
 * FormSheet wires a form's four submit props to the docked button and shows a
 * failed submit inline, in describeError's words.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import { ApiError } from '@/core/api/client';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { FormSheet, type FormSheetProps } from './FormSheet';

jest.setTimeout(30_000);

async function draw(props: Partial<FormSheetProps> = {}) {
    const onSubmit = jest.fn();
    const onClose = jest.fn();
    await renderWithProviders(
        <FormSheet visible title="Rename" submitLabel="Save" onSubmit={onSubmit} onClose={onClose} {...props}>
            <Text>the fields</Text>
        </FormSheet>,
    );
    return { onSubmit, onClose };
}

describe('FormSheet', () => {
    it('renders the title, the fields and a submit that submits', async () => {
        const { onSubmit } = await draw();
        expect(screen.getByText('Rename')).toBeTruthy();
        expect(screen.getByText('the fields')).toBeTruthy();
        await fireEvent.press(screen.getByText('Save'));
        expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('disables submit when the form cannot submit', async () => {
        const { onSubmit } = await draw({ canSubmit: false });
        await fireEvent.press(screen.getByText('Save'));
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it('shows the submit error inline, as a sentence', async () => {
        await draw({ error: new ApiError('Name already taken', { status: 404 }) });
        expect(screen.getByText('Name already taken')).toBeTruthy();
    });

    it('offers a cancel that closes, only when asked for', async () => {
        const { onClose } = await draw({ cancelLabel: 'Not now' });
        await fireEvent.press(screen.getByText('Not now'));
        expect(onClose).toHaveBeenCalled();
    });
});
