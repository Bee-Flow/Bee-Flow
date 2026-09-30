import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { SaveBar } from './SaveBar';

describe('SaveBar', () => {
    it('renders nothing while the form is clean', async () => {
        await renderWithProviders(<SaveBar dirty={false} saving={false} onSave={jest.fn()} onDiscard={jest.fn()} />);
        expect(screen.queryByTestId('save-bar')).toBeNull();
    });

    it('saves and discards while dirty', async () => {
        const onSave = jest.fn();
        const onDiscard = jest.fn();
        await renderWithProviders(<SaveBar dirty saving={false} onSave={onSave} onDiscard={onDiscard} />);
        await fireEvent.press(screen.getByText('Save'));
        await fireEvent.press(screen.getByText('Discard'));
        expect(onSave).toHaveBeenCalled();
        expect(onDiscard).toHaveBeenCalled();
    });

    it('says why Save is off', async () => {
        await renderWithProviders(
            <SaveBar dirty saving={false} onSave={jest.fn()} onDiscard={jest.fn()} blockedReason="Name is required" />,
        );
        expect(screen.getByText('Name is required')).toBeTruthy();
    });
});
