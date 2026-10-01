import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { ValueChip } from './ValueChip';

describe('ValueChip', () => {
    it('names the value, how many it holds and an example; a tap opens how it is used', async () => {
        const onOpen = jest.fn();
        const onRemove = jest.fn();
        await renderWithProviders(<ValueChip label="Product of all orders" count={12} preview="Stoel, Tafel" onOpen={onOpen} onRemove={onRemove} testID="c" />);
        expect(screen.getByText('Product of all orders')).toBeTruthy();
        expect(screen.getByLabelText('12 values')).toBeTruthy();
        expect(screen.getByText('Stoel, Tafel')).toBeTruthy();
        await fireEvent.press(screen.getByRole('button', { name: 'Change how Product of all orders is used' }));
        expect(onOpen).toHaveBeenCalledTimes(1);
        await fireEvent.press(screen.getByRole('button', { name: 'Remove Product of all orders' }));
        expect(onRemove).toHaveBeenCalledTimes(1);
    });

    it('is amber when its source is gone, and offers to pick it again', async () => {
        const onRepick = jest.fn();
        await renderWithProviders(<ValueChip state="stale" label="E-mail of customer" preview="jan@x.nl" onRepick={onRepick} testID="c" />);
        expect(screen.getByText('No longer available: E-mail of customer')).toBeTruthy();
        // An example of a value that is gone would lie.
        expect(screen.queryByText('jan@x.nl')).toBeNull();
        await fireEvent.press(screen.getByText('Pick again'));
        expect(onRepick).toHaveBeenCalledTimes(1);
    });

    it('shows a formula as a grey Formula chip with the formula in words', async () => {
        const onOpen = jest.fn();
        await renderWithProviders(<ValueChip state="formula" label="" summary="upper(‹Orders › Name›)" onOpen={onOpen} onRemove={jest.fn()} testID="c" />);
        expect(screen.getByText('Formula')).toBeTruthy();
        expect(screen.getByText('upper(‹Orders › Name›)')).toBeTruthy();
        await fireEvent.press(screen.getByRole('button', { name: 'Formula: upper(‹Orders › Name›)' }));
        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('button', { name: 'Remove Formula' })).toBeTruthy();
    });

    it('when disabled, is shown but does nothing', async () => {
        const onOpen = jest.fn();
        await renderWithProviders(<ValueChip label="Total" onOpen={onOpen} onRemove={jest.fn()} disabled testID="c" />);
        expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
        await fireEvent.press(screen.getByTestId('c-open'));
        expect(onOpen).not.toHaveBeenCalled();
    });
});
