import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { PickOptionsSheet, type PickOptionsSheetProps } from './PickOptionsSheet';

const SAMPLE = { steps: { s1: { output: { lines: [{ product: 'Stoel', n: 2, prijs: '€40' }, { product: 'Tafel', n: 1, prijs: '€99' }], total: 7 } } } };
const LINES = { root: 'steps' as const, id: 's1', path: ['lines'] };

const open = (props: Partial<PickOptionsSheetProps> & Pick<PickOptionsSheetProps, 'onSelect'>) =>
    renderWithProviders(<PickOptionsSheet visible onClose={jest.fn()} source={LINES} sample={SAMPLE} label="Orderregels" testID="o" {...props} />);

describe('PickOptionsSheet', () => {
    it('offers what fits a list in a text field, each with what the field would get', async () => {
        await open({ slot: { as: 'text', multiLine: true }, onSelect: jest.fn() });
        expect(screen.getByText('How should Orderregels be used?')).toBeTruthy();
        const ids = ['all_lines', 'all_comma', 'all_bullets', 'first', 'last', 'count'];
        for (const id of ids) expect(screen.getByTestId(`o-${id}`)).toBeTruthy();
        // A table reads one row per line: never JSON, never [object Object].
        expect(screen.getByTestId('o-all_lines').props.accessibilityHint).toBe('Stoel · 2 · €40\nTafel · 1 · €99');
        expect(screen.getByTestId('o-all_bullets').props.accessibilityHint).toBe('- Stoel · 2 · €40\n- Tafel · 1 · €99');
        expect(screen.getByTestId('o-count').props.accessibilityHint).toBe('2');
        expect(screen.queryByText(/object Object|\{"/)).toBeNull();
        // The default is the first choice.
        expect(screen.getByTestId('o-all_lines').props.accessibilityState).toMatchObject({ selected: true });
    });

    it('marks the current choice and hands back the one tapped', async () => {
        const onSelect = jest.fn();
        const onClose = jest.fn();
        await open({ slot: { as: 'number', multiLine: false }, value: { take: 'first', as: 'number' }, onSelect, onClose });
        expect(screen.queryByTestId('o-all')).toBeNull();
        expect(screen.getByTestId('o-first').props.accessibilityState).toMatchObject({ selected: true });
        await fireEvent.press(screen.getByTestId('o-last'));
        expect(onSelect).toHaveBeenCalledWith({ take: 'last', as: 'number' });
        expect(onClose).toHaveBeenCalled();
    });

    it('offers one value as it is, and says when there is no example yet', async () => {
        await open({ source: { root: 'steps', id: 's1', path: ['nothing'] }, sample: null, onSelect: jest.fn() });
        expect(screen.getByTestId('o-one')).toBeTruthy();
        expect(screen.getByTestId('o-one').props.accessibilityHint).toBe('No example yet');
    });

    it('keeps the formula under Advanced', async () => {
        const onFormula = jest.fn();
        await open({ onSelect: jest.fn(), onFormula });
        expect(screen.queryByText('Write a formula instead')).toBeNull();
        await fireEvent.press(screen.getByText('Advanced'));
        await fireEvent.press(screen.getByText('Write a formula instead'));
        expect(onFormula).toHaveBeenCalledTimes(1);
    });
});
