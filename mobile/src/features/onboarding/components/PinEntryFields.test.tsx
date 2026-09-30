/**
 * The keyboard's own keys on the PIN form: setting a PIN, Next moves to the
 * confirmation and keeps the keyboard up, and Go there submits; unlocking,
 * Go on the one field submits.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';
import { TextInput } from 'react-native';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { PinEntryFields } from './PinEntryFields';

/** The mocked TextInput shares one `focus` across instances; `this` says which field. */
const focus = (TextInput as unknown as { prototype: { focus: jest.Mock } }).prototype.focus;
const focusedFields = () => focus.mock.contexts.map((field) => (field as { props: { accessibilityLabel?: string } }).props.accessibilityLabel);

beforeEach(() => focus.mockClear());

async function draw(setupMode: boolean, onSubmit = jest.fn()) {
    await renderWithProviders(
        <PinEntryFields
            setupMode={setupMode}
            fields={{ pin: '123456', confirmPin: '123456', recoveryInput: '', newPin: '', confirmNewPin: '' }}
            set={jest.fn()}
            error={null}
            busy={false}
            onSubmit={onSubmit}
            onForgot={jest.fn()}
        />,
    );
    return onSubmit;
}

describe('PinEntryFields', () => {
    it('moves from the PIN to its confirmation on Next, and submits from there', async () => {
        const onSubmit = await draw(true);
        const pin = screen.getByLabelText('Choose an encryption PIN');
        expect(pin.props.submitBehavior).toBe('submit');
        await fireEvent(pin, 'submitEditing');
        expect(focusedFields()).toEqual(['Confirm PIN']);
        expect(onSubmit).not.toHaveBeenCalled();

        await fireEvent(screen.getByLabelText('Confirm PIN'), 'submitEditing');
        expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('unlocks on the one field’s Go', async () => {
        const onSubmit = await draw(false);
        await fireEvent(screen.getByLabelText('Encryption PIN'), 'submitEditing');
        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(focus).not.toHaveBeenCalled();
    });
});
