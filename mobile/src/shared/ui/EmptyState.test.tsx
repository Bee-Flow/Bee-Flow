import { fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { EmptyState } from './EmptyState';
import { Illustration } from './illustrations';

jest.setTimeout(30_000);

describe('EmptyState', () => {
    it('says what happened and offers the one action as a button', async () => {
        const onAction = jest.fn();
        await renderWithProviders(
            <EmptyState title="No agents yet" message="Create one to start." actionLabel="Create agent" onAction={onAction} />,
        );
        expect(screen.getByText('No agents yet')).toBeTruthy();
        expect(screen.getByText('Create one to start.')).toBeTruthy();
        await fireEvent.press(screen.getByRole('button', { name: 'Create agent' }));
        expect(onAction).toHaveBeenCalledTimes(1);
    });

    it('renders no button without a handler — a label alone is not an action', async () => {
        await renderWithProviders(<EmptyState title="Nothing" actionLabel="Do it" />);
        expect(screen.queryByRole('button')).toBeNull();
    });

    it('renders nothing for an unknown scene rather than throwing', async () => {
        // @ts-expect-error — an unknown name, as a stored value could carry
        await render(<Illustration name="nope" color="#000" accent="#f00" />);
        expect(screen.toJSON()).toBeNull();
    });
});
