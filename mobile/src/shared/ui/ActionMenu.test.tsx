import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { ActionMenu } from './ActionMenu';

jest.setTimeout(30_000);

describe('ActionMenu', () => {
    it('closes first, then runs the chosen action', async () => {
        const calls: string[] = [];
        await renderWithProviders(
            <ActionMenu
                visible
                title="Handbook"
                onClose={() => calls.push('close')}
                items={[
                    { label: 'Rename', icon: 'Pencil', onPress: () => calls.push('rename') },
                    { label: 'Delete', icon: 'Trash2', destructive: true, onPress: () => calls.push('delete') },
                ]}
            />,
        );
        expect(screen.getByText('Handbook')).toBeTruthy();
        await fireEvent.press(screen.getByRole('menuitem', { name: 'Delete' }));
        expect(calls).toEqual(['close', 'delete']);
    });

    it('offers a disabled action without running it', async () => {
        const onPress = jest.fn();
        const onClose = jest.fn();
        await renderWithProviders(
            <ActionMenu visible onClose={onClose} items={[{ label: 'Export', disabled: true, onPress }]} />,
        );
        const row = screen.getByRole('menuitem', { name: 'Export' });
        expect(row.props.accessibilityState).toMatchObject({ disabled: true });
        await fireEvent.press(row);
        expect(onPress).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    it('cancels without choosing anything', async () => {
        const onPress = jest.fn();
        const onClose = jest.fn();
        await renderWithProviders(<ActionMenu visible onClose={onClose} items={[{ label: 'Share', onPress }]} />);
        await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onPress).not.toHaveBeenCalled();
    });

    it('marks the current choice in a picking menu', async () => {
        await renderWithProviders(
            <ActionMenu
                visible
                onClose={jest.fn()}
                items={[
                    { label: 'Newest', selected: true, onPress: jest.fn() },
                    { label: 'Oldest', onPress: jest.fn() },
                ]}
            />,
        );
        expect(screen.getByRole('menuitem', { name: 'Newest' }).props.accessibilityState).toMatchObject({ selected: true });
    });
});
