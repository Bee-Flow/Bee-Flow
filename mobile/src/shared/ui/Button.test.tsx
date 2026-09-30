import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { Badge } from './Badge';
import { Button, buttonHitSlop, buttonRadius } from './Button';
import { Chip } from './Chip';
import { FilterPills } from './FilterPills';

jest.setTimeout(30_000);

describe('buttonHitSlop', () => {
    it('tops every size up to the 48dp touch target', () => {
        expect(buttonHitSlop('sm', 48)).toMatchObject({ top: 6, bottom: 6 });
        expect(buttonHitSlop('md', 48)).toMatchObject({ top: 2, bottom: 2 });
        expect(buttonHitSlop('lg', 48)).toMatchObject({ top: 0, bottom: 0 });
    });
});

describe('buttonRadius', () => {
    it('rounds sm like the web’s rounded-md, three quarters of md and lg, at any roundness', () => {
        expect(buttonRadius('sm', 8)).toBe(6);
        expect(buttonRadius('md', 8)).toBe(8);
        expect(buttonRadius('lg', 8)).toBe(8);
        expect(buttonRadius('sm', 12)).toBe(9);
    });
});

describe('Button', () => {
    it('presses, and refuses while disabled or busy', async () => {
        const onPress = jest.fn();
        await renderWithProviders(<Button label="Save" onPress={onPress} variant="success" iconName="Check" />);
        await fireEvent.press(screen.getByRole('button', { name: 'Save' }));
        expect(onPress).toHaveBeenCalledTimes(1);

        await renderWithProviders(<Button label="Delete" onPress={onPress} variant="danger" disabled />);
        await fireEvent.press(screen.getByRole('button', { name: 'Delete' }));
        await renderWithProviders(<Button label="Send" onPress={onPress} loading pill />);
        const busy = screen.getByRole('button', { name: 'Send' });
        expect(busy.props.accessibilityState).toMatchObject({ busy: true, disabled: true });
        await fireEvent.press(busy);
        expect(onPress).toHaveBeenCalledTimes(1);
    });
});

describe('Badge and Chip', () => {
    it('draws a status chip with its word', async () => {
        await renderWithProviders(<Badge label="Frozen data" tone="pinned" icon="Pin" />);
        expect(screen.getByText('Frozen data')).toBeTruthy();
    });

    it('says a chip count, and draws none for a filter nobody counted', async () => {
        await renderWithProviders(<Chip label="Failing" tone="error" count={1} selected onPress={jest.fn()} />);
        expect(screen.getByRole('button', { name: 'Failing, 1' }).props.accessibilityState).toMatchObject({
            selected: true,
        });
        await renderWithProviders(<Chip label="All" count={null} onPress={jest.fn()} />);
        expect(screen.getByRole('button', { name: 'All' })).toBeTruthy();
    });

    it('FilterPills is one single choice', async () => {
        const onChange = jest.fn();
        await renderWithProviders(
            <FilterPills
                value="all"
                onChange={onChange}
                options={[
                    { value: 'all', label: 'All', count: 15 },
                    { value: 'failing', label: 'Failing', count: 1, tone: 'error' },
                ]}
            />,
        );
        await fireEvent.press(screen.getByRole('button', { name: 'Failing, 1' }));
        expect(onChange).toHaveBeenCalledWith('failing');
        expect(screen.getByRole('button', { name: 'All, 15' }).props.accessibilityState).toMatchObject({ selected: true });
    });
});
